"""Zakładka „Pliki” — foldery i pliki jak na dysku Google. Na razie tylko superadmin.

Cienka warstwa: logika w services/pliki.py, bucket w services/pliki_storage.py.
Pliki z karty kontenera wgrywa routers/containers.py (POST /containers/{id}/attachments) —
trafiają tutaj do folderu kontenera z ptaszkiem „pokaż na kontenerze”.
"""

import asyncio
import io
import os
import tempfile
import zipfile
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.background import BackgroundTask

import audit
from audit_opisy import etykieta_kontenera, plural
from config import settings
from database import get_db
from models import CurrentUser
from security import (ALL_SHOPS, allowed_shops, can_edit_files, can_view_files, get_current_user, has_perm,
                      is_super_admin, require_pliki, require_pliki_edycja, require_pliki_super, resolve_shop)
from services import pliki as svc
from services import pliki_storage

router = APIRouter(prefix="/api", tags=["pliki"])

F = settings.TABLE_PLIKI_FOLDERY
P = settings.TABLE_PLIKI


class FolderIn(BaseModel):
    nazwa: str = Field(..., min_length=1, max_length=200)
    parent_id: Optional[int] = None


class FolderPatch(BaseModel):
    nazwa: Optional[str] = Field(None, min_length=1, max_length=200)
    parent_id: Optional[int] = None          # przeniesienie tylko, gdy pole jest w żądaniu (null = poziom główny)


class PlikPatch(BaseModel):
    nazwa: Optional[str] = Field(None, min_length=1, max_length=200)
    folder_id: Optional[int] = None          # j.w.
    pokaz_na_kontenerze: Optional[bool] = None
    caly_kontener: Optional[bool] = None     # pokazuj u wszystkich producentów kontenera


class Zaznaczenie(BaseModel):
    pliki: List[int] = []
    foldery: List[int] = []


# ── Pomocnicze ───────────────────────────────────────────────────────────────

def _firma(shop: str, user: CurrentUser) -> str:
    """Firma z przełącznika u góry: "" = wszystkie, inaczej slug z ALL_SHOPS (resolve_shop pilnuje zakresu)."""
    s = resolve_shop(shop, user)
    return s if s in ALL_SHOPS else ""


async def _zabronione(db: AsyncSession, user: CurrentUser) -> set:
    """Foldery niedostępne dla usera z zakresem firm (np. tylko Veluxa): producenci i kontenery
    bez towaru ŻADNEJ z jego firm, z całą zawartością. To blokada po stronie serwera — działa
    też dla linków i id wpisanych ręcznie, nie tylko dla listy. Bez zakresu → pusty zbiór."""
    scope = [x for x in (allowed_shops(user) or []) if x in ALL_SHOPS]
    if is_super_admin(user) or not scope or set(ALL_SHOPS) <= set(scope):
        return set()
    wynik: Optional[set] = None
    for firma in scope:
        u = await svc.ukryte_foldery(db, firma)
        wynik = u if wynik is None else (wynik & u)
    return wynik or set()


async def _dostep(db: AsyncSession, fid: Optional[int], user: CurrentUser, zab: Optional[set] = None) -> None:
    """404 (nie 403 — nie zdradzamy, że folder istnieje) dla folderu spoza firm usera."""
    if fid is None:
        return
    if fid in (zab if zab is not None else await _zabronione(db, user)):
        raise HTTPException(404, "Nie ma takiego folderu")


async def _dostep_plik(db: AsyncSession, p: dict, user: CurrentUser, zab: Optional[set] = None) -> None:
    """Jak _dostep, ale plik „cały kontener” przepuszczamy, gdy user widzi ten kontener
    u któregokolwiek producenta (np. Veluxa i rozliczenie wrzucone w folderze producenta AMH)."""
    zab = zab if zab is not None else await _zabronione(db, user)
    if p["folder_id"] is None or p["folder_id"] not in zab:
        return
    if p.get("caly_kontener") and p["container_id"] in await svc.kontenery_widoczne(db, zab):
        return
    raise HTTPException(404, "Nie ma takiego pliku")


async def _czy_folder_kontenera(db: AsyncSession, fid: Optional[int]) -> bool:
    """„Cały kontener” ma sens tylko bezpośrednio w folderze kontenera (podfoldery są osobne)."""
    if fid is None:
        return False
    r = (await db.execute(text(f"SELECT rodzaj, container_id FROM {F} WHERE id = :id"), {"id": fid})).first()
    return bool(r and r.rodzaj == "kontener" and r.container_id is not None)


async def _folder(db: AsyncSession, fid: int, *, zywy: bool = True) -> dict:
    r = (await db.execute(text(f"SELECT id, parent_id, nazwa, rodzaj, manufacturer_id, container_id, usuniety_at FROM {F} WHERE id = :id"),
                          {"id": fid})).mappings().first()
    if not r:
        raise HTTPException(404, "Nie ma takiego folderu")
    if zywy and fid in await _martwe(db):
        raise HTTPException(404, "Ten folder jest w koszu")
    return dict(r)


async def _martwe(db: AsyncSession) -> set:
    return {row[0] for row in await db.execute(text(f"WITH {svc.MARTWE_CTE} SELECT id FROM martwe"))}


async def _plik(db: AsyncSession, pid: int) -> dict:
    r = (await db.execute(text(f"SELECT {svc.PLIK_KOLUMNY}, sciezka, usuniety_at FROM {P} WHERE id = :id"),
                          {"id": pid})).mappings().first()
    if not r:
        raise HTTPException(404, "Nie ma takiego pliku")
    return dict(r)


async def _cel(db: AsyncSession, fid: Optional[int]) -> Optional[int]:
    """Folder docelowy (None = poziom główny) — musi istnieć i nie być w koszu."""
    if fid is not None:
        await _folder(db, fid)
    return fid


async def _dubel_folderu(db: AsyncSession, parent_id: Optional[int], nazwa: str, bez_id: Optional[int] = None) -> None:
    gdzie = "parent_id = :p" if parent_id is not None else "parent_id IS NULL"
    jest = (await db.execute(text(f"""
        SELECT 1 FROM {F} WHERE {gdzie} AND LOWER(nazwa) = LOWER(:n) AND usuniety_at IS NULL
           AND (CAST(:bez AS INTEGER) IS NULL OR id <> :bez) LIMIT 1
    """), {"p": parent_id, "n": nazwa, "bez": bez_id})).first()
    if jest:
        raise HTTPException(409, f"W tym miejscu jest już folder „{nazwa}”")


def _storage_wlaczony() -> None:
    if not pliki_storage.enabled():
        raise HTTPException(503, "Przechowywanie plików nie jest jeszcze skonfigurowane (Supabase Storage)")


async def _czytaj(f: UploadFile) -> bytes:
    data = await f.read(svc.MAX_PLIK_BYTES + 1)
    if not data:
        raise HTTPException(400, f"Pusty plik: {f.filename or ''}")
    if len(data) > svc.MAX_PLIK_BYTES:
        raise HTTPException(413, f"Plik „{f.filename}” jest za duży (max {svc.MAX_PLIK_BYTES // (1024 * 1024)} MB)")
    return data


async def zapisz_plik(db: AsyncSession, *, data: bytes, nazwa: str, content_type: Optional[str],
                      folder_id: Optional[int], pokaz: bool, z_kontenera: bool, kto: str,
                      caly: bool = False) -> dict:
    """Bucket, potem wiersz w bazie. Gdy baza odmówi — plik znika z bucketu (bez sierot).
    Commit robi wołający. Wspólne dla zakładki i karty kontenera."""
    nazwa = svc.czysta_nazwa(nazwa)
    sciezka = svc.nowa_sciezka(nazwa)
    ctype = content_type or "application/octet-stream"
    try:
        await pliki_storage.upload(sciezka, data, ctype)
    except pliki_storage.StorageError as e:
        raise HTTPException(502, f"Nie udało się zapisać pliku w Supabase: {e}")
    try:
        cid = await svc.kontener_nad_folderem(db, folder_id)
        r = (await db.execute(text(f"""
            INSERT INTO {P} (folder_id, nazwa, sciezka, content_type, rozmiar, container_id,
                             pokaz_na_kontenerze, dodano_z_kontenera, dodal, caly_kontener)
            VALUES (:f, :n, :s, :ct, :r, :c, :pok, :zk, :kto, :caly)
            RETURNING {svc.PLIK_KOLUMNY}
        """), {"f": folder_id, "n": nazwa, "s": sciezka, "ct": ctype, "r": len(data), "c": cid,
               "pok": bool(pokaz and cid is not None), "zk": z_kontenera, "kto": kto,
               "caly": bool(caly and await _czy_folder_kontenera(db, folder_id))})).mappings().first()
    except Exception:
        try:
            await pliki_storage.remove([sciezka])
        except Exception:   # noqa: BLE001 — sprzątanie po błędzie, właściwy błąd idzie wyżej
            pass
        raise
    return svc.plik_out(r)


def _gdzie(folder: Optional[dict]) -> str:
    return f"do folderu „{folder['nazwa']}”" if folder else "na główny poziom"


# ── Przeglądanie ─────────────────────────────────────────────────────────────

@router.get("/pliki/status")
async def status(user: CurrentUser = Depends(require_pliki)):
    return {"storage": pliki_storage.enabled(), "max_mb": svc.MAX_PLIK_BYTES // (1024 * 1024), "kosz_dni": svc.KOSZ_DNI}


@router.get("/pliki/lista")
async def lista(folder_id: Optional[int] = Query(None), shop: str = Query(""), db: AsyncSession = Depends(get_db),
                user: CurrentUser = Depends(require_pliki)):
    await svc.synchronizuj_foldery(db)
    await db.commit()
    await _dostep(db, folder_id, user)
    folder = await _folder(db, folder_id) if folder_id is not None else None
    out = await svc.lista_folderu(db, folder_id, _firma(shop, user))
    out["folder"] = ({**folder, "automatyczny": svc.jest_automatyczny(folder["rodzaj"], folder["manufacturer_id"], folder["container_id"])}
                     if folder else None)
    out["sciezka"] = await svc.sciezka_folderu(db, folder_id)
    return out


@router.get("/pliki/drzewo")
async def drzewo(db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_pliki)):
    zab = await _zabronione(db, user)
    return [f for f in await svc.drzewo(db) if f["id"] not in zab]


@router.get("/pliki/szukaj")
async def szukaj(q: str = Query(..., min_length=2, max_length=100), shop: str = Query(""),
                 db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_pliki)):
    return await svc.szukaj(db, q.strip(), shop=_firma(shop, user))


# ── Foldery ──────────────────────────────────────────────────────────────────

@router.post("/pliki/folder", status_code=201)
async def nowy_folder(body: FolderIn, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_pliki_edycja)):
    nazwa = svc.czysta_nazwa(body.nazwa, "Nowy folder")
    await _dostep(db, body.parent_id, user)
    parent = await _cel(db, body.parent_id)
    await _dubel_folderu(db, parent, nazwa)
    fid = (await db.execute(text(f"""
        INSERT INTO {F} (parent_id, nazwa, rodzaj, utworzyl) VALUES (:p, :n, 'reczny', :kto) RETURNING id
    """), {"p": parent, "n": nazwa, "kto": user.email})).scalar()
    await db.commit()
    rodzic = await _folder(db, parent) if parent is not None else None
    audit.note(f"założył folder „{nazwa}” " + (f"w „{rodzic['nazwa']}”" if rodzic else "na głównym poziomie"),
               area="Pliki", resource_type="pliki", resource_id=fid)
    return {"id": fid, "nazwa": nazwa}


@router.patch("/pliki/folder/{fid}")
async def zmien_folder(fid: int, body: FolderPatch, db: AsyncSession = Depends(get_db),
                       user: CurrentUser = Depends(require_pliki_edycja)):
    zab = await _zabronione(db, user)
    await _dostep(db, fid, user, zab)
    f = await _folder(db, fid)
    if svc.jest_automatyczny(f["rodzaj"], f["manufacturer_id"], f["container_id"]):
        raise HTTPException(400, "Folderów producentów i kontenerów nie da się zmieniać — zakłada je i nazywa aplikacja")
    zmiany = []
    if body.nazwa is not None:
        nazwa = svc.czysta_nazwa(body.nazwa, f["nazwa"])
        if nazwa != f["nazwa"]:
            await _dubel_folderu(db, f["parent_id"], nazwa, fid)
            await db.execute(text(f"UPDATE {F} SET nazwa = :n WHERE id = :id"), {"n": nazwa, "id": fid})
            zmiany.append({"pole": "Nazwa", "bylo": f["nazwa"], "jest": nazwa})
            f["nazwa"] = nazwa
    if "parent_id" in body.model_fields_set and body.parent_id != f["parent_id"]:
        await _dostep(db, body.parent_id, user, zab)
        cel = await _cel(db, body.parent_id)
        if await svc.czy_potomek(db, cel, fid):
            raise HTTPException(400, "Nie można przenieść folderu do niego samego ani do jego podfolderu")
        await _dubel_folderu(db, cel, f["nazwa"], fid)
        await db.execute(text(f"UPDATE {F} SET parent_id = :p WHERE id = :id"), {"p": cel, "id": fid})
        await svc.przelicz_kontenery_plikow(db)
        stary = await _folder(db, f["parent_id"], zywy=False) if f["parent_id"] else None
        nowy = await _folder(db, cel) if cel is not None else None
        zmiany.append({"pole": "Miejsce", "bylo": stary["nazwa"] if stary else "główny poziom",
                       "jest": nowy["nazwa"] if nowy else "główny poziom"})
    await db.commit()
    audit.note_zmiany(f"folderu „{f['nazwa']}”", zmiany, area="Pliki", resource_type="pliki", resource_id=fid)
    return {"ok": True}


@router.delete("/pliki/folder/{fid}", status_code=204)
async def folder_do_kosza(fid: int, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_pliki_edycja)):
    await _dostep(db, fid, user)
    f = await _folder(db, fid)
    if svc.jest_automatyczny(f["rodzaj"], f["manufacturer_id"], f["container_id"]):
        raise HTTPException(400, "Folderów producentów i kontenerów nie da się usunąć")
    await db.execute(text(f"UPDATE {F} SET usuniety_at = CURRENT_TIMESTAMP, usunal = :kto WHERE id = :id"),
                     {"id": fid, "kto": user.email})
    await db.commit()
    audit.note(f"przeniósł folder „{f['nazwa']}” do kosza", area="Pliki", resource_type="pliki", resource_id=fid)


# ── Pliki ────────────────────────────────────────────────────────────────────

@router.post("/pliki/wgraj", status_code=201)
async def wgraj(files: List[UploadFile] = File(...), folder_id: Optional[int] = Form(None),
                pokaz_na_kontenerze: bool = Form(False), caly_kontener: bool = Form(False),
                db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_pliki_edycja)):
    _storage_wlaczony()
    await _dostep(db, folder_id, user)
    folder = await _folder(db, folder_id) if folder_id is not None else None
    dane = [(f, await _czytaj(f)) for f in files]        # najpierw limity, żeby nie wgrać połowy
    out = []
    for f, data in dane:
        out.append(await zapisz_plik(db, data=data, nazwa=f.filename or "plik", content_type=f.content_type,
                                     folder_id=folder_id, pokaz=pokaz_na_kontenerze, z_kontenera=False, kto=user.email,
                                     caly=caly_kontener))
        await db.commit()
    nazwy = ", ".join(f"„{p['nazwa']}”" for p in out[:3]) + (f" i {len(out) - 3} innych" if len(out) > 3 else "")
    audit.note(f"wgrał {len(out)} {plural(len(out), 'plik', 'pliki', 'plików')} {_gdzie(folder)}: {nazwy}",
               area="Pliki", resource_type="pliki", resource_id=folder_id)
    return out


@router.patch("/pliki/plik/{pid}")
async def zmien_plik(pid: int, body: PlikPatch, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_pliki_edycja)):
    p = await _plik(db, pid)
    zab = await _zabronione(db, user)
    await _dostep_plik(db, p, user, zab)
    if p["usuniety_at"] is not None:
        raise HTTPException(404, "Ten plik jest w koszu")
    zmiany = []
    if body.nazwa is not None:
        nazwa = svc.czysta_nazwa(body.nazwa, p["nazwa"])
        if nazwa != p["nazwa"]:
            await db.execute(text(f"UPDATE {P} SET nazwa = :n WHERE id = :id"), {"n": nazwa, "id": pid})
            zmiany.append({"pole": "Nazwa", "bylo": p["nazwa"], "jest": nazwa})
    if "folder_id" in body.model_fields_set and body.folder_id != p["folder_id"]:
        await _dostep(db, body.folder_id, user, zab)
        cel = await _cel(db, body.folder_id)
        cid = await svc.kontener_nad_folderem(db, cel)
        # Przeniesienie zdejmuje „cały kontener” — w nowym miejscu to zwykły plik (można włączyć znowu).
        await db.execute(text(f"""
            UPDATE {P} SET folder_id = :f, container_id = :c, caly_kontener = FALSE,
                           pokaz_na_kontenerze = (pokaz_na_kontenerze AND CAST(:c AS INTEGER) IS NOT NULL)
             WHERE id = :id
        """), {"f": cel, "c": cid, "id": pid})
        if p["caly_kontener"]:
            zmiany.append({"pole": "Cały kontener", "bylo": "tak", "jest": "nie"})
        p["caly_kontener"] = False
        p["folder_id"] = cel
        stary = await _folder(db, p["folder_id"], zywy=False) if p["folder_id"] else None
        nowy = await _folder(db, cel) if cel is not None else None
        zmiany.append({"pole": "Miejsce", "bylo": stary["nazwa"] if stary else "główny poziom",
                       "jest": nowy["nazwa"] if nowy else "główny poziom"})
        p["container_id"] = cid
    if body.pokaz_na_kontenerze is not None and body.pokaz_na_kontenerze != p["pokaz_na_kontenerze"]:
        if body.pokaz_na_kontenerze and p["container_id"] is None:
            raise HTTPException(400, "Plik nie leży w folderze kontenera — nie ma na czym go pokazać")
        await db.execute(text(f"UPDATE {P} SET pokaz_na_kontenerze = :v WHERE id = :id"),
                         {"v": body.pokaz_na_kontenerze, "id": pid})
        zmiany.append({"pole": "Pokaż na kontenerze", "bylo": "tak" if p["pokaz_na_kontenerze"] else "nie",
                       "jest": "tak" if body.pokaz_na_kontenerze else "nie"})
    if body.caly_kontener is not None and body.caly_kontener != p["caly_kontener"]:
        if body.caly_kontener and not await _czy_folder_kontenera(db, p["folder_id"]):
            raise HTTPException(400, "„Cały kontener” działa tylko dla pliku leżącego bezpośrednio w folderze kontenera")
        await db.execute(text(f"UPDATE {P} SET caly_kontener = :v WHERE id = :id"), {"v": body.caly_kontener, "id": pid})
        zmiany.append({"pole": "Cały kontener", "bylo": "tak" if p["caly_kontener"] else "nie",
                       "jest": "tak" if body.caly_kontener else "nie"})
    await db.commit()
    audit.note_zmiany(f"pliku „{p['nazwa']}”", zmiany, area="Pliki", resource_type="pliki", resource_id=pid)
    r = (await db.execute(text(f"SELECT {svc.PLIK_KOLUMNY} FROM {P} WHERE id = :id"), {"id": pid})).mappings().first()
    return svc.plik_out(r)


@router.delete("/pliki/plik/{pid}", status_code=204)
async def plik_do_kosza(pid: int, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_pliki_edycja)):
    p = await _plik(db, pid)
    await _dostep_plik(db, p, user)
    await db.execute(text(f"UPDATE {P} SET usuniety_at = CURRENT_TIMESTAMP, usunal = :kto WHERE id = :id AND usuniety_at IS NULL"),
                     {"id": pid, "kto": user.email})
    await db.commit()
    audit.note(f"przeniósł plik „{p['nazwa']}” do kosza", area="Pliki", resource_type="pliki", resource_id=pid)


async def _plik_do_pobrania(db: AsyncSession, pid: int, user: CurrentUser) -> dict:
    """Kto co pobierze:
      · superadmin — wszystko, także z kosza (żeby zajrzeć przed przywróceniem),
      · „Pliki – podgląd” — żywe pliki ze swoich firm; z „edycją” także te w koszu,
      · reszta — tylko pliki pokazane na karcie kontenera, z uprawnieniem do załączników."""
    p = await _plik(db, pid)
    if not is_super_admin(user) and can_view_files(user):
        martwy = p["usuniety_at"] is not None or (p["folder_id"] is not None and p["folder_id"] in await _martwe(db))
        if not martwy or can_edit_files(user):
            try:
                await _dostep_plik(db, p, user)
                return p
            except HTTPException:
                pass
    if not is_super_admin(user):
        widoczny = (p["pokaz_na_kontenerze"] and p["usuniety_at"] is None and p["container_id"] is not None
                    and (p["folder_id"] is None or p["folder_id"] not in await _martwe(db)))
        if not (widoczny and has_perm(user, "viewAttachments")):
            raise HTTPException(404, "Nie ma takiego pliku")
    return p


@router.get("/pliki/plik/{pid}/link")
async def link(pid: int, pobierz: bool = Query(True), db: AsyncSession = Depends(get_db),
               user: CurrentUser = Depends(get_current_user)):
    """Link na 5 minut prosto do Supabase (te same uprawnienia co /pobierz). pobierz=false → podgląd."""
    p = await _plik_do_pobrania(db, pid, user)
    try:
        return {"url": await pliki_storage.signed_url(p["sciezka"], pobierz_jako=p["nazwa"] if pobierz else None)}
    except pliki_storage.StorageError as e:
        raise HTTPException(502, f"Nie udało się przygotować linku do pliku: {e}")


@router.get("/pliki/plik/{pid}/pobierz")
async def pobierz(pid: int, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(get_current_user)):
    """Plik przez backend (karta kontenera — tam małe załączniki). Uprawnienia jak w /link."""
    p = await _plik_do_pobrania(db, pid, user)
    try:
        data = await pliki_storage.download(p["sciezka"])
    except pliki_storage.StorageError as e:
        raise HTTPException(502, f"Nie udało się pobrać pliku z Supabase: {e}")
    from routers.containers import _content_disposition
    return StreamingResponse(io.BytesIO(data), media_type=p["content_type"] or "application/octet-stream",
                             headers={"Content-Disposition": _content_disposition(p["nazwa"])})


class ZipIn(Zaznaczenie):
    shop: str = ""


@router.post("/pliki/zip")
async def zip_zaznaczonych(body: ZipIn, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_pliki)):
    """Zaznaczone pliki i foldery (z podfolderami) w jednym ZIP-ie. Pliki z Supabase ściągamy
    po kilka naraz i piszemy do pliku tymczasowego — duży ZIP nie trzyma się w pamięci."""
    lista = await svc.pliki_do_zip(db, pliki=body.pliki, foldery=body.foldery, shop=_firma(body.shop, user))
    if not lista:
        raise HTTPException(404, "W zaznaczonych folderach nie ma plików")
    razem = sum(x["rozmiar"] for x in lista)
    if razem > svc.ZIP_MAX_BYTES:
        raise HTTPException(413, f"Za dużo naraz ({svc.ludzki_rozmiar(razem)}) — zaznacz mniej folderów (max 1 GB)")
    fd, tmp = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
            for i in range(0, len(lista), 4):
                paczka = lista[i:i + 4]
                dane = await asyncio.gather(*(pliki_storage.download(x["sciezka"]) for x in paczka))
                for x, d in zip(paczka, dane):
                    z.writestr(x["zip"], d)
    except pliki_storage.StorageError as e:
        os.remove(tmp)
        raise HTTPException(502, f"Nie udało się pobrać plików z Supabase: {e}")
    return FileResponse(tmp, media_type="application/zip", filename="pliki.zip",
                        background=BackgroundTask(os.remove, tmp))


# ── Kosz ─────────────────────────────────────────────────────────────────────

@router.get("/pliki/kosz")
async def kosz(db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_pliki_edycja)):
    k = await svc.kosz(db)
    zab = await _zabronione(db, user)
    if zab:
        k["foldery"] = [f for f in k["foldery"] if f["id"] not in zab and f["parent_id"] not in zab]
        k["pliki"] = [p for p in k["pliki"] if p["folder_id"] not in zab]
    return k


@router.post("/pliki/kosz/przywroc")
async def przywroc(body: Zaznaczenie, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_pliki_edycja)):
    """Przywraca na stare miejsce. Gdy stary folder sam jest w koszu (albo pod folderem w koszu),
    rzecz wraca na główny poziom — inaczej „przywrócona” byłaby dalej niewidoczna."""
    zab = await _zabronione(db, user)
    if zab:
        body.foldery = [f for f in body.foldery if f not in zab]
        body.pliki = [r[0] for r in await db.execute(text(f"""
            SELECT id FROM {P} WHERE id = ANY(:ids) AND (folder_id IS NULL OR folder_id <> ALL(:zab))
        """), {"ids": body.pliki, "zab": list(zab)})] if body.pliki else []
    na_glowny = 0
    if body.foldery:
        await db.execute(text(f"UPDATE {F} SET usuniety_at = NULL, usunal = NULL WHERE id = ANY(:ids)"), {"ids": body.foldery})
    if body.pliki:
        await db.execute(text(f"UPDATE {P} SET usuniety_at = NULL, usunal = NULL WHERE id = ANY(:ids)"), {"ids": body.pliki})
    martwe = await _martwe(db)
    for fid in body.foldery:
        parent = (await db.execute(text(f"SELECT parent_id FROM {F} WHERE id = :id"), {"id": fid})).scalar()
        if parent is not None and parent in martwe:
            await db.execute(text(f"UPDATE {F} SET parent_id = NULL WHERE id = :id"), {"id": fid})
            na_glowny += 1
    if na_glowny:
        martwe = await _martwe(db)
    for pid in body.pliki:
        folder = (await db.execute(text(f"SELECT folder_id FROM {P} WHERE id = :id"), {"id": pid})).scalar()
        if folder is not None and folder in martwe:
            await db.execute(text(f"UPDATE {P} SET folder_id = NULL, caly_kontener = FALSE WHERE id = :id"), {"id": pid})
            na_glowny += 1
    if na_glowny:
        await svc.przelicz_kontenery_plikow(db)
    await db.commit()
    n = len(body.pliki) + len(body.foldery)
    audit.note(f"przywrócił z kosza {n} {plural(n, 'pozycję', 'pozycje', 'pozycji')}",
               area="Pliki", resource_type="pliki")
    return {"przywrocone": n, "na_glowny_poziom": na_glowny}


@router.post("/pliki/kosz/usun")
async def usun_z_kosza(body: Zaznaczenie, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_pliki_super)):
    """Na zawsze — tylko to, co faktycznie leży w koszu (nie da się tak skasować żywego pliku)."""
    pliki = [r[0] for r in await db.execute(text(f"SELECT id FROM {P} WHERE id = ANY(:ids) AND usuniety_at IS NOT NULL"),
                                            {"ids": body.pliki})] if body.pliki else []
    foldery = [r[0] for r in await db.execute(text(f"SELECT id FROM {F} WHERE id = ANY(:ids) AND usuniety_at IS NOT NULL"),
                                              {"ids": body.foldery})] if body.foldery else []
    try:
        n = await svc.usun_na_zawsze(db, pliki=pliki, foldery=foldery)
    except pliki_storage.StorageError as e:
        raise HTTPException(502, f"Supabase nie skasował plików, nic nie zostało usunięte: {e}")
    await db.commit()
    audit.note(f"usunął z kosza na zawsze {n} {plural(n, 'plik', 'pliki', 'plików')}"
               + (f" i {len(foldery)} {plural(len(foldery), 'folder', 'foldery', 'folderów')}" if foldery else ""),
               area="Pliki", resource_type="pliki")
    return {"usuniete_pliki": n}


@router.delete("/pliki/kosz")
async def oproznij_kosz(db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_pliki_super)):
    pliki = [r[0] for r in await db.execute(text(f"SELECT id FROM {P} WHERE usuniety_at IS NOT NULL"))]
    foldery = [r[0] for r in await db.execute(text(f"SELECT id FROM {F} WHERE usuniety_at IS NOT NULL"))]
    try:
        n = await svc.usun_na_zawsze(db, pliki=pliki, foldery=foldery)
    except pliki_storage.StorageError as e:
        raise HTTPException(502, f"Supabase nie skasował plików, nic nie zostało usunięte: {e}")
    await db.commit()
    audit.note(f"opróżnił kosz plików ({n} {plural(n, 'plik', 'pliki', 'plików')})", area="Pliki", resource_type="pliki")
    return {"usuniete_pliki": n}


# ── Stare załączniki kontenerów (przed przeniesieniem do Plików) ─────────────

@router.get("/pliki/stare-zalaczniki/stan")
async def stare_zalaczniki_stan(db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_pliki_super)):
    """Ile starych załączników kontenerów czeka na przeniesienie do Plików."""
    T = settings.TABLE_ATTACHMENTS
    r = (await db.execute(text(f"""
        SELECT COUNT(*) FILTER (WHERE przeniesiony_plik_id IS NULL AND file_data IS NOT NULL) AS do_przeniesienia,
               COUNT(*) FILTER (WHERE przeniesiony_plik_id IS NOT NULL) AS przeniesione,
               COUNT(*) FILTER (WHERE przeniesiony_plik_id IS NULL AND file_data IS NULL) AS bez_pliku
          FROM {T}
    """))).mappings().first()
    return {k: int(v or 0) for k, v in r.items()}


PRZENOSINY_PACZKA = 15


@router.post("/pliki/stare-zalaczniki/przenies")
async def stare_zalaczniki_przenies(db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_pliki_super)):
    """Kolejna paczka starych załączników → Pliki, do folderu ich kontenera (w skonsolidowanym:
    u pierwszego producenta), z ptaszkiem „pokaż na kontenerze” i datą dodania sprzed lat.
    Ekran woła to w pętli, aż `zostalo` = 0 — jedno długie żądanie mogłoby przekroczyć czas Railwaya.
    Każdy plik zatwierdzany osobno: przerwane przenosiny wystarczy uruchomić jeszcze raz."""
    _storage_wlaczony()
    T = settings.TABLE_ATTACHMENTS
    ids = [row[0] for row in await db.execute(text(f"""
        SELECT id FROM {T} WHERE przeniesiony_plik_id IS NULL AND file_data IS NOT NULL
         ORDER BY container_id, uploaded_at, id LIMIT :n
    """), {"n": PRZENOSINY_PACZKA})]
    przeniesione, bledy = 0, []
    for aid in ids:
        a = (await db.execute(text(f"""
            SELECT id, container_id, filename, content_type, file_data, uploaded_at FROM {T}
             WHERE id = :id AND przeniesiony_plik_id IS NULL
        """), {"id": aid})).mappings().first()
        if not a:
            continue
        try:
            fid = await svc.folder_kontenera(db, a["container_id"], None)
            p = await zapisz_plik(db, data=bytes(a["file_data"]), nazwa=a["filename"], content_type=a["content_type"],
                                  folder_id=fid, pokaz=True, z_kontenera=True, kto="stare załączniki kontenera")
            await db.execute(text(f"UPDATE {P} SET dodano = COALESCE(:d, dodano) WHERE id = :id"),
                             {"d": a["uploaded_at"], "id": p["id"]})
            await db.execute(text(f"""
                UPDATE {T} SET przeniesiony_plik_id = :p, przeniesiono_at = CURRENT_TIMESTAMP WHERE id = :id
            """), {"p": p["id"], "id": aid})
            await db.commit()
            przeniesione += 1
        except Exception as e:   # noqa: BLE001 — jeden zły plik nie zatrzymuje reszty; zostaje do ponowienia
            await db.rollback()
            bledy.append(f"{a['filename']}: {getattr(e, 'detail', None) or e}")
    zostalo = (await db.execute(text(f"""
        SELECT COUNT(*) FROM {T} WHERE przeniesiony_plik_id IS NULL AND file_data IS NOT NULL
    """))).scalar()
    if przeniesione:
        audit.note(f"przeniósł {przeniesione} {plural(przeniesione, 'stary załącznik', 'stare załączniki', 'starych załączników')}"
                   " kontenerów do Plików", area="Pliki", resource_type="pliki")
    else:
        audit.skip()
    # Gdy cała paczka padła, nie ma sensu kręcić pętli w nieskończoność — ekran się zatrzyma.
    return {"przeniesione": przeniesione, "bledy": bledy, "zostalo": int(zostalo or 0),
            "utknelo": bool(ids) and przeniesione == 0}


@router.get("/pliki/stare-zalaczniki.zip")
async def stare_zalaczniki(db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_pliki_super)):
    """Wszystkie dotychczasowe załączniki kontenerów (trzymane w bazie) w jednym ZIP-ie,
    po folderze na kontener — kopia na dysk przed przeniesieniem ich do Plików.
    Pliki czytamy po jednym i piszemy do pliku tymczasowego, żeby nie trzymać wszystkiego w pamięci."""
    T = settings.TABLE_ATTACHMENTS
    wiersze = (await db.execute(text(f"""
        SELECT a.id, a.filename, a.container_id, a.uploaded_at, c.container_number,
               COALESCE(NULLIF(TRIM(c.order_number), ''),
                        (SELECT l.order_number FROM {settings.TABLE_CONTAINER_LOTS} l
                          WHERE l.container_id = c.id AND NULLIF(TRIM(l.order_number), '') IS NOT NULL
                          ORDER BY l.position, l.id LIMIT 1)) AS fv
          FROM {T} a LEFT JOIN {settings.TABLE_CONTAINERS} c ON c.id = a.container_id
         WHERE a.file_data IS NOT NULL
         ORDER BY a.container_id, a.uploaded_at, a.id
    """))).mappings().all()
    if not wiersze:
        raise HTTPException(404, "Brak załączników do pobrania")
    fd, sciezka = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    uzyte: set = set()
    with zipfile.ZipFile(sciezka, "w", zipfile.ZIP_DEFLATED) as z:
        for w in wiersze:
            folder = svc.czysta_nazwa(etykieta_kontenera(w["container_number"], w["fv"], w["container_id"])).replace(":", "")
            nazwa = svc.czysta_nazwa(w["filename"])
            cel, i = f"{folder}/{nazwa}", 1
            while cel.lower() in uzyte:           # dwa pliki o tej samej nazwie w jednym kontenerze
                i += 1
                base, kropka, ext = nazwa.rpartition(".")
                cel = f"{folder}/{base} ({i}).{ext}" if kropka else f"{folder}/{nazwa} ({i})"
            uzyte.add(cel.lower())
            data = (await db.execute(text(f"SELECT file_data FROM {T} WHERE id = :id"), {"id": w["id"]})).scalar()
            z.writestr(cel, bytes(data or b""))
    return FileResponse(sciezka, media_type="application/zip", filename="zalaczniki-kontenerow.zip",
                        background=BackgroundTask(os.remove, sciezka))
