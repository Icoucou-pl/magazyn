"use client";

import React, { useState, useEffect, useMemo } from 'react';
import { ChevronLeft, ChevronRight, ChevronDown, ChevronUp, AlertTriangle, Package, TrendingUp, Calendar as CalendarIcon, Search, Edit2, X, Ship, Plus, Trash2, Factory, CheckCircle2, Settings as SettingsIcon, Building2, Box, Sparkles, LayoutDashboard, Wallet, ExternalLink, AlertOctagon, RefreshCw, Upload, Download, ScanLine, Activity, Paperclip, ShoppingCart, FileText, Star, Wand2, FlaskConical, ArrowUp, ArrowDown, Columns3 } from 'lucide-react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000/api';

const fmtPLN = (n) => new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN', maximumFractionDigits: 0 }).format(n || 0);
const fmtNum = (n) => new Intl.NumberFormat('pl-PL').format(n || 0);
const todayPlus = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };

const STATUS_CONFIG = {
  KRYTYCZNY: { bg: 'bg-red-600', text: 'text-red-50', label: 'KRYTYCZNY' },
  ZAMOW_TERAZ: { bg: 'bg-orange-500', text: 'text-orange-50', label: 'ZAMÓW TERAZ' },
  ZAMOW_WKROTCE: { bg: 'bg-amber-300', text: 'text-amber-900', label: 'ZAMÓW WKRÓTCE' },
  OK: { bg: 'bg-emerald-600', text: 'text-emerald-50', label: 'OK' },
};

const CONTAINER_STATUS_CONFIG = {
  ORDERED: { label: 'Zamówione', bg: 'bg-stone-500', text: 'text-stone-50', icon: Package },
  IN_PRODUCTION: { label: 'W produkcji', bg: 'bg-purple-600', text: 'text-purple-50', icon: Factory },
  IN_TRANSIT: { label: 'W drodze', bg: 'bg-blue-600', text: 'text-blue-50', icon: Ship },
  DELIVERED: { label: 'Dostarczone', bg: 'bg-emerald-600', text: 'text-emerald-50', icon: CheckCircle2 },
};

const CARRIER_TRACKING = {
  MSCU: { name: 'MSC', url: (n) => `https://www.msc.com/track-a-shipment?agencyPath=msc&searchNumber=${n}` },
  MAEU: { name: 'Maersk', url: (n) => `https://www.maersk.com/tracking/${n}` },
  COSU: { name: 'COSCO', url: (n) => `https://elines.coscoshipping.com/ebusiness/cargoTracking?trackingType=CONTAINER&number=${n}` },
  HLBU: { name: 'Hapag-Lloyd', url: (n) => `https://www.hapag-lloyd.com/en/online-business/track/track-by-container.html?container=${n}` },
  CMAU: { name: 'CMA CGM', url: (n) => `https://www.cma-cgm.com/ebusiness/tracking/search?SearchBy=Container&Reference=${n}` },
  EVRU: { name: 'Evergreen', url: (n) => `https://ct.shipmentlink.com/servlet/TDB1_CargoTracking.do?bl_no=${n}` },
};

const getCarrier = (n) => {
  if (!n) return null;
  const prefix = n.substring(0, 4).toUpperCase();
  return CARRIER_TRACKING[prefix] || null;
};

const getToken = () => sessionStorage.getItem('magazyn_token');
const setToken = (t) => sessionStorage.setItem('magazyn_token', t);
const clearToken = () => sessionStorage.removeItem('magazyn_token');

const api = {
  get: async (path) => {
    const r = await fetch(`${API_BASE}${path}`, { headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} });
    if (r.status === 401) { clearToken(); window.location.reload(); throw new Error('Sesja wygasła'); }
    if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
    return r.json();
  },
  post: async (path, body) => {
    const r = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) }, body: JSON.stringify(body) });
    if (r.status === 401) { clearToken(); window.location.reload(); throw new Error('Sesja wygasła'); }
    if (!r.ok) throw new Error(`POST ${path}: ${r.status} - ${await r.text()}`);
    return r.json();
  },
  patch: async (path, body) => {
    const r = await fetch(`${API_BASE}${path}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) }, body: JSON.stringify(body) });
    if (r.status === 401) { clearToken(); window.location.reload(); throw new Error('Sesja wygasła'); }
    if (!r.ok) throw new Error(`PATCH ${path}: ${r.status}`);
    return r.json();
  },
  put: async (path, body) => {
    const r = await fetch(`${API_BASE}${path}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) }, body: JSON.stringify(body) });
    if (r.status === 401) { clearToken(); window.location.reload(); throw new Error('Sesja wygasła'); }
    if (!r.ok) { const txt = await r.text(); throw new Error(`PUT ${path}: ${r.status} - ${txt}`); }
    if (r.status === 204 || r.headers.get('content-length') === '0') return null;
    return r.json();
  },
  del: async (path) => {
    const r = await fetch(`${API_BASE}${path}`, { method: 'DELETE', headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} });
    if (r.status === 401) { clearToken(); window.location.reload(); throw new Error('Sesja wygasła'); }
    if (!r.ok && r.status !== 204) throw new Error(`DELETE ${path}: ${r.status}`);
  },
  download: (path) => { window.open(`${API_BASE}${path}?token=${getToken() || ''}`, '_blank'); },
};

export default function WarehouseApp() {
  const [currentUser, setCurrentUser] = useState(null);  // null = niezalogowany, loading = sprawdzanie
  const [authChecked, setAuthChecked] = useState(false); // czy sprawdziliśmy token

  // Przy starcie sprawdź czy token jest ważny
  useEffect(() => {
    const token = getToken();
    if (!token) { setAuthChecked(true); return; }
    // Sprawdź token przez API
    fetch(`${API_BASE}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(user => { if (user) setCurrentUser(user); else clearToken(); })
      .catch(() => clearToken())
      .finally(() => setAuthChecked(true));
  }, []);

  const handleLogin = (user, token) => {
    setToken(token);
    setCurrentUser(user);
  };

  const handleLogout = () => {
    clearToken();
    setCurrentUser(null);
  };

  // Ładowanie - sprawdzamy token
  if (!authChecked) {
    return (
      <div className="min-h-screen bg-stone-900 flex items-center justify-center">
        <div className="text-center">
          <Package className="w-12 h-12 text-amber-400 mx-auto mb-3 animate-pulse" />
          <p className="text-stone-400">Ładowanie...</p>
        </div>
      </div>
    );
  }

  // Niezalogowany - pokaż ekran logowania
  if (!currentUser) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  // Zalogowany - pokaż aplikację
  return <AppShell currentUser={currentUser} onLogout={handleLogout} />;
}


// ============================================================
// EKRAN LOGOWANIA
// ============================================================
function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) { setError('Wypełnij email i hasło'); return; }
    setLoading(true);
    setError('');
    try {
      const data = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (!data.ok) {
        const err = await data.json();
        throw new Error(err.detail || 'Błąd logowania');
      }
      const result = await data.json();
      onLogin(result.user, result.access_token);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-stone-900 via-stone-800 to-stone-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-amber-500 rounded-2xl mb-4 shadow-lg">
            <Package className="w-8 h-8 text-stone-900" />
          </div>
          <h1 className="text-3xl font-bold text-white tracking-tight">
            MAGAZYN<span className="text-amber-400">.</span>
          </h1>
          <p className="text-stone-400 mt-1 text-sm">System zarządzania magazynem</p>
        </div>

        {/* Formularz */}
        <div className="bg-white rounded-2xl shadow-2xl overflow-hidden">
          <div className="bg-stone-900 px-6 py-4">
            <h2 className="text-white font-bold text-lg">Logowanie</h2>
            <p className="text-stone-400 text-xs mt-0.5">Zaloguj się żeby uzyskać dostęp</p>
          </div>
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
                <span className="text-sm text-red-700">{error}</span>
              </div>
            )}
            <div>
              <label className="block text-xs font-bold text-stone-600 uppercase tracking-wider mb-1">Email</label>
              <input
                type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="twoj@email.com" autoFocus autoComplete="email"
                className="w-full px-4 py-3 border-2 border-stone-200 rounded-lg focus:border-amber-500 focus:outline-none transition text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-stone-600 uppercase tracking-wider mb-1">Hasło</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••" autoComplete="current-password"
                  className="w-full px-4 py-3 border-2 border-stone-200 rounded-lg focus:border-amber-500 focus:outline-none transition text-sm pr-12"
                />
                <button type="button" onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-700 text-xs">
                  {showPassword ? 'Ukryj' : 'Pokaż'}
                </button>
              </div>
            </div>
            <button type="submit" disabled={loading}
              className="w-full py-3 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-stone-900 rounded-lg font-bold transition flex items-center justify-center gap-2">
              {loading ? <><RefreshCw className="w-4 h-4 animate-spin" />Logowanie...</> : 'Zaloguj się'}
            </button>
          </form>
          <div className="px-6 pb-4 text-center text-xs text-stone-400">
            Nie pamiętasz hasła? Poproś administratora o reset.
          </div>
        </div>

        <p className="text-center text-stone-500 text-xs mt-6">
          Dostęp tylko dla uprawnionych użytkowników
        </p>
      </div>
    </div>
  );
}


// ============================================================
// APP SHELL - otacza całą aplikację gdy zalogowany
// ============================================================
function AppShell({ currentUser, onLogout }) {
  const [view, setView] = useState('dashboard');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [products, setProducts] = useState([]);
  const [stats, setStats] = useState(null);
  const [classification, setClassification] = useState(null);
  const [containers, setContainers] = useState([]);
  const [manufacturers, setManufacturers] = useState([]);
  const [containerTypes, setContainerTypes] = useState([]);
  const [calendarEvents, setCalendarEvents] = useState([]);
  const [cashflow, setCashflow] = useState(null);
  const [anomalies, setAnomalies] = useState([]);
  const [shoppingList, setShoppingList] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [editingContainer, setEditingContainer] = useState(null);
  const [showNewContainer, setShowNewContainer] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showEan, setShowEan] = useState(false);
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  const [showAutoSuggest, setShowAutoSuggest] = useState(false);
  const [showSimulator, setShowSimulator] = useState(false);
  const [showOrderPdf, setShowOrderPdf] = useState(null);
  const [showUsersPanel, setShowUsersPanel] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showAuditLog, setShowAuditLog] = useState(false);
  const [stockHistory, setStockHistory] = useState(null);
  const [includeFilter, setIncludeFilter] = useState('ACTIVE,ACTIVE_NO_STOCK');
  const [currentDate, setCurrentDate] = useState(new Date());

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    try {
      // Ładujemy SEKWENCYJNIE żeby nie przeciążać home.pl (limit połączeń)
      setStats(await api.get('/stats'));
      setClassification(await api.get('/classification'));
      setManufacturers(await api.get('/manufacturers'));
      setContainerTypes(await api.get('/container-types'));
      setContainers(await api.get('/containers'));
      // Przy filtrze "FAVORITES" pobieramy wszystkie produkty (może być ulubiony z dead stock itp.)
      const apiInclude = includeFilter === 'FAVORITES' ? 'ACTIVE,ACTIVE_NO_STOCK,DEAD_STOCK,INACTIVE' : includeFilter;
      setProducts(await api.get(`/products?include=${apiInclude}`));
      setCalendarEvents(await api.get('/calendar'));
      setCashflow(await api.get('/cashflow'));
      setAnomalies(await api.get('/anomalies'));
      setShoppingList(await api.get('/shopping-list'));
    } catch (e) {
      setError(e.message); console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const reloadProducts = async () => {
    try {
      const apiInclude = includeFilter === 'FAVORITES' ? 'ACTIVE,ACTIVE_NO_STOCK,DEAD_STOCK,INACTIVE' : includeFilter;
      setProducts(await api.get(`/products?include=${apiInclude}`));
      setAnomalies(await api.get('/anomalies'));
      setShoppingList(await api.get('/shopping-list'));
      setClassification(await api.get('/classification'));
    } catch (e) { console.error(e); }
  };

  const reloadContainers = async () => {
    try {
      const apiInclude = includeFilter === 'FAVORITES' ? 'ACTIVE,ACTIVE_NO_STOCK,DEAD_STOCK,INACTIVE' : includeFilter;
      setContainers(await api.get('/containers'));
      setProducts(await api.get(`/products?include=${apiInclude}`));
      setCalendarEvents(await api.get('/calendar'));
      setCashflow(await api.get('/cashflow'));
      setShoppingList(await api.get('/shopping-list'));
    } catch (e) { console.error(e); }
  };

  useEffect(() => { loadAll(); }, []);
  useEffect(() => { if (!loading) reloadProducts(); }, [includeFilter]);

  // Wykres wartości magazynu - ładuje się w tle, nie blokuje
  useEffect(() => {
    if (!loading) {
      api.get('/stock-value-history?days=90').then(setStockHistory).catch(() => {});
    }
  }, [loading]);

  // Skrót Ctrl+K do globalnej wyszukiwarki
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setShowGlobalSearch(true);
      }
      if (e.key === 'Escape') {
        setShowGlobalSearch(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const filteredProducts = useMemo(() => {
    let result = products;
    // Filtr ulubionych - jeśli aktywny
    if (includeFilter === 'FAVORITES') {
      result = result.filter(p => p.is_favorite);
    }
    // Filtr po wyszukiwaniu (SKU/nazwa)
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(p =>
        p.sku?.toLowerCase().includes(q) ||
        p.name?.toLowerCase().includes(q)
      );
    }
    return result;
  }, [products, searchQuery, includeFilter]);

  if (error) {
    return (
      <div className="min-h-screen bg-red-50 p-10 flex items-center justify-center">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-lg border-2 border-red-300">
          <AlertOctagon className="w-12 h-12 text-red-600 mb-4" />
          <h2 className="text-xl font-bold text-red-900 mb-3">Błąd połączenia z API</h2>
          <p className="text-stone-700 mb-4">{error}</p>
          <button onClick={loadAll} className="w-full py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded-lg">Spróbuj ponownie</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-100">
      <header className="bg-stone-900 text-stone-50 border-b-4 border-amber-500">
        <div className="max-w-[1400px] mx-auto px-6 py-4 flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-3">
            <Package className="w-7 h-7 text-amber-400" />
            <div>
              <h1 className="text-xl font-bold tracking-tight">MAGAZYN<span className="text-amber-400">.</span></h1>
              <p className="text-xs text-stone-400 tracking-wider">v5 ITER 1</p>
            </div>
          </div>
          <div className="flex gap-1 bg-stone-800 rounded-lg p-1 flex-wrap">
            <NavBtn active={view === 'dashboard'} onClick={() => setView('dashboard')} icon={LayoutDashboard}>Dashboard</NavBtn>
            <NavBtn active={view === 'calendar'} onClick={() => setView('calendar')} icon={CalendarIcon}>Kalendarz</NavBtn>
            <NavBtn active={view === 'list'} onClick={() => setView('list')} icon={Package}>Produkty</NavBtn>
            <NavBtn active={view === 'containers'} onClick={() => setView('containers')} icon={Ship} badge={containers.filter(c => c.status !== 'DELIVERED').length}>Kontenery</NavBtn>
            <NavBtn active={view === 'cashflow'} onClick={() => setView('cashflow')} icon={Wallet}>Cashflow</NavBtn>
            <NavBtn active={view === 'settings'} onClick={() => setView('settings')} icon={SettingsIcon}>Ustawienia</NavBtn>
          </div>
          <div className="flex items-center gap-2 relative">
            <button onClick={() => setShowGlobalSearch(true)} 
              className="flex items-center gap-2 px-3 py-2 bg-stone-800 hover:bg-stone-700 rounded-lg text-stone-300 text-sm border border-stone-700 min-w-48"
              title="Globalna wyszukiwarka (Ctrl+K)">
              <Search className="w-4 h-4" />
              <span className="flex-1 text-left">Szukaj wszędzie...</span>
              <kbd className="hidden md:inline-block text-[10px] bg-stone-900 px-1.5 py-0.5 rounded font-mono">Ctrl+K</kbd>
            </button>
            <button onClick={() => setShowEan(true)} className="p-2 hover:bg-stone-800 rounded-lg" title="Wyszukaj po EAN/SKU">
              <ScanLine className="w-5 h-5 text-amber-400" />
            </button>
            <button onClick={loadAll} disabled={loading} className="px-3 py-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-stone-900 rounded-lg font-bold text-sm flex items-center gap-2">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />Odśwież
            </button>
            <UserMenu 
              user={currentUser} 
              onLogout={onLogout}
              onChangePassword={() => setShowChangePassword(true)}
              onUsersPanel={currentUser.role === 'ADMIN' ? () => setShowUsersPanel(true) : null}
              onAuditLog={currentUser.is_super_admin ? () => setShowAuditLog(true) : null}
              isSuperAdmin={currentUser.role === 'ADMIN'}
            />
          </div>
        </div>
      </header>

      <div className="max-w-[1400px] mx-auto px-6 py-6">
        {loading && !stats && (
          <div className="bg-white rounded-xl p-12 text-center border border-stone-200">
            <RefreshCw className="w-8 h-8 animate-spin mx-auto text-amber-500 mb-3" />
            <p className="text-stone-600">Ładowanie z bazy...</p>
          </div>
        )}

        {!loading && view === 'dashboard' && stats && classification && (
          <DashboardView stats={stats} classification={classification} products={products}
            containers={containers} anomalies={anomalies} shoppingList={shoppingList}
            stockHistory={stockHistory}
            canEdit={currentUser.role !== 'VIEWER'}
            onProductClick={setSelectedProduct} onContainerClick={setEditingContainer}
            onShowAutoSuggest={currentUser.role !== 'VIEWER' ? () => setShowAutoSuggest(true) : null}
            onShowSimulator={() => setShowSimulator(true)}
            onShowOrderPdf={currentUser.role !== 'VIEWER' ? (group) => setShowOrderPdf(group) : null}
            onToggleFavorite={async (sku) => {
              try { await api.put(`/products/${encodeURIComponent(sku)}/favorite`); await reloadProducts(); }
              catch (e) { alert(e.message); }
            }} />
        )}

        {!loading && view === 'calendar' && (
          <CalendarView events={calendarEvents} currentDate={currentDate} setCurrentDate={setCurrentDate}
            onProductClick={(sku) => setSelectedProduct(products.find(p => p.sku === sku))}
            onContainerClick={(id) => setEditingContainer(containers.find(c => c.id === id))} />
        )}

        {!loading && view === 'list' && (
          <>
            <div className="mb-4 flex gap-3 items-center flex-wrap">
              <div className="relative flex-1 min-w-64">
                <Search className="w-5 h-5 absolute left-4 top-1/2 -translate-y-1/2 text-stone-400" />
                <input type="text" placeholder="Szukaj symbolu lub nazwy..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-12 pr-4 py-3 bg-white border-2 border-stone-200 rounded-lg focus:border-amber-500 focus:outline-none transition" />
              </div>
              <select value={includeFilter} onChange={(e) => setIncludeFilter(e.target.value)}
                className="px-3 py-3 bg-white border-2 border-stone-200 rounded-lg font-medium">
                <option value="ACTIVE,ACTIVE_NO_STOCK">Aktywne ({(classification?.counts?.ACTIVE || 0) + (classification?.counts?.ACTIVE_NO_STOCK || 0)})</option>
                <option value="FAVORITES">⭐ Ulubione ({products.filter(p => p.is_favorite).length})</option>
                <option value="DEAD_STOCK">Dead stock ({classification?.counts?.DEAD_STOCK || 0})</option>
                <option value="INACTIVE">Nieaktywne ({classification?.counts?.INACTIVE || 0})</option>
                <option value="ACTIVE,ACTIVE_NO_STOCK,DEAD_STOCK,INACTIVE">Wszystkie ({classification?.total || 0})</option>
              </select>
              {currentUser.role !== 'VIEWER' && (
                <button onClick={() => setShowImport(true)} className="px-4 py-3 bg-white border-2 border-stone-200 hover:bg-stone-50 rounded-lg font-bold text-sm flex items-center gap-2">
                  <Upload className="w-4 h-4" />Import
                </button>
              )}
              <button onClick={() => {
                if (includeFilter === 'FAVORITES') {
                  api.download(`/products/export/csv?include=ACTIVE,ACTIVE_NO_STOCK,DEAD_STOCK,INACTIVE&favorites_only=true`);
                } else {
                  api.download(`/products/export/csv?include=${includeFilter}`);
                }
              }} className="px-4 py-3 bg-white border-2 border-stone-200 hover:bg-stone-50 rounded-lg font-bold text-sm flex items-center gap-2">
                <Download className="w-4 h-4" />Eksport XLSX
              </button>
            </div>
            <ListView products={filteredProducts} onProductClick={setSelectedProduct} 
              canEdit={currentUser.role !== 'VIEWER'}
              onToggleFavorite={async (sku) => {
                try { await api.put(`/products/${encodeURIComponent(sku)}/favorite`); await reloadProducts(); }
                catch (e) { alert(e.message); }
              }} />
          </>
        )}

        {!loading && view === 'containers' && (
          <ContainersView containers={containers} containerTypes={containerTypes} manufacturers={manufacturers}
            products={products}
            canEdit={currentUser.role !== 'VIEWER'}
            onNew={currentUser.role !== 'VIEWER' ? () => setShowNewContainer(true) : null}
            onEdit={(c) => { if (currentUser.role !== 'VIEWER') setEditingContainer(c); else setEditingContainer({...c, readOnly: true}); }}
            onAutoSuggest={currentUser.role !== 'VIEWER' ? () => setShowAutoSuggest(true) : null}
            onExport={() => api.download('/containers/export/csv')}
            onUpdateStatus={currentUser.role !== 'VIEWER' ? async (id, status) => { await api.patch(`/containers/${id}`, { status }); await reloadContainers(); } : null} />
        )}

        {!loading && view === 'cashflow' && cashflow && <CashflowView cashflow={cashflow} />}

        {!loading && view === 'settings' && (
          <SettingsView manufacturers={manufacturers} containerTypes={containerTypes}
            canEdit={currentUser.role !== 'VIEWER'}
            onReloadManufacturers={async () => setManufacturers(await api.get('/manufacturers'))}
            onReloadTypes={async () => setContainerTypes(await api.get('/container-types'))} />
        )}
      </div>

      {selectedProduct && (
        <ProductModal product={selectedProduct} manufacturers={manufacturers}
          canEdit={currentUser.role !== 'VIEWER'}
          onClose={() => setSelectedProduct(null)}
          onUpdate={async () => {
            const updated = await api.get(`/products/${encodeURIComponent(selectedProduct.sku)}`);
            setSelectedProduct(updated);
            await reloadProducts();
          }} />
      )}

      {showNewContainer && currentUser.role !== 'VIEWER' && (
        <ContainerForm products={products} manufacturers={manufacturers} containerTypes={containerTypes}
          onSave={async (data) => { await api.post('/containers', data); await reloadContainers(); setShowNewContainer(false); }}
          onClose={() => setShowNewContainer(false)} />
      )}

      {editingContainer && (
        <ContainerForm products={products} manufacturers={manufacturers} containerTypes={containerTypes}
          initial={editingContainer}
          readOnly={editingContainer.readOnly || currentUser.role === 'VIEWER'}
          onSave={currentUser.role !== 'VIEWER' ? async (data) => { await api.patch(`/containers/${editingContainer.id}`, data); await reloadContainers(); setEditingContainer(null); } : null}
          onClose={() => setEditingContainer(null)}
          onDelete={currentUser.role !== 'VIEWER' ? async () => {
            if (window.confirm('Usunąć ten kontener?')) {
              await api.del(`/containers/${editingContainer.id}`);
              await reloadContainers();
              setEditingContainer(null);
            }
          } : null}
          onAddAttachment={currentUser.role !== 'VIEWER' ? async (data) => {
            await api.post(`/containers/${editingContainer.id}/attachments`, data);
            const updated = await api.get(`/containers/${editingContainer.id}`);
            setEditingContainer(updated);
          } : null}
          onDeleteAttachment={currentUser.role !== 'VIEWER' ? async (aid) => {
            await api.del(`/attachments/${aid}`);
            const updated = await api.get(`/containers/${editingContainer.id}`);
            setEditingContainer(updated);
          } : null} />
      )}

      {showImport && <ImportModal onClose={() => setShowImport(false)} onImported={reloadProducts} />}
      {showEan && <EanModal onClose={() => setShowEan(false)} onProductFound={async (sku) => {
        try {
          const p = await api.get(`/products/${encodeURIComponent(sku)}`);
          setSelectedProduct(p); setShowEan(false);
        } catch (e) { alert(e.message); }
      }} />}
      {showGlobalSearch && <GlobalSearchModal 
        onClose={() => setShowGlobalSearch(false)}
        onProductFound={async (sku) => {
          try {
            const p = await api.get(`/products/${encodeURIComponent(sku)}`);
            setSelectedProduct(p); setShowGlobalSearch(false);
          } catch (e) { alert(e.message); }
        }}
        onContainerFound={(id) => {
          const c = containers.find(c => c.id === id);
          if (c) { setEditingContainer(c); setShowGlobalSearch(false); }
        }}
        onManufacturerFound={() => { setView('settings'); setShowGlobalSearch(false); }} />}
      {showAutoSuggest && <AutoSuggestModal 
        manufacturers={manufacturers} containerTypes={containerTypes}
        onClose={() => setShowAutoSuggest(false)}
        onCreate={async (data) => { 
          await api.post('/containers', data); 
          await reloadContainers(); 
          setShowAutoSuggest(false); 
          setView('containers');
        }} />}
      {showSimulator && <SimulatorModal products={products} onClose={() => setShowSimulator(false)} />}
      {showOrderPdf && <OrderPdfModal 
        group={showOrderPdf} 
        onClose={() => setShowOrderPdf(null)} />}
      {showChangePassword && <ChangePasswordModal onClose={() => setShowChangePassword(false)} />}
      {showUsersPanel && <UsersPanelModal onClose={() => setShowUsersPanel(false)} />}
      {showAuditLog && <AuditLogModal onClose={() => setShowAuditLog(false)} />}
    </div>
  );
}

function NavBtn({ active, onClick, icon: Icon, badge, children }) {
  return (
    <button onClick={onClick} className={`px-3 py-2 rounded-md text-sm font-medium transition ${active ? 'bg-amber-500 text-stone-900' : 'text-stone-300 hover:text-white'}`}>
      <Icon className="w-4 h-4 inline mr-1.5" />{children}
      {badge > 0 && <span className="ml-1.5 bg-red-600 text-white text-[10px] px-1.5 py-0.5 rounded-full font-bold">{badge}</span>}
    </button>
  );
}

function KpiCard({ label, value, sub, bg, txt }) {
  return (
    <div className={`${bg} ${txt} rounded-xl p-5 shadow-sm relative overflow-hidden`}>
      <div className="text-3xl font-bold tabular-nums">{value}</div>
      <div className="text-xs font-medium opacity-80 uppercase tracking-wider mt-1">{label}</div>
      {sub && <div className="text-xs mt-1 opacity-70">{sub}</div>}
    </div>
  );
}

function DashboardView({ stats, classification, products, containers, anomalies, shoppingList, stockHistory, onProductClick, onContainerClick, onShowAutoSuggest, onShowSimulator, onShowOrderPdf, onToggleFavorite }) {
  const totalStockValue = products.reduce((s, p) => s + (p.stock_value || 0), 0);
  const inTransitContainers = containers.filter(c => c.status !== 'DELIVERED');
  const inTransitValue = inTransitContainers.reduce((s, c) => s + (c.total_value || 0), 0);
  const realCritical = products
    .filter(p => (p.status === 'KRYTYCZNY' || p.status === 'ZAMOW_TERAZ') && p.avg_monthly_weighted >= 2)
    .sort((a, b) => b.avg_monthly_weighted - a.avg_monthly_weighted).slice(0, 8);
  const upcomingContainers = inTransitContainers.sort((a, b) => new Date(a.eta_date) - new Date(b.eta_date)).slice(0, 5);
  const favorites = products.filter(p => p.is_favorite);

  // Statystyki wykresu wartości
  const valueChange = stockHistory && stockHistory.points.length > 1 
    ? stockHistory.points[stockHistory.points.length - 1].value - stockHistory.points[0].value 
    : 0;
  const valuePctChange = stockHistory && stockHistory.points.length > 1 && stockHistory.points[0].value > 0
    ? (valueChange / stockHistory.points[0].value) * 100
    : 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Wartość magazynu" value={fmtPLN(totalStockValue)} sub={`${stats.products_with_stock} ze stanem`} bg="bg-gradient-to-br from-stone-800 to-stone-900" txt="text-amber-400" />
        <KpiCard label="W drodze" value={fmtPLN(inTransitValue)} sub={`${inTransitContainers.length} kontenerów`} bg="bg-gradient-to-br from-blue-700 to-blue-900" txt="text-blue-100" />
        <KpiCard label="Aktywne SKU" value={classification.counts.ACTIVE + classification.counts.ACTIVE_NO_STOCK} sub={`${classification.counts.ACTIVE_NO_STOCK} bez stanu!`} bg="bg-gradient-to-br from-emerald-700 to-emerald-900" txt="text-emerald-100" />
        <KpiCard label="Dead stock" value={classification.counts.DEAD_STOCK} sub={fmtPLN(classification.dead_stock_value_pln)} bg="bg-gradient-to-br from-stone-600 to-stone-800" txt="text-stone-100" />
      </div>

      {/* Wykres wartości magazynu - styl giełdowy */}
      {stockHistory && stockHistory.points && stockHistory.points.length > 1 && (
        <div className="bg-white rounded-xl border border-stone-200 overflow-hidden">
          <div className="p-5 border-b border-stone-100 flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <TrendingUp className="w-6 h-6 text-emerald-600" />
              <div>
                <h3 className="font-bold text-lg">Wartość magazynu - 90 dni</h3>
                <p className="text-xs text-stone-500">Symulacja na podstawie obecnego stanu i historii sprzedaży</p>
              </div>
            </div>
            <div className="flex items-center gap-6">
              <div className="text-right">
                <div className="text-xs text-stone-500 uppercase font-bold">Dziś</div>
                <div className="text-2xl font-bold tabular-nums">{fmtPLN(stockHistory.points[stockHistory.points.length - 1].value)}</div>
              </div>
              <div className="text-right">
                <div className="text-xs text-stone-500 uppercase font-bold">Zmiana 90d</div>
                <div className={`text-2xl font-bold tabular-nums flex items-center gap-1 ${valueChange >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {valueChange >= 0 ? '↑' : '↓'} {fmtPLN(Math.abs(valueChange))}
                  <span className="text-sm">({valuePctChange >= 0 ? '+' : ''}{valuePctChange.toFixed(1)}%)</span>
                </div>
              </div>
            </div>
          </div>
          <div className="px-2 pb-2" style={{ height: '200px' }}>
            <StockValueChart points={stockHistory.points} positive={valueChange >= 0} />
          </div>
          <div className="px-5 py-2 flex justify-between text-xs text-stone-400 border-t border-stone-100">
            <span>{new Date(stockHistory.points[0].date).toLocaleDateString('pl-PL')}</span>
            <span className="font-mono">{stockHistory.points.length} dni</span>
            <span>{new Date(stockHistory.points[stockHistory.points.length - 1].date).toLocaleDateString('pl-PL')}</span>
          </div>
        </div>
      )}

      {/* Akcje WOW - tylko dla non-VIEWER */}
      {(onShowAutoSuggest || onShowSimulator) && (
        <div className="grid md:grid-cols-2 gap-3">
          {onShowAutoSuggest && (
            <button onClick={onShowAutoSuggest} className="group bg-gradient-to-br from-amber-400 to-amber-600 text-stone-900 rounded-xl p-5 text-left hover:scale-[1.02] transition transform shadow">
              <Wand2 className="w-7 h-7 mb-2" />
              <div className="font-bold text-lg">Auto-sugestia kontenera</div>
              <div className="text-sm opacity-80">Aplikacja zaplanuje optymalny skład</div>
            </button>
          )}
          <button onClick={onShowSimulator} className="group bg-gradient-to-br from-purple-500 to-purple-700 text-white rounded-xl p-5 text-left hover:scale-[1.02] transition transform shadow">
            <FlaskConical className="w-7 h-7 mb-2" />
            <div className="font-bold text-lg">Symulator scenariuszy</div>
            <div className="text-sm opacity-80">Co jeśli sprzedaż +30% albo dostawa +30 dni</div>
          </button>
        </div>
      )}

      {/* Ulubione produkty */}
      {favorites.length > 0 && (
        <div className="bg-white rounded-xl border border-stone-200 overflow-hidden">
          <div className="bg-gradient-to-r from-yellow-500 to-amber-600 text-white px-5 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Star className="w-5 h-5 fill-white" />
              <h3 className="font-bold">Obserwowane produkty ({favorites.length})</h3>
            </div>
          </div>
          <div className="divide-y divide-stone-100 max-h-72 overflow-y-auto">
            {favorites.map(p => (
              <button key={p.sku} onClick={() => onProductClick(p)} className="w-full px-4 py-3 flex items-center justify-between hover:bg-amber-50/50 text-left">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <Star className="w-4 h-4 text-amber-500 fill-amber-500 flex-shrink-0" 
                    onClick={(e) => { e.stopPropagation(); onToggleFavorite(p.sku); }} />
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${STATUS_CONFIG[p.status]?.bg} ${STATUS_CONFIG[p.status]?.text}`}>
                    {STATUS_CONFIG[p.status]?.label}
                  </span>
                  <span className="font-mono font-bold text-sm">{p.sku}</span>
                  <span className="text-sm text-stone-600 truncate">{p.name}</span>
                </div>
                <div className="text-right text-xs whitespace-nowrap ml-2">
                  <div className="font-bold">stan: {p.stock} · {p.avg_monthly_weighted}/mies</div>
                  <div className="text-stone-500">{p.days_until_empty < 9999 ? `koniec za ${p.days_until_empty}d` : '—'}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {anomalies.length > 0 && (
        <div className="bg-white rounded-xl border border-stone-200 overflow-hidden">
          <div className="bg-gradient-to-r from-purple-700 to-purple-900 text-white px-5 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="w-5 h-5" />
              <h3 className="font-bold">🤖 Wykryte anomalie</h3>
              <span className="bg-white/20 px-2 py-0.5 rounded-full text-xs font-bold">{anomalies.length}</span>
            </div>
          </div>
          <div className="divide-y divide-stone-100 max-h-72 overflow-y-auto">
            {anomalies.map((a, i) => {
              const sevColor = a.severity === 'high' ? 'bg-red-600' : a.severity === 'medium' ? 'bg-amber-500' : 'bg-stone-400';
              const product = products.find(p => p.sku === a.sku);
              return (
                <button key={i} onClick={() => product && onProductClick(product)} className="w-full px-5 py-3 flex items-center gap-3 hover:bg-stone-50 text-left">
                  <div className={`w-2 h-2 rounded-full ${sevColor}`}></div>
                  <span className="font-mono font-bold text-sm">{a.sku}</span>
                  <span className="text-sm text-stone-600 truncate flex-1">{a.message}</span>
                  <span className="text-xs text-stone-400 capitalize">{a.type.replace('_', ' ')}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {shoppingList.length > 0 && (
        <div className="bg-white rounded-xl border border-stone-200 overflow-hidden">
          <div className="bg-stone-900 text-white px-5 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShoppingCart className="w-5 h-5 text-amber-400" />
              <h3 className="font-bold">Lista zakupów (per producent)</h3>
              <span className="text-xs text-stone-400 ml-2">💡 zamówić razem = oszczędność na frachcie</span>
            </div>
            {onShowAutoSuggest && (
              <button onClick={onShowAutoSuggest} className="text-xs px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-stone-900 rounded-lg font-bold flex items-center gap-1">
                <Wand2 className="w-3 h-3" />Auto-sugestia kontenera
              </button>
            )}
          </div>
          <div className="divide-y divide-stone-100 max-h-96 overflow-y-auto">
            {shoppingList.map((g, idx) => (
              <div key={idx} className="p-4 hover:bg-stone-50">
                <div className="flex justify-between items-center mb-2 flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    {g.manufacturer_name ? (
                      <span className="px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wider text-white" style={{ backgroundColor: g.manufacturer_color || '#6b7280' }}>{g.manufacturer_name}</span>
                    ) : <span className="text-stone-400 text-xs">brak producenta</span>}
                    <span className="text-sm text-stone-600">{g.total_skus} produktów wymaga zamówienia</span>
                  </div>
                  {g.manufacturer_id && onShowOrderPdf && (
                    <button onClick={() => onShowOrderPdf(g)} className="text-xs px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-stone-900 rounded-lg font-bold flex items-center gap-1">
                      <FileText className="w-3 h-3" />Generuj PO
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-1">
                  {g.products.map((p, i) => {
                    const prod = products.find(pp => pp.sku === p.sku);
                    return (
                      <button key={i} onClick={() => prod && onProductClick(prod)} className="text-xs px-2 py-1 bg-stone-100 hover:bg-stone-200 rounded font-mono" title={p.name}>
                        {p.sku}<span className="ml-1 text-stone-500">×{p.recommended_quantity}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-3">
        <div className="bg-white rounded-xl border border-stone-200 overflow-hidden">
          <div className="bg-red-700 text-white px-5 py-3 flex items-center gap-2">
            <AlertOctagon className="w-5 h-5" />
            <h3 className="font-bold">Pożary - bestsellery ({realCritical.length})</h3>
          </div>
          <div className="divide-y divide-stone-100 max-h-96 overflow-y-auto">
            {realCritical.map(p => (
              <button key={p.sku} onClick={() => onProductClick(p)} className="w-full px-4 py-3 flex items-center justify-between hover:bg-red-50 text-left">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${STATUS_CONFIG[p.status]?.bg} ${STATUS_CONFIG[p.status]?.text}`}>
                    {STATUS_CONFIG[p.status]?.label}
                  </span>
                  <span className="font-mono font-bold text-sm">{p.sku}</span>
                  <span className="text-sm text-stone-600 truncate">{p.name}</span>
                </div>
                <div className="text-right text-xs whitespace-nowrap ml-2">
                  <div className="font-bold">{p.avg_monthly_weighted}/mies · stan {p.stock}</div>
                  <div className="text-stone-500">{p.days_until_empty === 0 ? 'KONIEC dziś!' : `${p.days_until_empty}d`}</div>
                </div>
              </button>
            ))}
            {realCritical.length === 0 && (
              <div className="p-6 text-center text-stone-400">
                <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-emerald-500" />Brak pożarów
              </div>
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-stone-200 overflow-hidden">
          <div className="bg-blue-700 text-white px-5 py-3 flex items-center gap-2">
            <Ship className="w-5 h-5" />
            <h3 className="font-bold">Najbliższe dostawy ({upcomingContainers.length})</h3>
          </div>
          <div className="divide-y divide-stone-100 max-h-96 overflow-y-auto">
            {upcomingContainers.map(c => {
              const cfg = CONTAINER_STATUS_CONFIG[c.status];
              const Icon = cfg.icon;
              const days = Math.floor((new Date(c.eta_date) - new Date()) / 86400000);
              return (
                <button key={c.id} onClick={() => onContainerClick(c)} className="w-full px-4 py-3 flex items-center justify-between hover:bg-blue-50 text-left">
                  <div className="flex items-center gap-3 min-w-0">
                    <Icon className="w-4 h-4 text-blue-700 flex-shrink-0" />
                    <div className="min-w-0">
                      <div className="font-mono font-bold text-sm flex items-center gap-2">
                        #{c.container_number}
                        {c.manufacturer_color && <span className="px-1.5 py-0 rounded text-[9px] font-bold uppercase text-white" style={{ backgroundColor: c.manufacturer_color }}>{c.manufacturer_name}</span>}
                      </div>
                      <div className="text-xs text-stone-500">{c.items.length} pozycji · {c.total_units} szt · {fmtPLN(c.total_value)}</div>
                    </div>
                  </div>
                  <div className="text-right text-xs whitespace-nowrap">
                    <div className="font-bold">{new Date(c.eta_date).toLocaleDateString('pl-PL')}</div>
                    <div className="text-stone-500">za {days}d</div>
                  </div>
                </button>
              );
            })}
            {upcomingContainers.length === 0 && (
              <div className="p-6 text-center text-stone-400 text-sm">Brak dostaw</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CalendarView({ events, currentDate, setCurrentDate, onProductClick, onContainerClick }) {
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startWeekday = (firstDay.getDay() + 6) % 7;
  const daysInMonth = lastDay.getDate();
  const monthNames = ['Styczeń','Luty','Marzec','Kwiecień','Maj','Czerwiec','Lipiec','Sierpień','Wrzesień','Październik','Listopad','Grudzień'];
  const dayNames = ['Pn','Wt','Śr','Cz','Pt','Sb','Nd'];
  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  const todayKey = new Date().toISOString().slice(0, 10);
  
  const eventsByDate = useMemo(() => {
    const map = {};
    events.forEach(e => {
      if (!map[e.date]) map[e.date] = { orders: [], empties: [], deliveries: [] };
      if (e.type === 'ORDER') map[e.date].orders.push(e);
      if (e.type === 'EMPTY') map[e.date].empties.push(e);
      if (e.type === 'DELIVERY') map[e.date].deliveries.push(e);
    });
    return map;
  }, [events]);

  return (
    <div className="bg-white rounded-xl shadow-sm border border-stone-200 overflow-hidden">
      <div className="flex items-center justify-between p-5 border-b border-stone-200">
        <button onClick={() => setCurrentDate(new Date(year, month - 1, 1))} className="p-2 hover:bg-stone-100 rounded-lg"><ChevronLeft className="w-5 h-5" /></button>
        <h2 className="text-xl font-bold">{monthNames[month]} {year}</h2>
        <button onClick={() => setCurrentDate(new Date(year, month + 1, 1))} className="p-2 hover:bg-stone-100 rounded-lg"><ChevronRight className="w-5 h-5" /></button>
      </div>
      <div className="px-5 py-3 bg-stone-50 border-b border-stone-200 flex flex-wrap gap-4 text-xs">
        <div className="flex items-center gap-2"><div className="w-3 h-3 bg-orange-500 rounded"></div><span>Zamów do</span></div>
        <div className="flex items-center gap-2"><div className="w-3 h-3 bg-red-600 rounded"></div><span>Koniec zapasu</span></div>
        <div className="flex items-center gap-2"><div className="w-3 h-3 bg-blue-600 rounded"></div><span>Przypływa kontener</span></div>
      </div>
      <div className="grid grid-cols-7 border-b border-stone-200">
        {dayNames.map(d => <div key={d} className="p-3 text-center text-xs font-bold text-stone-500 uppercase">{d}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((day, idx) => {
          if (day === null) return <div key={idx} className="aspect-square bg-stone-50/50 border border-stone-100"></div>;
          const date = new Date(year, month, day);
          const key = date.toISOString().slice(0, 10);
          const dayEvents = eventsByDate[key] || { orders: [], empties: [], deliveries: [] };
          const isToday = key === todayKey;
          return (
            <div key={idx} className={`aspect-square min-h-28 p-2 border border-stone-100 ${isToday ? 'bg-amber-50' : 'bg-white'} relative overflow-hidden`}>
              <div className={`text-sm font-bold mb-1 ${isToday ? 'text-amber-700' : 'text-stone-700'}`}>{day}</div>
              <div className="space-y-1">
                {dayEvents.deliveries.slice(0, 2).map((c) => (
                  <button key={`d-${c.container_id}`} onClick={() => onContainerClick(c.container_id)}
                    className="w-full text-left text-[10px] bg-blue-600 hover:bg-blue-700 text-white px-1.5 py-0.5 rounded font-mono font-bold truncate flex items-center gap-1" title={`#${c.container_number}`}>
                    <Ship className="w-2.5 h-2.5 flex-shrink-0" /><span className="truncate">{c.container_number}</span>
                  </button>
                ))}
                {dayEvents.orders.slice(0, 2).map((p, i) => (
                  <button key={`o-${p.sku}-${i}`} onClick={() => onProductClick(p.sku)}
                    className="w-full text-left text-[10px] bg-orange-500 hover:bg-orange-600 text-white px-1.5 py-0.5 rounded font-mono font-bold truncate" title={p.name}>{p.sku}</button>
                ))}
                {dayEvents.empties.slice(0, 2).map((p, i) => (
                  <button key={`e-${p.sku}-${i}`} onClick={() => onProductClick(p.sku)}
                    className="w-full text-left text-[10px] bg-red-600 hover:bg-red-700 text-white px-1.5 py-0.5 rounded font-mono font-bold truncate" title={p.name}>{p.sku}</button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Definicja kolumn - id, label, sortKey, render
const COLUMN_DEFS = [
  { id: 'fav', label: '★', align: 'center', sortKey: 'is_favorite', alwaysVisible: false },
  { id: 'sku', label: 'Symbol', align: 'left', sortKey: 'sku', alwaysVisible: true },
  { id: 'name', label: 'Nazwa', align: 'left', sortKey: 'name' },
  { id: 'manufacturer', label: 'Producent', align: 'left', sortKey: 'manufacturer_name' },
  { id: 'stock', label: 'Stan', align: 'right', sortKey: 'stock' },
  { id: 'price', label: 'Cena', align: 'right', sortKey: 'purchase_price' },
  { id: 'value', label: 'Wartość', align: 'right', sortKey: 'stock_value' },
  { id: 'in_transit', label: 'W drodze', align: 'right', sortKey: 'stock_in_transit' },
  { id: 'sales_1m', label: '1m', align: 'right', sortKey: 'sales_1m' },
  { id: 'sales_2m', label: '2m', align: 'right', sortKey: 'sales_2m' },
  { id: 'yoy', label: 'YoY', align: 'right', sortKey: 'sales_yoy_30d', highlight: 'purple' },
  { id: 'yoy_next', label: '+30d', align: 'right', sortKey: 'sales_yoy_next_30d', highlight: 'purple' },
  { id: 'months', label: 'Mies.', align: 'right', sortKey: 'months_of_stock' },
  { id: 'cbm', label: 'CBM', align: 'center', sortKey: 'cbm_per_unit' },
  { id: 'lt', label: 'LT', align: 'center', sortKey: 'lead_time_days' },
  { id: 'status', label: 'Status', align: 'left', sortKey: 'days_until_order' },
];

const DEFAULT_VISIBLE = COLUMN_DEFS.map(c => c.id);  // wszystkie domyślnie

function ListView({ products, onProductClick, onToggleFavorite }) {
  // Stan sortowania: { key, direction: 'asc' | 'desc' | null }
  const [sortConfig, setSortConfig] = useState({ key: null, direction: null });
  
  // Wybrane kolumny - z localStorage
  const [visibleCols, setVisibleCols] = useState(() => {
    try {
      const saved = localStorage.getItem('magazyn_visible_cols');
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return DEFAULT_VISIBLE;
  });
  
  const [showColPicker, setShowColPicker] = useState(false);
  
  const saveVisibleCols = (cols) => {
    setVisibleCols(cols);
    try { localStorage.setItem('magazyn_visible_cols', JSON.stringify(cols)); } catch (e) {}
  };
  
  const toggleCol = (id) => {
    const col = COLUMN_DEFS.find(c => c.id === id);
    if (col?.alwaysVisible) return; // nie można ukryć SKU
    if (visibleCols.includes(id)) saveVisibleCols(visibleCols.filter(c => c !== id));
    else saveVisibleCols([...visibleCols, id]);
  };
  
  const resetCols = () => saveVisibleCols(DEFAULT_VISIBLE);
  
  const handleSort = (key) => {
    if (!key) return;
    setSortConfig(prev => {
      if (prev.key !== key) return { key, direction: 'asc' };
      if (prev.direction === 'asc') return { key, direction: 'desc' };
      return { key: null, direction: null }; // 3 stan: wyłączone
    });
  };
  
  const sorted = useMemo(() => {
    const arr = [...products];
    if (sortConfig.key && sortConfig.direction) {
      const dir = sortConfig.direction === 'asc' ? 1 : -1;
      arr.sort((a, b) => {
        const va = a[sortConfig.key];
        const vb = b[sortConfig.key];
        if (va == null && vb == null) return 0;
        if (va == null) return 1; // null na końcu
        if (vb == null) return -1;
        if (typeof va === 'string') return va.localeCompare(vb, 'pl') * dir;
        return (va - vb) * dir;
      });
    } else {
      // Domyślne sortowanie: dni do zamówienia rosnąco
      arr.sort((a, b) => (a.days_until_order || 9999) - (b.days_until_order || 9999));
    }
    return arr;
  }, [products, sortConfig]);
  
  const isVisible = (id) => visibleCols.includes(id);
  
  const renderCell = (col, p) => {
    switch (col.id) {
      case 'fav':
        return (
          <td key={col.id} className="px-2 py-3 text-center" onClick={(e) => { e.stopPropagation(); onToggleFavorite(p.sku); }}>
            <button className="hover:scale-125 transition-transform" title={p.is_favorite ? 'Usuń z obserwowanych' : 'Dodaj do obserwowanych'}>
              <Star className={`w-4 h-4 ${p.is_favorite ? 'text-amber-500 fill-amber-500' : 'text-stone-300'}`} />
            </button>
          </td>
        );
      case 'sku':
        return <td key={col.id} className="px-3 py-3 font-mono font-bold">
          {p.sku}
          {p.seasonality_enabled && <Sparkles className="w-3 h-3 inline ml-1 text-purple-600" />}
          {p.forced_status && <span className="ml-1 text-amber-600" title="Status wymuszony ręcznie">📌</span>}
        </td>;
      case 'name':
        return <td key={col.id} className="px-3 py-3 max-w-xs truncate">{p.name}</td>;
      case 'manufacturer':
        return <td key={col.id} className="px-3 py-3">
          {p.manufacturer_name ? (
            <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider text-white" style={{ backgroundColor: p.manufacturer_color || '#6b7280' }}>{p.manufacturer_name}</span>
          ) : <span className="text-stone-300 text-xs">—</span>}
        </td>;
      case 'stock':
        return <td key={col.id} className="px-3 py-3 text-right tabular-nums font-bold">{p.stock}</td>;
      case 'price':
        return <td key={col.id} className="px-3 py-3 text-right tabular-nums text-xs text-stone-600">{fmtPLN(p.purchase_price)}</td>;
      case 'value':
        return <td key={col.id} className="px-3 py-3 text-right tabular-nums text-xs text-stone-600">{fmtPLN(p.stock_value)}</td>;
      case 'in_transit':
        return <td key={col.id} className="px-3 py-3 text-right tabular-nums">
          {p.stock_in_transit > 0 ? <span className="text-blue-700 font-bold">+{p.stock_in_transit}</span> : <span className="text-stone-300">—</span>}
        </td>;
      case 'sales_1m':
        return <td key={col.id} className="px-3 py-3 text-right tabular-nums text-stone-600">{p.sales_1m}</td>;
      case 'sales_2m':
        return <td key={col.id} className="px-3 py-3 text-right tabular-nums text-stone-600">{p.sales_2m}</td>;
      case 'yoy':
        return <td key={col.id} className="px-3 py-3 text-right tabular-nums bg-purple-50 text-purple-900">{p.sales_yoy_30d}</td>;
      case 'yoy_next':
        return <td key={col.id} className="px-3 py-3 text-right tabular-nums bg-purple-50 text-purple-900 font-bold">{p.sales_yoy_next_30d}</td>;
      case 'months':
        return <td key={col.id} className="px-3 py-3 text-right tabular-nums font-bold">{p.months_of_stock}</td>;
      case 'cbm':
        return <td key={col.id} className="px-3 py-3 text-center tabular-nums text-xs">{p.cbm_per_unit > 0 ? p.cbm_per_unit : '—'}</td>;
      case 'lt':
        return <td key={col.id} className="px-3 py-3 text-center tabular-nums">{p.lead_time_days}d</td>;
      case 'status':
        return <td key={col.id} className="px-3 py-3">
          <span className={`inline-block px-2 py-1 rounded-full text-xs font-bold ${STATUS_CONFIG[p.status]?.bg} ${STATUS_CONFIG[p.status]?.text}`}>
            {STATUS_CONFIG[p.status]?.label}
          </span>
        </td>;
      default:
        return <td key={col.id}></td>;
    }
  };
  
  return (
    <>
      <div className="mb-2 flex justify-between items-center flex-wrap gap-2">
        <div className="text-xs text-stone-500">
          {sortConfig.key && (
            <span className="bg-amber-100 text-amber-900 px-2 py-1 rounded font-bold">
              Sortuj: {COLUMN_DEFS.find(c => c.sortKey === sortConfig.key)?.label} {sortConfig.direction === 'asc' ? '▲' : '▼'}
              <button onClick={() => setSortConfig({ key: null, direction: null })} className="ml-2 hover:text-red-600">✕</button>
            </span>
          )}
        </div>
        <button onClick={() => setShowColPicker(true)} className="flex items-center gap-2 px-3 py-1.5 bg-white border-2 border-stone-200 hover:bg-stone-50 rounded-lg font-bold text-xs">
          <Columns3 className="w-4 h-4" />Kolumny ({visibleCols.length}/{COLUMN_DEFS.length})
        </button>
      </div>
      <div className="bg-white rounded-xl shadow-sm border border-stone-200 overflow-hidden overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-stone-900 text-stone-100">
            <tr>
              {COLUMN_DEFS.filter(c => isVisible(c.id)).map(col => {
                const isActive = sortConfig.key === col.sortKey && sortConfig.direction;
                const align = col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left';
                const highlight = col.highlight === 'purple' ? 'bg-purple-900' : '';
                return (
                  <th key={col.id} 
                    onClick={() => handleSort(col.sortKey)}
                    className={`px-2 py-3 ${align} text-xs font-bold uppercase ${highlight} ${col.sortKey ? 'cursor-pointer hover:bg-stone-800 select-none' : ''} ${isActive ? 'bg-amber-600 text-stone-900' : ''}`}
                    title={col.sortKey ? 'Kliknij aby sortować' : ''}>
                    <div className={`flex items-center gap-1 ${col.align === 'right' ? 'justify-end' : col.align === 'center' ? 'justify-center' : ''}`}>
                      {col.label}
                      {isActive && (sortConfig.direction === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {sorted.map(p => (
              <tr key={p.sku} onClick={() => onProductClick(p)} className="hover:bg-amber-50/50 cursor-pointer">
                {COLUMN_DEFS.filter(c => isVisible(c.id)).map(col => renderCell(col, p))}
              </tr>
            ))}
          </tbody>
        </table>
        {sorted.length === 0 && (
          <div className="p-8 text-center text-stone-400">Brak produktów spełniających kryteria.</div>
        )}
      </div>
      
      {showColPicker && (
        <div className="fixed inset-0 bg-stone-900/70 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={() => setShowColPicker(false)}>
          <div className="bg-white rounded-2xl max-w-md w-full shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="bg-stone-900 text-white p-4 flex items-center justify-between">
              <div className="flex items-center gap-2"><Columns3 className="w-5 h-5 text-amber-400" /><h2 className="font-bold">Wybierz kolumny</h2></div>
              <button onClick={() => setShowColPicker(false)} className="p-1 hover:bg-stone-800 rounded"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-4 max-h-96 overflow-y-auto">
              <p className="text-xs text-stone-500 mb-3">Wybierz które kolumny chcesz widzieć w tabeli. Wybór jest zapamiętany.</p>
              <div className="space-y-1">
                {COLUMN_DEFS.map(col => (
                  <label key={col.id} className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer hover:bg-stone-50 ${col.alwaysVisible ? 'opacity-50 cursor-not-allowed' : ''}`}>
                    <input type="checkbox" 
                      checked={isVisible(col.id)} 
                      onChange={() => toggleCol(col.id)}
                      disabled={col.alwaysVisible}
                      className="w-4 h-4 accent-amber-500" />
                    <span className="font-bold flex-1">{col.label}</span>
                    {col.alwaysVisible && <span className="text-[10px] text-stone-400">(wymagana)</span>}
                  </label>
                ))}
              </div>
            </div>
            <div className="bg-stone-50 px-4 py-3 flex justify-between border-t border-stone-200">
              <button onClick={resetCols} className="text-xs px-3 py-1.5 bg-stone-200 rounded-lg font-bold">↺ Resetuj (wszystkie)</button>
              <button onClick={() => setShowColPicker(false)} className="text-xs px-3 py-1.5 bg-amber-500 text-stone-900 rounded-lg font-bold">Gotowe</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ContainersView({ containers, containerTypes, manufacturers, products, onNew, onEdit, onAutoSuggest, onExport, onUpdateStatus, canEdit = true }) {
  const [filter, setFilter] = useState('ALL');
  const [expandedIds, setExpandedIds] = useState(new Set());
  const filtered = filter === 'ALL' ? containers : containers.filter(c => c.status === filter);
  const sorted = [...filtered].sort((a, b) => new Date(a.eta_date) - new Date(b.eta_date));
  
  const toggleExpand = (id) => {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedIds(next);
  };
  
  return (
    <div>
      <div className="flex justify-between items-center mb-4 flex-wrap gap-3">
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setFilter('ALL')} className={`px-3 py-1.5 rounded-lg text-sm font-medium ${filter === 'ALL' ? 'bg-stone-900 text-white' : 'bg-white border border-stone-300'}`}>Wszystkie ({containers.length})</button>
          {Object.entries(CONTAINER_STATUS_CONFIG).map(([key, cfg]) => {
            const count = containers.filter(c => c.status === key).length;
            return <button key={key} onClick={() => setFilter(key)} className={`px-3 py-1.5 rounded-lg text-sm font-medium ${filter === key ? `${cfg.bg} ${cfg.text}` : 'bg-white border border-stone-300'}`}>{cfg.label} ({count})</button>;
          })}
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setExpandedIds(expandedIds.size > 0 ? new Set() : new Set(sorted.map(c => c.id)))}
            className="flex items-center gap-2 bg-white border-2 border-stone-200 hover:bg-stone-50 px-3 py-2 rounded-lg font-bold text-sm">
            {expandedIds.size > 0 ? <><ChevronUp className="w-4 h-4" />Zwiń wszystkie</> : <><ChevronDown className="w-4 h-4" />Rozwiń wszystkie</>}
          </button>
          {canEdit && onAutoSuggest && <button onClick={onAutoSuggest} className="flex items-center gap-2 bg-gradient-to-r from-purple-600 to-purple-700 hover:from-purple-700 hover:to-purple-800 text-white px-4 py-2 rounded-lg font-bold">
            <Wand2 className="w-4 h-4" />Auto-sugestia
          </button>}
          <button onClick={onExport} className="flex items-center gap-2 bg-white border-2 border-stone-200 hover:bg-stone-50 px-4 py-2 rounded-lg font-bold">
            <Download className="w-4 h-4" />Eksport XLSX
          </button>
          {canEdit && onNew && <button onClick={onNew} className="flex items-center gap-2 bg-amber-500 hover:bg-amber-600 text-stone-900 px-4 py-2 rounded-lg font-bold">
            <Plus className="w-4 h-4" />Nowy
          </button>}
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="bg-white rounded-xl border border-stone-200 p-12 text-center">
          <Ship className="w-12 h-12 text-stone-300 mx-auto mb-3" />
          <p className="text-stone-500">Brak kontenerów. Kliknij "Nowy".</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {sorted.map(c => {
            const cfg = CONTAINER_STATUS_CONFIG[c.status];
            const Icon = cfg.icon;
            const days = Math.floor((new Date(c.eta_date) - new Date()) / 86400000);
            const nextStatus = { ORDERED: 'IN_PRODUCTION', IN_PRODUCTION: 'IN_TRANSIT', IN_TRANSIT: 'DELIVERED' }[c.status];
            const fillColor = c.fill_percentage > 100 ? 'bg-red-500' : c.fill_percentage > 90 ? 'bg-amber-500' : c.fill_percentage > 70 ? 'bg-emerald-500' : 'bg-blue-500';
            const carrier = getCarrier(c.container_number);
            const isExpanded = expandedIds.has(c.id);
            
            return (
              <div key={c.id} className="bg-white rounded-xl border border-stone-200 overflow-hidden shadow-sm hover:shadow-md transition">
                <div onClick={() => toggleExpand(c.id)} 
                  className={`${cfg.bg} ${cfg.text} px-5 py-3 flex items-center justify-between flex-wrap gap-2 cursor-pointer hover:brightness-110`}>
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    {isExpanded ? <ChevronUp className="w-5 h-5 flex-shrink-0" /> : <ChevronDown className="w-5 h-5 flex-shrink-0" />}
                    <Icon className="w-5 h-5 flex-shrink-0" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono font-bold text-base md:text-lg">#{c.container_number}</span>
                        {c.container_type_name && <span className="bg-black/30 px-2 py-0.5 rounded text-xs font-bold">{c.container_type_name}</span>}
                        {c.manufacturer_name && <span className="px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wider" style={{ backgroundColor: c.manufacturer_color, color: 'white' }}>{c.manufacturer_name}</span>}
                        {carrier && (
                          <a href={carrier.url(c.container_number)} target="_blank" rel="noopener noreferrer"
                             onClick={(e) => e.stopPropagation()}
                             className="bg-white/20 hover:bg-white/30 px-2 py-0.5 rounded text-xs font-bold flex items-center gap-1">
                            🛰️ Track {carrier.name}<ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                      <div className="text-xs opacity-90 mt-0.5">
                        {c.order_number ? `Nr zamówienia: ${c.order_number}` : '— bez numeru zamówienia —'}
                      </div>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-xs opacity-90 uppercase tracking-wider">{cfg.label}</div>
                    <div className="font-bold text-base md:text-lg tabular-nums">ETA: {new Date(c.eta_date).toLocaleDateString('pl-PL')}</div>
                    <div className="text-xs opacity-90">{c.status === 'DELIVERED' ? 'dostarczony' : days > 0 ? `za ${days} dni` : `${Math.abs(days)} dni temu`}</div>
                  </div>
                </div>
                
                <div className="px-5 py-2 bg-stone-50 border-b border-stone-100 flex items-center justify-between flex-wrap gap-2 text-xs text-stone-800 font-medium">
                  <span>Zamówiony: {new Date(c.order_date).toLocaleDateString('pl-PL')} · Razem: <strong>{c.total_units} szt</strong> · Wartość: <strong>{fmtPLN(c.total_value)}</strong></span>
                  {nextStatus && (
                    <button onClick={(e) => { e.stopPropagation(); onUpdateStatus(c.id, nextStatus); }}
                      className="text-xs px-3 py-1 bg-stone-900 text-white rounded-lg hover:bg-stone-800 font-medium">
                      → {CONTAINER_STATUS_CONFIG[nextStatus].label}
                    </button>
                  )}
                </div>
                
                {isExpanded && (
                  <div className="p-5">
                    <div className="grid gap-2 mb-3">
                      {c.items.map(item => (
                        <div key={item.id} className="flex items-center justify-between bg-stone-50 rounded-lg px-3 py-2">
                          <div className="flex items-center gap-3 flex-1 min-w-0">
                            <span className="font-mono font-bold text-sm">{item.sku}</span>
                            <span className="text-sm text-stone-600 truncate">{item.product_name}</span>
                            <span className="text-sm font-bold whitespace-nowrap">×{item.quantity}</span>
                          </div>
                          <div className="text-right text-xs text-stone-500 whitespace-nowrap ml-2">
                            {item.cbm_per_unit > 0 && <span className="tabular-nums">{item.total_cbm} m³</span>}
                            {item.unit_cost && <span className="ml-2">{fmtPLN(item.unit_cost * item.quantity)}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                    
                    {c.container_capacity_cbm && (
                      <div className="mb-3">
                        <div className="flex justify-between text-xs mb-1">
                          <span className="text-stone-600 flex items-center gap-1"><Box className="w-3 h-3" />Wypełnienie</span>
                          <span className={`font-bold tabular-nums ${c.fill_percentage > 100 ? 'text-red-600' : c.fill_percentage > 90 ? 'text-amber-600' : 'text-stone-700'}`}>
                            {c.total_cbm} / {c.container_capacity_cbm} m³ ({c.fill_percentage}%)
                          </span>
                        </div>
                        <div className="h-3 bg-stone-200 rounded-full overflow-hidden">
                          <div className={`h-full ${fillColor}`} style={{ width: `${Math.min(100, c.fill_percentage)}%` }}></div>
                        </div>
                      </div>
                    )}
                    
                    {c.attachments && c.attachments.length > 0 && (
                      <div className="mb-3 pb-3 border-b border-stone-100">
                        <div className="text-xs font-bold uppercase text-stone-500 mb-1 flex items-center gap-1">
                          <Paperclip className="w-3 h-3" />Załączniki ({c.attachments.length})
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {c.attachments.map(att => (
                            <span key={att.id} className="bg-stone-100 px-2 py-1 rounded text-xs font-mono">
                              {att.filename}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    <div className="flex justify-end pt-2 border-t border-stone-100">
                      <button onClick={() => onEdit(c)}
                        className="text-xs px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-stone-900 rounded-lg font-bold flex items-center gap-1">
                        <Edit2 className="w-3 h-3" />Edytuj kontener
                      </button>
                    </div>
                    {c.notes && <div className="mt-2 text-xs text-stone-500 italic">{c.notes}</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CashflowView({ cashflow }) {
  const maxTotal = Math.max(...cashflow.months.map(m => m.total), 1);
  return (
    <div className="space-y-6">
      <KpiCard label="Suma wydatków na kontenery" value={fmtPLN(cashflow.total)} bg="bg-gradient-to-br from-emerald-700 to-emerald-900" txt="text-emerald-100" />
      <div className="bg-white rounded-xl border border-stone-200 p-5">
        <h3 className="font-bold mb-4">Wydatki na kontenery - prognoza</h3>
        <div className="space-y-3">
          {cashflow.months.map((m, idx) => (
            <div key={idx}>
              <div className="flex justify-between items-baseline mb-1">
                <span className="font-bold text-sm">{m.label}</span>
                <span className="font-bold tabular-nums">{fmtPLN(m.total)}</span>
              </div>
              <div className="relative h-8 bg-stone-100 rounded-lg overflow-hidden">
                <div className="h-full bg-emerald-500 transition-all flex items-center px-3" 
                     style={{ width: `${Math.min(100, (m.total / maxTotal) * 100)}%` }}>
                  {m.containers.length > 0 && <span className="text-white text-xs font-bold">{m.containers.length} kontenerów</span>}
                </div>
              </div>
              {m.containers.length > 0 && (
                <div className="mt-1 ml-2 text-xs text-stone-600 flex flex-wrap gap-2">
                  {m.containers.map(c => (
                    <span key={c.id} className="bg-stone-100 px-2 py-0.5 rounded">
                      #{c.container_number} {c.manufacturer_name && <span style={{ color: c.manufacturer_color }}>({c.manufacturer_name})</span>} → {fmtPLN(c.total_value)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SettingsView({ manufacturers, containerTypes, onReloadManufacturers, onReloadTypes, canEdit = true }) {
  return (
    <div className="grid md:grid-cols-2 gap-6">
      <ManufacturersPanel manufacturers={manufacturers} canEdit={canEdit} onReload={onReloadManufacturers} />
      <ContainerTypesPanel containerTypes={containerTypes} canEdit={canEdit} onReload={onReloadTypes} />
    </div>
  );
}

function ManufacturersPanel({ manufacturers, onReload, canEdit = true }) {
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ name: '', color: '#6b7280', notes: '', email: '' });
  const startNew = () => { setEditing('new'); setForm({ name: '', color: '#6b7280', notes: '', email: '' }); };
  const startEdit = (m) => { setEditing(m.id); setForm({ name: m.name, color: m.color, notes: m.notes || '', email: m.email || '' }); };
  const save = async () => {
    if (!form.name.trim()) return;
    try {
      if (editing === 'new') await api.post('/manufacturers', form);
      else await api.patch(`/manufacturers/${editing}`, form);
      await onReload(); setEditing(null);
    } catch (e) { alert('Błąd: ' + e.message); }
  };
  const remove = async (id) => {
    if (!window.confirm('Usunąć tego producenta?')) return;
    try { await api.del(`/manufacturers/${id}`); await onReload(); } catch (e) { alert(e.message); }
  };

  return (
    <div className="bg-white rounded-xl border border-stone-200 overflow-hidden">
      <div className="bg-stone-900 text-white px-5 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2"><Building2 className="w-5 h-5 text-amber-400" /><h3 className="font-bold">Producenci</h3></div>
        {canEdit && <button onClick={startNew} className="text-xs bg-amber-500 text-stone-900 px-3 py-1.5 rounded-lg font-bold flex items-center gap-1"><Plus className="w-3 h-3" />Nowy</button>}
      </div>
      <div className="p-4 space-y-2 max-h-96 overflow-y-auto">
        {editing === 'new' && <ManufacturerEditRow form={form} setForm={setForm} onSave={save} onCancel={() => setEditing(null)} />}
        {manufacturers.map(m => editing === m.id ? (
          <ManufacturerEditRow key={m.id} form={form} setForm={setForm} onSave={save} onCancel={() => setEditing(null)} onDelete={() => remove(m.id)} />
        ) : (
          <div key={m.id} className="flex items-center gap-3 p-3 bg-stone-50 rounded-lg">
            <div className="w-4 h-4 rounded-full flex-shrink-0" style={{ backgroundColor: m.color }}></div>
            <div className="flex-1 min-w-0">
              <div className="font-bold">{m.name}</div>
              <div className="text-xs text-stone-500 truncate">{m.email || m.notes || '—'}</div>
            </div>
            {canEdit && <button onClick={() => startEdit(m)} className="p-2 hover:bg-stone-200 rounded"><Edit2 className="w-4 h-4 text-stone-600" /></button>}
          </div>
        ))}
        {manufacturers.length === 0 && editing !== 'new' && (
          <div className="text-center text-stone-400 py-4 text-sm">Brak producentów. Dodaj pierwszego.</div>
        )}
      </div>
    </div>
  );
}

function ManufacturerEditRow({ form, setForm, onSave, onCancel, onDelete }) {
  return (
    <div className="border-2 border-amber-500 rounded-lg p-3 space-y-2">
      <div className="flex gap-2">
        <input type="color" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} className="w-12 h-10 rounded cursor-pointer" />
        <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Nazwa firmy" autoFocus className="flex-1 px-3 py-2 border-2 border-stone-200 rounded-lg text-sm" />
      </div>
      <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="Email kontaktowy" className="w-full px-3 py-2 border-2 border-stone-200 rounded-lg text-sm" />
      <input type="text" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Notatki" className="w-full px-3 py-2 border-2 border-stone-200 rounded-lg text-sm" />
      <div className="flex gap-2 justify-end">
        {onDelete && <button onClick={onDelete} className="text-xs text-red-600 px-3 py-1.5 font-bold flex items-center gap-1 hover:bg-red-50 rounded"><Trash2 className="w-3 h-3" />Usuń</button>}
        <button onClick={onCancel} className="text-xs px-3 py-1.5 bg-stone-200 rounded font-bold">Anuluj</button>
        <button onClick={onSave} className="text-xs px-3 py-1.5 bg-emerald-600 text-white rounded font-bold">Zapisz</button>
      </div>
    </div>
  );
}

function ContainerTypesPanel({ containerTypes, onReload, canEdit = true }) {
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ name: '', capacity_cbm: '', sort_order: 0 });
  const startNew = () => { setEditing('new'); setForm({ name: '', capacity_cbm: '', sort_order: containerTypes.length + 1 }); };
  const startEdit = (t) => { setEditing(t.id); setForm({ name: t.name, capacity_cbm: t.capacity_cbm.toString(), sort_order: t.sort_order }); };
  const save = async () => {
    const cap = parseFloat(form.capacity_cbm);
    if (!form.name.trim() || !(cap > 0)) return;
    const data = { name: form.name.trim(), capacity_cbm: cap, sort_order: parseInt(form.sort_order) || 0 };
    try {
      if (editing === 'new') await api.post('/container-types', data);
      else await api.patch(`/container-types/${editing}`, data);
      await onReload(); setEditing(null);
    } catch (e) { alert(e.message); }
  };
  const remove = async (id) => {
    if (!window.confirm('Usunąć?')) return;
    try { await api.del(`/container-types/${id}`); await onReload(); } catch (e) { alert(e.message); }
  };
  const sorted = [...containerTypes].sort((a, b) => a.sort_order - b.sort_order);
  
  return (
    <div className="bg-white rounded-xl border border-stone-200 overflow-hidden">
      <div className="bg-stone-900 text-white px-5 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2"><Box className="w-5 h-5 text-amber-400" /><h3 className="font-bold">Typy kontenerów</h3></div>
        {canEdit && <button onClick={startNew} className="text-xs bg-amber-500 text-stone-900 px-3 py-1.5 rounded-lg font-bold flex items-center gap-1"><Plus className="w-3 h-3" />Nowy</button>}
      </div>
      <div className="p-4 space-y-2">
        {editing === 'new' && <TypeEditRow form={form} setForm={setForm} onSave={save} onCancel={() => setEditing(null)} />}
        {sorted.map(t => editing === t.id ? (
          <TypeEditRow key={t.id} form={form} setForm={setForm} onSave={save} onCancel={() => setEditing(null)} onDelete={() => remove(t.id)} />
        ) : (
          <div key={t.id} className="flex items-center gap-3 p-3 bg-stone-50 rounded-lg">
            <Ship className="w-5 h-5 text-stone-500" />
            <div className="flex-1">
              <div className="font-bold">{t.name}</div>
              <div className="text-xs text-stone-500">Pojemność: <strong>{t.capacity_cbm} m³</strong></div>
            </div>
            {canEdit && <button onClick={() => startEdit(t)} className="p-2 hover:bg-stone-200 rounded"><Edit2 className="w-4 h-4 text-stone-600" /></button>}
          </div>
        ))}
      </div>
    </div>
  );
}

function TypeEditRow({ form, setForm, onSave, onCancel, onDelete }) {
  return (
    <div className="border-2 border-amber-500 rounded-lg p-3 space-y-2">
      <div className="grid grid-cols-3 gap-2">
        <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Nazwa" autoFocus className="col-span-2 px-3 py-2 border-2 border-stone-200 rounded-lg text-sm" />
        <input type="number" value={form.capacity_cbm} onChange={(e) => setForm({ ...form, capacity_cbm: e.target.value })} placeholder="m³" step="0.1" className="px-3 py-2 border-2 border-stone-200 rounded-lg text-sm tabular-nums" />
      </div>
      <div className="flex gap-2 justify-end">
        {onDelete && <button onClick={onDelete} className="text-xs text-red-600 px-3 py-1.5 font-bold hover:bg-red-50 rounded">Usuń</button>}
        <button onClick={onCancel} className="text-xs px-3 py-1.5 bg-stone-200 rounded font-bold">Anuluj</button>
        <button onClick={onSave} className="text-xs px-3 py-1.5 bg-emerald-600 text-white rounded font-bold">Zapisz</button>
      </div>
    </div>
  );
}

function ProductModal({ product, manufacturers, canEdit = true, onClose, onUpdate }) {
  const [editingLT, setEditingLT] = useState(false);
  const [tempLT, setTempLT] = useState(product.lead_time_days.toString());
  const [editingAttrs, setEditingAttrs] = useState(false);
  const [tempCbm, setTempCbm] = useState(product.cbm_per_unit?.toString() || '0');
  const [tempMfr, setTempMfr] = useState(product.manufacturer_id || '');
  const [tempSeas, setTempSeas] = useState(product.seasonality_enabled);
  const [tempEan, setTempEan] = useState(product.ean || '');
  const [tempForcedStatus, setTempForcedStatus] = useState(product.forced_status || 'AUTO');
  const [projection, setProjection] = useState(null);
  
  useEffect(() => {
    api.get(`/products/${encodeURIComponent(product.sku)}/projection?days=180`).then(setProjection).catch(console.error);
  }, [product.sku]);

  const handleSaveLT = async () => {
    const v = parseInt(tempLT);
    if (v > 0 && v < 365) {
      try { await api.put(`/products/${encodeURIComponent(product.sku)}/lead-time`, { lead_time_days: v }); await onUpdate(); setEditingLT(false); }
      catch (e) { alert(e.message); }
    }
  };
  const handleSaveAttrs = async () => {
    try {
      await api.put(`/products/${encodeURIComponent(product.sku)}/attrs`, {
        cbm_per_unit: parseFloat(tempCbm) || 0,
        manufacturer_id: tempMfr ? parseInt(tempMfr) : null,
        seasonality_enabled: tempSeas,
        ean: tempEan.trim() || null,
        forced_status: tempForcedStatus === 'AUTO' ? null : tempForcedStatus,
      });
      await onUpdate(); setEditingAttrs(false);
    } catch (e) { alert(e.message); }
  };
  
  const maxSale = Math.max(product.sales_1m, product.sales_2m, product.sales_3m, product.sales_4m, product.sales_yoy_next_30d, 1);
  const maxStock = projection ? Math.max(...projection.map(p => p.stock), 1) : 1;

  return (
    <div className="fixed inset-0 bg-stone-900/70 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className={`${STATUS_CONFIG[product.status]?.bg} ${STATUS_CONFIG[product.status]?.text} p-6`}>
          <div className="flex items-start justify-between">
            <div>
              <div className="text-xs font-bold uppercase tracking-widest opacity-90 flex items-center gap-2">
                {STATUS_CONFIG[product.status]?.label}
                {product.forced_status && <span className="bg-white/20 px-2 py-0.5 rounded text-[10px]" title="Status wymuszony ręcznie">📌 WYMUSZONY</span>}
              </div>
              <div className="font-mono text-2xl font-bold mt-1 flex items-center gap-2">
                {product.sku}
                <button onClick={async () => {
                  try { await api.put(`/products/${encodeURIComponent(product.sku)}/favorite`); await onUpdate(); }
                  catch (e) { alert(e.message); }
                }} className="hover:scale-125 transition-transform" title={product.is_favorite ? 'Usuń z obserwowanych' : 'Dodaj do obserwowanych'}>
                  <Star className={`w-6 h-6 ${product.is_favorite ? 'fill-yellow-300 text-yellow-300' : 'text-white/40'}`} />
                </button>
              </div>
              <div className="text-lg opacity-90">{product.name}</div>
              {product.manufacturer_name && (
                <div className="mt-2"><span className="px-2 py-1 rounded text-xs font-bold uppercase text-white" style={{ backgroundColor: product.manufacturer_color }}>{product.manufacturer_name}</span></div>
              )}
            </div>
            <button onClick={onClose} className="p-2 hover:bg-black/20 rounded-lg"><X className="w-5 h-5" /></button>
          </div>
        </div>
        <div className="p-6 space-y-6">
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-stone-100 rounded-xl p-4">
              <div className="text-xs uppercase tracking-wider text-stone-500 font-bold mb-1">Stan</div>
              <div className="text-3xl font-bold tabular-nums">{product.stock}</div>
              <div className="text-xs text-stone-500">{fmtPLN(product.stock_value)}</div>
            </div>
            <div className="bg-blue-50 rounded-xl p-4 border border-blue-200">
              <div className="text-xs uppercase tracking-wider text-blue-700 font-bold mb-1"><Ship className="w-3 h-3 inline" /> W drodze</div>
              <div className="text-3xl font-bold tabular-nums text-blue-900">+{product.stock_in_transit}</div>
            </div>
            <div className="bg-stone-100 rounded-xl p-4">
              <div className="text-xs uppercase tracking-wider text-stone-500 font-bold mb-1">Sprzedaż mies.</div>
              <div className="text-3xl font-bold tabular-nums">{product.avg_monthly_weighted}</div>
              <div className="text-xs text-stone-600">≈ {product.months_of_stock} mies.</div>
            </div>
          </div>

          <div className="bg-stone-50 border-2 border-stone-200 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold uppercase tracking-wider text-stone-700">Atrybuty produktu</h3>
            {!editingAttrs && <button onClick={() => canEdit && setEditingAttrs(true)} className={`text-xs font-bold flex items-center gap-1 ${canEdit ? 'text-amber-700' : 'text-stone-300 cursor-not-allowed'}`} title={!canEdit ? 'Tylko podgląd' : ''}><Edit2 className="w-3 h-3" />{canEdit ? 'Edytuj' : '🔒 Tylko podgląd'}</button>}
            </div>
            {editingAttrs ? (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-bold text-stone-600 mb-1 uppercase">CBM per szt (m³)</label>
                  <input type="number" value={tempCbm} onChange={(e) => setTempCbm(e.target.value)} step="0.0001" className="w-full px-3 py-2 border-2 border-amber-500 rounded-lg tabular-nums" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-stone-600 mb-1 uppercase">EAN (kod kreskowy)</label>
                  <input type="text" value={tempEan} onChange={(e) => setTempEan(e.target.value)} placeholder="np. 5901234123457" className="w-full px-3 py-2 border-2 border-amber-500 rounded-lg font-mono" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-stone-600 mb-1 uppercase">Klasyfikacja produktu</label>
                  <select value={tempForcedStatus} onChange={(e) => setTempForcedStatus(e.target.value)} 
                    className={`w-full px-3 py-2 border-2 rounded-lg bg-white ${tempForcedStatus === 'AUTO' ? 'border-stone-200' : 'border-amber-500'}`}>
                    <option value="AUTO">🤖 Auto (algorytm decyduje)</option>
                    <option value="ACTIVE">✅ ACTIVE - aktywny</option>
                    <option value="ACTIVE_NO_STOCK">⚠️ ACTIVE_NO_STOCK - sprzedaje się, brak stanu</option>
                    <option value="DEAD_STOCK">💀 DEAD_STOCK - zamrożony stan</option>
                    <option value="INACTIVE">📦 INACTIVE - nieaktywny</option>
                  </select>
                  {tempForcedStatus !== 'AUTO' && (
                    <div className="text-[11px] text-amber-700 mt-1 flex items-center gap-1">
                      📌 Wymuszony status - algorytm zostanie zignorowany
                    </div>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-bold text-stone-600 mb-1 uppercase">Producent</label>
                  <select value={tempMfr} onChange={(e) => setTempMfr(e.target.value)} className="w-full px-3 py-2 border-2 border-amber-500 rounded-lg bg-white">
                    <option value="">— bez —</option>
                    {manufacturers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
                <label className="flex items-center gap-2 cursor-pointer p-3 bg-purple-50 border border-purple-200 rounded-lg">
                  <input type="checkbox" checked={tempSeas} onChange={(e) => setTempSeas(e.target.checked)} className="w-5 h-5 accent-purple-600" />
                  <div className="flex-1">
                    <div className="text-sm font-bold text-purple-900 flex items-center gap-1"><Sparkles className="w-4 h-4" />Sezonowość</div>
                  </div>
                </label>
                <div className="flex gap-2">
                  <button onClick={handleSaveAttrs} className="flex-1 px-4 py-2 bg-emerald-600 text-white rounded-lg font-bold">Zapisz</button>
                  <button onClick={() => setEditingAttrs(false)} className="px-4 py-2 bg-stone-300 rounded-lg font-bold">Anuluj</button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div><div className="text-xs text-stone-500 uppercase font-bold">CBM</div><div className="text-lg font-bold tabular-nums">{product.cbm_per_unit > 0 ? `${product.cbm_per_unit} m³` : '—'}</div></div>
                <div><div className="text-xs text-stone-500 uppercase font-bold">EAN</div><div className="text-sm font-mono font-bold truncate">{product.ean || '—'}</div></div>
                <div><div className="text-xs text-stone-500 uppercase font-bold">Producent</div><div className="text-lg font-bold">{product.manufacturer_name || '—'}</div></div>
                <div><div className="text-xs text-stone-500 uppercase font-bold">Sezonowość</div><div className="text-lg font-bold">{product.seasonality_enabled ? <span className="text-purple-600 flex items-center gap-1"><Sparkles className="w-4 h-4" />ON</span> : 'OFF'}</div></div>
              </div>
            )}
          </div>

          {projection && (
            <div>
              <h3 className="text-sm font-bold uppercase tracking-wider text-stone-500 mb-3">Prognoza stanu na 180 dni</h3>
              <div className="bg-stone-50 rounded-xl p-4 relative" style={{ height: '180px' }}>
                <svg className="w-full h-full" viewBox={`0 0 ${projection.length} 100`} preserveAspectRatio="none">
                  <defs><linearGradient id="grad" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#f59e0b" /><stop offset="100%" stopColor="#f59e0b" stopOpacity="0" /></linearGradient></defs>
                  {projection.map((p, i) => p.event && <line key={i} x1={i} y1="0" x2={i} y2="100" stroke="#2563eb" strokeWidth="0.3" strokeDasharray="1,1" />)}
                  <polygon points={`0,100 ${projection.map((p, i) => `${i},${100 - (p.stock / maxStock) * 95}`).join(' ')} ${projection.length - 1},100`} fill="url(#grad)" opacity="0.4" />
                  <polyline points={projection.map((p, i) => `${i},${100 - (p.stock / maxStock) * 95}`).join(' ')} fill="none" stroke="#f59e0b" strokeWidth="0.6" />
                </svg>
                <div className="absolute top-2 left-3 text-xs text-stone-400 tabular-nums font-bold">{maxStock}</div>
                <div className="absolute bottom-2 left-3 text-xs text-stone-400 font-bold">0</div>
              </div>
            </div>
          )}

          <div>
            <h3 className="text-sm font-bold uppercase tracking-wider text-stone-500 mb-3">Sprzedaż + YoY</h3>
            <div className="grid grid-cols-6 gap-2">
              {[['1m', product.sales_1m, 'amber'], ['2m', product.sales_2m, 'amber'], ['3m', product.sales_3m, 'amber'], ['4m', product.sales_4m, 'amber'], ['rok temu', product.sales_yoy_30d, 'purple'], ['+30d temu', product.sales_yoy_next_30d, 'purple']].map(([label, value, color]) => (
                <div key={label} className="text-center">
                  <div className="h-20 bg-stone-100 rounded-lg flex items-end overflow-hidden"><div className={`w-full ${color === 'amber' ? 'bg-gradient-to-t from-amber-500 to-amber-300' : 'bg-gradient-to-t from-purple-600 to-purple-400'}`} style={{ height: `${(value / maxSale) * 100}%` }}></div></div>
                  <div className="text-base font-bold tabular-nums mt-1">{value}</div>
                  <div className="text-[10px] text-stone-500 uppercase">{label}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-amber-50 border-2 border-amber-200 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold uppercase tracking-wider text-amber-900">Lead time</h3>
              {!editingLT && canEdit && <button onClick={() => setEditingLT(true)} className="text-xs font-bold text-amber-700 flex items-center gap-1"><Edit2 className="w-3 h-3" />Edytuj</button>}
            </div>
            {editingLT ? (
              <div className="flex items-center gap-2">
                <input type="number" value={tempLT} onChange={(e) => setTempLT(e.target.value)} className="flex-1 px-3 py-2 border-2 border-amber-500 rounded-lg text-lg tabular-nums font-bold" autoFocus />
                <span className="text-stone-600">dni</span>
                <button onClick={handleSaveLT} className="px-4 py-2 bg-emerald-600 text-white rounded-lg font-bold">Zapisz</button>
                <button onClick={() => setEditingLT(false)} className="px-4 py-2 bg-stone-300 rounded-lg font-bold">Anuluj</button>
              </div>
            ) : (<div className="text-2xl font-bold text-amber-900 tabular-nums">{product.lead_time_days} dni</div>)}
          </div>
        </div>
      </div>
    </div>
  );
}

function ContainerForm({ products, manufacturers, containerTypes, initial, onSave, onClose, onDelete, onAddAttachment, onDeleteAttachment }) {
  const [containerNumber, setContainerNumber] = useState(initial?.container_number || '');
  const [orderNumber, setOrderNumber] = useState(initial?.order_number || '');
  const [containerTypeId, setContainerTypeId] = useState(initial?.container_type_id || (containerTypes[0]?.id || ''));
  const [manufacturerId, setManufacturerId] = useState(initial?.manufacturer_id || '');
  const [orderDate, setOrderDate] = useState(initial?.order_date || todayPlus(0));
  const [etaDate, setEtaDate] = useState(initial?.eta_date || todayPlus(90));
  const [status, setStatus] = useState(initial?.status || 'ORDERED');
  const [notes, setNotes] = useState(initial?.notes || '');
  const [items, setItems] = useState(
    initial?.items?.map(i => ({ sku: i.sku, quantity: i.quantity, unit_cost: i.unit_cost?.toString() || '' })) 
    || [{ sku: '', quantity: '', unit_cost: '' }]
  );

  const containerType = containerTypes.find(t => t.id === parseInt(containerTypeId));
  const capacity = containerType?.capacity_cbm || 0;
  const totalCbm = items.reduce((s, item) => {
    const product = products.find(p => p.sku === item.sku);
    return s + ((product?.cbm_per_unit || 0) * (parseInt(item.quantity) || 0));
  }, 0);
  const fillPct = capacity > 0 ? (totalCbm / capacity) * 100 : 0;
  
  const sortedProducts = useMemo(() => {
    if (!manufacturerId) return products;
    const mfrId = parseInt(manufacturerId);
    return [...products].sort((a, b) => {
      const aMatch = a.manufacturer_id === mfrId ? 0 : 1;
      const bMatch = b.manufacturer_id === mfrId ? 0 : 1;
      return aMatch - bMatch || a.sku.localeCompare(b.sku);
    });
  }, [products, manufacturerId]);

  const addItem = () => setItems([...items, { sku: '', quantity: '', unit_cost: '' }]);
  const removeItem = (idx) => setItems(items.filter((_, i) => i !== idx));
  const updateItem = (idx, field, value) => {
    const next = [...items];
    next[idx] = { ...next[idx], [field]: value };
    if (field === 'sku' && value) {
      const product = products.find(p => p.sku === value);
      if (product && (!next[idx].unit_cost || next[idx].unit_cost === '')) {
        next[idx].unit_cost = product.purchase_price > 0 ? product.purchase_price.toString() : '';
      }
    }
    setItems(next);
  };

  const handleSave = async () => {
    if (!containerNumber.trim()) { alert('Podaj numer kontenera'); return; }
    if (new Date(etaDate) < new Date(orderDate)) { alert('ETA nie może być przed datą zamówienia'); return; }
    const validItems = items.filter(i => i.sku && parseInt(i.quantity) > 0).map(i => ({
      sku: i.sku, quantity: parseInt(i.quantity), unit_cost: i.unit_cost ? parseFloat(i.unit_cost) : null,
    }));
    if (validItems.length === 0) { alert('Dodaj przynajmniej jedną pozycję'); return; }
    try {
      await onSave({
        container_number: containerNumber.trim(),
        order_number: orderNumber.trim() || null,
        container_type_id: parseInt(containerTypeId) || null,
        manufacturer_id: parseInt(manufacturerId) || null,
        order_date: orderDate, eta_date: etaDate, status,
        notes: notes.trim() || null, items: validItems,
      });
    } catch (e) { alert('Błąd zapisu: ' + e.message); }
  };

  const handleAddAttachment = async () => {
    const fileName = prompt('Nazwa załącznika (np. proforma_2026.pdf):');
    if (!fileName || !fileName.trim()) return;
    const ext = fileName.split('.').pop().toLowerCase();
    const fileType = ext === 'pdf' ? 'pdf' : (ext === 'xlsx' || ext === 'xls') ? 'excel' : 'other';
    if (onAddAttachment) {
      try { await onAddAttachment({ filename: fileName.trim(), file_type: fileType, file_size: 'N/A' }); }
      catch (e) { alert(e.message); }
    }
  };

  const fillColor = fillPct > 100 ? 'bg-red-500' : fillPct > 90 ? 'bg-amber-500' : fillPct > 70 ? 'bg-emerald-500' : 'bg-blue-500';
  const carrier = getCarrier(containerNumber);

  return (
    <div className="fixed inset-0 bg-stone-900/70 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="bg-stone-900 text-white p-5 flex items-center justify-between">
          <div className="flex items-center gap-3"><Ship className="w-6 h-6 text-amber-400" /><h2 className="text-xl font-bold">{initial ? 'Edytuj kontener' : 'Nowy kontener'}</h2></div>
          <button onClick={onClose} className="p-2 hover:bg-stone-800 rounded-lg"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-stone-600 mb-1">Nr kontenera *</label>
              <input type="text" value={containerNumber} onChange={(e) => setContainerNumber(e.target.value)} placeholder="np. MSCU-7821934" className="w-full px-3 py-2 border-2 border-stone-200 rounded-lg font-mono" />
              {carrier && <div className="text-xs text-blue-600 mt-1">🛰️ Wykryto: <strong>{carrier.name}</strong></div>}
            </div>
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-stone-600 mb-1">Nr zamówienia</label>
              <input type="text" value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} placeholder="np. PO-2026-001" className="w-full px-3 py-2 border-2 border-stone-200 rounded-lg font-mono" />
            </div>
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-stone-600 mb-1">Typ</label>
              <select value={containerTypeId} onChange={(e) => setContainerTypeId(e.target.value)} className="w-full px-3 py-2 border-2 border-stone-200 rounded-lg bg-white">
                <option value="">— wybierz —</option>
                {containerTypes.map(t => <option key={t.id} value={t.id}>{t.name} ({t.capacity_cbm} m³)</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-stone-600 mb-1">Producent</label>
              <select value={manufacturerId} onChange={(e) => setManufacturerId(e.target.value)} className="w-full px-3 py-2 border-2 border-stone-200 rounded-lg bg-white">
                <option value="">— wybierz —</option>
                {manufacturers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-stone-600 mb-1">Data zamówienia *</label>
              <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} className="w-full px-3 py-2 border-2 border-stone-200 rounded-lg" />
            </div>
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-stone-600 mb-1">ETA *</label>
              <input type="date" value={etaDate} onChange={(e) => setEtaDate(e.target.value)} className="w-full px-3 py-2 border-2 border-stone-200 rounded-lg" />
            </div>
          </div>
          
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-stone-600 mb-2">Status</label>
            <div className="grid grid-cols-4 gap-2">
              {Object.entries(CONTAINER_STATUS_CONFIG).map(([key, cfg]) => {
                const Icon = cfg.icon;
                return <button key={key} onClick={() => setStatus(key)} type="button" className={`px-2 py-2 rounded-lg text-xs font-bold uppercase flex items-center justify-center gap-1 ${status === key ? `${cfg.bg} ${cfg.text}` : 'bg-stone-100 text-stone-600'}`}><Icon className="w-3 h-3" />{cfg.label}</button>;
              })}
            </div>
          </div>
          
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-stone-600 mb-2">Notatki</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="w-full px-3 py-2 border-2 border-stone-200 rounded-lg resize-none" />
          </div>

          {initial && (
            <div className="border-2 border-dashed border-stone-300 rounded-lg p-4">
              <div className="flex justify-between items-center mb-2">
                <label className="text-xs font-bold uppercase tracking-wider text-stone-600 flex items-center gap-1">
                  <Paperclip className="w-3 h-3" />Załączniki ({initial.attachments?.length || 0})
                </label>
                <button onClick={handleAddAttachment} type="button" className="text-xs font-bold text-amber-700 flex items-center gap-1">
                  <Plus className="w-3 h-3" />Dodaj plik
                </button>
              </div>
              <div className="space-y-1">
                {(initial.attachments || []).map(att => (
                  <div key={att.id} className="flex items-center gap-2 bg-stone-50 px-3 py-2 rounded">
                    <Paperclip className="w-4 h-4 text-stone-500" />
                    <span className="text-sm font-mono flex-1 truncate">{att.filename}</span>
                    <span className="text-xs text-stone-400">{att.file_type}</span>
                    <button onClick={() => onDeleteAttachment(att.id)} type="button" className="text-red-600 hover:bg-red-50 p-1 rounded">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                {(!initial.attachments || initial.attachments.length === 0) && (
                  <div className="text-xs text-stone-400 text-center py-2">Brak załączników</div>
                )}
              </div>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-bold uppercase tracking-wider text-stone-600">Produkty *</label>
              <button onClick={addItem} type="button" className="text-xs font-bold text-amber-700 flex items-center gap-1"><Plus className="w-3 h-3" />Dodaj</button>
            </div>
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {items.map((item, idx) => {
                const product = products.find(p => p.sku === item.sku);
                const itemCbm = (product?.cbm_per_unit || 0) * (parseInt(item.quantity) || 0);
                const isMixed = manufacturerId && product?.manufacturer_id && product.manufacturer_id !== parseInt(manufacturerId);
                return (
                  <div key={idx} className={`flex gap-2 items-start p-2 rounded-lg ${isMixed ? 'bg-amber-50 border-2 border-amber-300' : 'bg-stone-50'}`}>
                    <div className="flex-1">
                      <select value={item.sku} onChange={(e) => updateItem(idx, 'sku', e.target.value)} className="w-full px-2 py-2 border-2 border-stone-200 rounded-lg text-sm bg-white">
                        <option value="">— wybierz produkt —</option>
                        {sortedProducts.map(p => <option key={p.sku} value={p.sku}>{p.sku} - {p.name} {p.manufacturer_name ? `[${p.manufacturer_name}]` : ''} {p.cbm_per_unit > 0 ? `· ${p.cbm_per_unit}m³` : ''}</option>)}
                      </select>
                      {isMixed && <div className="text-[11px] text-amber-700 font-bold mt-1">⚠ Inna firma niż kontener ({product.manufacturer_name})</div>}
                      {item.sku && itemCbm > 0 && <div className="text-[11px] text-stone-500 mt-1 tabular-nums">Zajmie: <strong>{itemCbm.toFixed(3)} m³</strong></div>}
                    </div>
                    <input type="number" value={item.quantity} onChange={(e) => updateItem(idx, 'quantity', e.target.value)} placeholder="Ilość" min="1" className="w-20 px-2 py-2 border-2 border-stone-200 rounded-lg text-sm tabular-nums" />
                    <input type="number" value={item.unit_cost} onChange={(e) => updateItem(idx, 'unit_cost', e.target.value)} placeholder="Cena" step="0.01" className="w-20 px-2 py-2 border-2 border-stone-200 rounded-lg text-sm tabular-nums" title={product ? `Z Subiekta: ${product.purchase_price} zł` : ''} />
                    <button onClick={() => removeItem(idx)} type="button" className="p-2 text-red-600 hover:bg-red-50 rounded-lg"><Trash2 className="w-4 h-4" /></button>
                  </div>
                );
              })}
            </div>
            <p className="text-[11px] text-stone-500 mt-1">💡 Cena auto-wypełniana z Subiekta. Możesz zmienić.</p>
            
            {capacity > 0 && (
              <div className="mt-4 p-4 bg-gradient-to-br from-stone-100 to-stone-50 border-2 border-stone-200 rounded-xl">
                <div className="flex justify-between text-sm mb-2">
                  <span className="font-bold text-stone-700 flex items-center gap-1"><Box className="w-4 h-4" />Wypełnienie</span>
                  <span className={`font-bold tabular-nums text-lg ${fillPct > 100 ? 'text-red-600' : fillPct > 90 ? 'text-amber-600' : 'text-stone-700'}`}>{totalCbm.toFixed(3)} / {capacity} m³</span>
                </div>
                <div className="h-5 bg-stone-200 rounded-full overflow-hidden relative">
                  <div className={`h-full ${fillColor}`} style={{ width: `${Math.min(100, fillPct)}%` }}></div>
                  <div className="absolute inset-0 flex items-center justify-center text-xs font-bold text-white drop-shadow">{fillPct.toFixed(0)}%</div>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="bg-stone-50 px-6 py-4 flex justify-between items-center border-t border-stone-200">
          <div>{initial && onDelete && <button onClick={onDelete} className="text-red-600 text-sm font-bold flex items-center gap-1"><Trash2 className="w-4 h-4" />Usuń</button>}</div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 bg-stone-200 rounded-lg font-bold">Anuluj</button>
            <button onClick={handleSave} className="px-6 py-2 bg-amber-500 text-stone-900 rounded-lg font-bold">{initial ? 'Zapisz' : 'Utwórz'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ImportModal({ onClose, onImported }) {
  const [step, setStep] = useState(1);
  const [csvText, setCsvText] = useState('');
  const [parsedRows, setParsedRows] = useState([]);
  const [result, setResult] = useState(null);

  const exampleCsv = `sku;cbm;manufacturer_name;lead_time_days;seasonality_enabled
Fsb;0.05;Anji;90;false
Szp1;0.08;Fosoto;75;true`;

  const parseCsv = () => {
    try {
      const lines = csvText.split('\n').filter(l => l.trim());
      if (lines.length < 2) { alert('Plik musi mieć nagłówek + min 1 wiersz'); return; }
      const sep = lines[0].includes(';') ? ';' : ',';
      const headers = lines[0].split(sep).map(h => h.trim().toLowerCase());
      const skuIdx = headers.findIndex(h => h === 'sku' || h === 'symbol');
      const cbmIdx = headers.findIndex(h => h === 'cbm' || h === 'cbm_per_unit');
      const mfrIdx = headers.findIndex(h => h.includes('manufacturer') || h === 'producent');
      const ltIdx = headers.findIndex(h => h.includes('lead') || h === 'lead_time_days');
      const seasIdx = headers.findIndex(h => h.includes('season'));
      
      if (skuIdx === -1) { alert('Nie znaleziono kolumny "sku"'); return; }
      
      const rows = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(sep).map(c => c.trim());
        const row = { sku: cols[skuIdx] };
        if (cbmIdx >= 0 && cols[cbmIdx]) row.cbm = parseFloat(cols[cbmIdx].replace(',', '.'));
        if (mfrIdx >= 0 && cols[mfrIdx]) row.manufacturer_name = cols[mfrIdx];
        if (ltIdx >= 0 && cols[ltIdx]) row.lead_time_days = parseInt(cols[ltIdx]);
        if (seasIdx >= 0 && cols[seasIdx]) row.seasonality_enabled = ['true', 'tak', '1', 'yes'].includes(cols[seasIdx].toLowerCase());
        if (row.sku) rows.push(row);
      }
      setParsedRows(rows);
      setStep(2);
    } catch (e) { alert('Błąd parsowania: ' + e.message); }
  };

  const doImport = async () => {
    try {
      const res = await api.post('/products/import', parsedRows);
      setResult(res);
      setStep(3);
      await onImported();
    } catch (e) { alert('Błąd importu: ' + e.message); }
  };

  return (
    <div className="fixed inset-0 bg-stone-900/70 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="bg-stone-900 text-white p-5 flex items-center justify-between">
          <div className="flex items-center gap-2"><Upload className="w-6 h-6 text-amber-400" /><h2 className="text-xl font-bold">Import atrybutów produktów</h2></div>
          <button onClick={onClose} className="p-2 hover:bg-stone-800 rounded"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-6">
          <div className="flex items-center mb-6 text-xs">
            {[1,2,3].map(s => (
              <div key={s} className="flex items-center flex-1">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold ${step >= s ? 'bg-amber-500 text-stone-900' : 'bg-stone-200 text-stone-500'}`}>{s}</div>
                {s < 3 && <div className={`flex-1 h-1 ${step > s ? 'bg-amber-500' : 'bg-stone-200'}`}></div>}
              </div>
            ))}
          </div>

          {step === 1 && (
            <div>
              <h3 className="font-bold mb-3">1. Wklej dane CSV</h3>
              <p className="text-sm text-stone-600 mb-2">Format: średnik (;) lub przecinek (,) jako separator. Pierwsza linia to nagłówek.</p>
              <p className="text-xs text-stone-500 mb-3">Wymagana kolumna: <code>sku</code>. Opcjonalne: <code>cbm</code>, <code>manufacturer_name</code>, <code>lead_time_days</code>, <code>seasonality_enabled</code>.</p>
              <textarea value={csvText} onChange={(e) => setCsvText(e.target.value)}
                rows={10} placeholder={exampleCsv}
                className="w-full px-3 py-2 border-2 border-stone-200 rounded-lg font-mono text-xs" />
              <div className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded text-xs text-blue-900">
                💡 <strong>Tip:</strong> w Excelu zaznacz dane → Ctrl+C, wklej tutaj. Nieznani producenci utworzą się automatycznie.
              </div>
              <button onClick={() => setCsvText(exampleCsv)} className="mt-3 text-xs text-amber-700 font-bold">Wstaw przykład</button>
              <button onClick={parseCsv} disabled={!csvText.trim()} className="mt-4 w-full py-3 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-stone-900 rounded-lg font-bold">Dalej →</button>
            </div>
          )}

          {step === 2 && (
            <div>
              <h3 className="font-bold mb-3">2. Sprawdź dane ({parsedRows.length} wierszy)</h3>
              <div className="max-h-72 overflow-y-auto bg-stone-50 rounded-lg p-3">
                <table className="w-full text-xs">
                  <thead className="font-bold">
                    <tr><th className="text-left p-1">SKU</th><th className="text-right p-1">CBM</th><th className="text-left p-1">Producent</th><th className="text-right p-1">LT</th><th className="text-center p-1">Sezon</th></tr>
                  </thead>
                  <tbody>
                    {parsedRows.slice(0, 50).map((r, i) => (
                      <tr key={i} className="border-t border-stone-200">
                        <td className="p-1 font-mono">{r.sku}</td>
                        <td className="p-1 text-right">{r.cbm || '—'}</td>
                        <td className="p-1">{r.manufacturer_name || '—'}</td>
                        <td className="p-1 text-right">{r.lead_time_days || '—'}</td>
                        <td className="p-1 text-center">{r.seasonality_enabled ? '✓' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {parsedRows.length > 50 && <div className="text-center text-stone-500 mt-2">...i {parsedRows.length - 50} więcej</div>}
              </div>
              <div className="flex gap-2 mt-4">
                <button onClick={() => setStep(1)} className="flex-1 py-3 bg-stone-200 rounded-lg font-bold">← Wstecz</button>
                <button onClick={doImport} className="flex-1 py-3 bg-emerald-600 text-white rounded-lg font-bold">Importuj {parsedRows.length} wierszy</button>
              </div>
            </div>
          )}

          {step === 3 && result && (
            <div>
              <div className="bg-emerald-50 border border-emerald-200 p-4 rounded-lg mb-4">
                <div className="font-bold text-emerald-900">✓ Import zakończony</div>
                <div className="text-sm text-emerald-800 mt-1">{result.updated} zaktualizowanych, {result.skipped} pominiętych z {result.total}</div>
              </div>
              {result.errors && result.errors.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 p-3 rounded-lg mb-4 max-h-40 overflow-y-auto">
                  <div className="font-bold text-amber-900 text-sm mb-1">Pomijane:</div>
                  {result.errors.map((e, i) => <div key={i} className="text-xs text-amber-800">{e}</div>)}
                </div>
              )}
              <button onClick={onClose} className="w-full py-3 bg-amber-500 text-stone-900 rounded-lg font-bold">Zamknij</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EanModal({ onClose, onProductFound }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (query.length < 2) { setResults([]); return; }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await api.get(`/search/ean?q=${encodeURIComponent(query)}`);
        setResults(r);
      } catch (e) { console.error(e); }
      finally { setSearching(false); }
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div className="fixed inset-0 bg-stone-900/70 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-lg w-full max-h-[80vh] overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="bg-stone-900 text-white p-5 flex items-center justify-between">
          <div className="flex items-center gap-2"><ScanLine className="w-6 h-6 text-amber-400" /><h2 className="text-xl font-bold">Wyszukiwarka EAN/SKU</h2></div>
          <button onClick={onClose} className="p-2 hover:bg-stone-800 rounded"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5">
          <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus
            placeholder="Wpisz EAN lub SKU..."
            className="w-full px-4 py-3 border-2 border-stone-200 rounded-lg focus:border-amber-500 focus:outline-none font-mono mb-3" />
          {searching && <div className="text-center text-stone-400 py-2">Szukanie...</div>}
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {!searching && query.length >= 2 && results.length === 0 && (
              <div className="text-center text-stone-400 py-4">Brak wyników</div>
            )}
            {results.map((r, i) => (
              <button key={i} onClick={() => onProductFound(r.sku)} className="w-full p-3 bg-stone-50 hover:bg-amber-50 rounded-lg text-left transition">
                <div className="flex justify-between items-start">
                  <div className="min-w-0 flex-1">
                    <div className="font-mono font-bold text-sm">{r.sku}</div>
                    <div className="text-sm text-stone-700 truncate">{r.name}</div>
                    {r.ean && <div className="text-xs text-stone-500 font-mono">EAN: {r.ean}</div>}
                  </div>
                  <div className="text-right ml-2">
                    <div className="font-bold tabular-nums">{r.stock || 0} szt</div>
                    <div className="text-xs text-stone-500">stan</div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}


// ============================================================
// WYKRES WARTOŚCI MAGAZYNU - styl giełdowy (linia + gradient)
// ============================================================
function StockValueChart({ points, positive }) {
  if (!points || points.length === 0) return null;
  const maxVal = Math.max(...points.map(p => p.value), 1);
  const minVal = Math.min(...points.map(p => p.value), 0);
  const range = Math.max(maxVal - minVal, 1);
  const w = points.length;
  const h = 100;
  
  // Punkty wykresu (skalowane do viewBox)
  const chartPoints = points.map((p, i) => ({
    x: (i / (w - 1)) * 100,
    y: h - 5 - ((p.value - minVal) / range) * (h - 10),
    value: p.value,
    date: p.date,
  }));
  
  const linePath = chartPoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const areaPath = `${linePath} L 100 ${h} L 0 ${h} Z`;
  
  const color = positive ? '#10b981' : '#ef4444';
  const gradId = positive ? 'pos-grad' : 'neg-grad';
  
  return (
    <div className="relative w-full h-full">
      <svg className="w-full h-full" viewBox={`0 0 100 ${h}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.4" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Siatka pozioma */}
        {[25, 50, 75].map(y => (
          <line key={y} x1="0" y1={y} x2="100" y2={y} stroke="#e7e5e4" strokeWidth="0.15" strokeDasharray="0.5,0.5" />
        ))}
        {/* Wypełnienie pod linią */}
        <path d={areaPath} fill={`url(#${gradId})`} />
        {/* Linia */}
        <path d={linePath} fill="none" stroke={color} strokeWidth="0.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="absolute top-1 right-2 text-[10px] text-stone-400 tabular-nums font-mono">{fmtPLN(maxVal)}</div>
      <div className="absolute bottom-1 right-2 text-[10px] text-stone-400 tabular-nums font-mono">{fmtPLN(minVal)}</div>
    </div>
  );
}


// ============================================================
// GLOBALNA WYSZUKIWARKA (Ctrl+K)
// ============================================================
function GlobalSearchModal({ onClose, onProductFound, onContainerFound, onManufacturerFound }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  
  useEffect(() => {
    if (query.length < 2) { setResults(null); return; }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await api.get(`/search/global?q=${encodeURIComponent(query)}`);
        setResults(r);
      } catch (e) { console.error(e); }
      finally { setSearching(false); }
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div className="fixed inset-0 bg-stone-900/70 backdrop-blur-sm flex items-start justify-center p-4 pt-20 z-50" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-2xl w-full shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-stone-200 px-4 py-3 flex items-center gap-3">
          <Search className="w-5 h-5 text-stone-400" />
          <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus
            placeholder="Szukaj wszędzie: SKU, nazwa, EAN, producent, kontener..."
            className="flex-1 outline-none text-lg" />
          <kbd className="text-xs bg-stone-100 px-2 py-1 rounded font-mono text-stone-500">ESC</kbd>
        </div>
        
        {query.length < 2 && (
          <div className="p-8 text-center text-stone-400">
            <Search className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Wpisz min. 2 znaki...</p>
            <p className="text-xs mt-2">Szukaj po: SKU, nazwie produktu, EAN, producencie, numerze kontenera</p>
          </div>
        )}
        
        {searching && <div className="p-6 text-center text-stone-400 text-sm">Szukanie...</div>}
        
        {!searching && results && (
          <div className="max-h-[60vh] overflow-y-auto">
            {results.total === 0 && (
              <div className="p-8 text-center text-stone-400 text-sm">
                Brak wyników dla <strong>"{query}"</strong>
              </div>
            )}
            
            {/* Produkty */}
            {results.products && results.products.length > 0 && (
              <div>
                <div className="bg-stone-50 px-4 py-2 text-xs font-bold uppercase text-stone-500 tracking-wider sticky top-0">
                  📦 Produkty ({results.products.length})
                </div>
                {results.products.map((p, i) => (
                  <button key={i} onClick={() => onProductFound(p.sku)} className="w-full px-4 py-2 hover:bg-amber-50 text-left flex items-center gap-3 border-b border-stone-100">
                    <span className="font-mono font-bold text-sm">{p.sku}</span>
                    <span className="text-sm text-stone-700 flex-1 truncate">{p.name}</span>
                    {p.manufacturer_name && <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase text-white" style={{ backgroundColor: p.manufacturer_color || '#6b7280' }}>{p.manufacturer_name}</span>}
                    <span className="text-xs text-stone-500 tabular-nums">stan: {p.stock}</span>
                  </button>
                ))}
              </div>
            )}
            
            {/* EAN */}
            {results.ean && results.ean.length > 0 && (
              <div>
                <div className="bg-stone-50 px-4 py-2 text-xs font-bold uppercase text-stone-500 tracking-wider sticky top-0">
                  📷 EAN ({results.ean.length})
                </div>
                {results.ean.map((p, i) => (
                  <button key={i} onClick={() => onProductFound(p.sku)} className="w-full px-4 py-2 hover:bg-amber-50 text-left flex items-center gap-3 border-b border-stone-100">
                    <span className="font-mono font-bold text-sm">{p.sku}</span>
                    <span className="text-sm text-stone-700 flex-1 truncate">{p.name || '—'}</span>
                    <span className="text-xs text-stone-500 font-mono">EAN: {p.ean}</span>
                  </button>
                ))}
              </div>
            )}
            
            {/* Kontenery */}
            {results.containers && results.containers.length > 0 && (
              <div>
                <div className="bg-stone-50 px-4 py-2 text-xs font-bold uppercase text-stone-500 tracking-wider sticky top-0">
                  🚢 Kontenery ({results.containers.length})
                </div>
                {results.containers.map((c, i) => (
                  <button key={i} onClick={() => onContainerFound(c.id)} className="w-full px-4 py-2 hover:bg-blue-50 text-left flex items-center gap-3 border-b border-stone-100">
                    <Ship className="w-4 h-4 text-blue-600" />
                    <span className="font-mono font-bold text-sm">#{c.container_number}</span>
                    {c.order_number && <span className="text-xs text-stone-500 font-mono">PO: {c.order_number}</span>}
                    {c.manufacturer_name && <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase text-white" style={{ backgroundColor: c.manufacturer_color || '#6b7280' }}>{c.manufacturer_name}</span>}
                    <span className="flex-1 text-right text-xs text-stone-500">ETA: {new Date(c.eta_date).toLocaleDateString('pl-PL')}</span>
                  </button>
                ))}
              </div>
            )}
            
            {/* Producenci */}
            {results.manufacturers && results.manufacturers.length > 0 && (
              <div>
                <div className="bg-stone-50 px-4 py-2 text-xs font-bold uppercase text-stone-500 tracking-wider sticky top-0">
                  🏭 Producenci ({results.manufacturers.length})
                </div>
                {results.manufacturers.map((m, i) => (
                  <button key={i} onClick={() => onManufacturerFound(m.id)} className="w-full px-4 py-2 hover:bg-stone-50 text-left flex items-center gap-3 border-b border-stone-100">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: m.color || '#6b7280' }}></div>
                    <span className="font-bold text-sm">{m.name}</span>
                    {m.email && <span className="text-xs text-stone-500">{m.email}</span>}
                    <span className="flex-1 text-right text-xs text-stone-400">→ Ustawienia</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        
        <div className="border-t border-stone-100 px-4 py-2 text-xs text-stone-400 flex justify-between">
          <span>💡 Skrót: <kbd className="bg-stone-100 px-1 rounded">Ctrl+K</kbd> otwiera wyszukiwarkę</span>
          {results && <span>{results.total} wyników</span>}
        </div>
      </div>
    </div>
  );
}


// ============================================================
// AUTO-SUGESTIA KONTENERA
// ============================================================
function AutoSuggestModal({ manufacturers, containerTypes, onClose, onCreate }) {
  const [step, setStep] = useState(1);
  const [manufacturerId, setManufacturerId] = useState('');
  const [containerTypeId, setContainerTypeId] = useState(containerTypes[0]?.id || '');
  const [monthsHorizon, setMonthsHorizon] = useState(6);
  const [suggestion, setSuggestion] = useState(null);
  const [loading, setLoading] = useState(false);
  
  // Pola do utworzenia kontenera w kroku 3
  const [containerNumber, setContainerNumber] = useState('');
  const [orderNumber, setOrderNumber] = useState('');
  const [orderDate, setOrderDate] = useState(todayPlus(0));
  const [etaDate, setEtaDate] = useState(todayPlus(90));

  const generate = async () => {
    if (!manufacturerId || !containerTypeId) { alert('Wybierz producenta i typ'); return; }
    setLoading(true);
    try {
      const res = await api.post('/auto-suggest', {
        manufacturer_id: parseInt(manufacturerId),
        container_type_id: parseInt(containerTypeId),
        months_horizon: monthsHorizon,
      });
      setSuggestion(res);
      setStep(2);
    } catch (e) { alert('Błąd: ' + e.message); }
    finally { setLoading(false); }
  };

  const createContainer = async () => {
    if (!containerNumber.trim()) { alert('Podaj numer kontenera'); return; }
    if (!suggestion || suggestion.items.length === 0) { alert('Brak produktów'); return; }
    try {
      await onCreate({
        container_number: containerNumber.trim(),
        order_number: orderNumber.trim() || null,
        container_type_id: parseInt(containerTypeId),
        manufacturer_id: parseInt(manufacturerId),
        order_date: orderDate, eta_date: etaDate,
        status: 'ORDERED',
        notes: `Wygenerowane automatycznie. Horyzont: ${monthsHorizon} mies. Wypełnienie: ${suggestion.fill_pct}%`,
        items: suggestion.items.map(i => ({ sku: i.sku, quantity: i.quantity, unit_cost: i.unit_cost })),
      });
    } catch (e) { alert('Błąd: ' + e.message); }
  };

  const updateItemQty = (idx, newQty) => {
    const next = { ...suggestion };
    const oldQty = next.items[idx].quantity || 1;
    // Wyciągamy cbm_per_unit z istniejącego total_cbm / oldQty
    const cbmPerUnit = oldQty > 0 ? next.items[idx].cbm_total / oldQty : 0;
    const q = parseInt(newQty) || 0;
    next.items[idx].quantity = q;
    next.items[idx].cbm_total = parseFloat((q * cbmPerUnit).toFixed(3));
    
    // Przelicz wszystkie sumy
    next.total_units = next.items.reduce((s, i) => s + i.quantity, 0);
    next.total_value = parseFloat(next.items.reduce((s, i) => s + i.quantity * i.unit_cost, 0).toFixed(2));
    next.total_cbm = parseFloat(next.items.reduce((s, i) => s + i.cbm_total, 0).toFixed(3));
    next.fill_pct = parseFloat(((next.total_cbm / next.capacity_cbm) * 100).toFixed(1));
    setSuggestion(next);
  };

  const removeItem = (idx) => {
    const next = { ...suggestion };
    next.items = next.items.filter((_, i) => i !== idx);
    next.total_units = next.items.reduce((s, i) => s + i.quantity, 0);
    next.total_value = parseFloat(next.items.reduce((s, i) => s + i.quantity * i.unit_cost, 0).toFixed(2));
    next.total_cbm = parseFloat(next.items.reduce((s, i) => s + i.cbm_total, 0).toFixed(3));
    next.fill_pct = parseFloat(((next.total_cbm / next.capacity_cbm) * 100).toFixed(1));
    setSuggestion(next);
  };

  const fillColor = suggestion && suggestion.fill_pct > 100 ? 'bg-red-500' : suggestion && suggestion.fill_pct > 90 ? 'bg-amber-500' : suggestion && suggestion.fill_pct > 70 ? 'bg-emerald-500' : 'bg-blue-500';

  return (
    <div className="fixed inset-0 bg-stone-900/70 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="bg-gradient-to-r from-purple-600 to-purple-800 text-white p-5 flex items-center justify-between">
          <div className="flex items-center gap-3"><Wand2 className="w-6 h-6" /><h2 className="text-xl font-bold">Auto-sugestia kontenera</h2></div>
          <button onClick={onClose} className="p-2 hover:bg-black/20 rounded-lg"><X className="w-5 h-5" /></button>
        </div>
        
        <div className="p-6">
          <div className="flex items-center mb-6 text-xs">
            {[1, 2, 3].map(s => (
              <div key={s} className="flex items-center flex-1">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold ${step >= s ? 'bg-purple-600 text-white' : 'bg-stone-200 text-stone-500'}`}>{s}</div>
                {s < 3 && <div className={`flex-1 h-1 ${step > s ? 'bg-purple-600' : 'bg-stone-200'}`}></div>}
              </div>
            ))}
          </div>

          {step === 1 && (
            <div className="space-y-4">
              <h3 className="font-bold mb-3">1. Parametry sugestii</h3>
              <p className="text-sm text-stone-600 mb-4">
                Aplikacja sama dobierze produkty od wybranego producenta tak, żeby optymalnie wypełnić kontener.
              </p>
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-stone-600 mb-1">Producent *</label>
                <select value={manufacturerId} onChange={(e) => setManufacturerId(e.target.value)} className="w-full px-3 py-2 border-2 border-stone-200 rounded-lg bg-white">
                  <option value="">— wybierz —</option>
                  {manufacturers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-stone-600 mb-1">Typ kontenera *</label>
                <select value={containerTypeId} onChange={(e) => setContainerTypeId(e.target.value)} className="w-full px-3 py-2 border-2 border-stone-200 rounded-lg bg-white">
                  {containerTypes.map(t => <option key={t.id} value={t.id}>{t.name} ({t.capacity_cbm} m³)</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-stone-600 mb-1">Horyzont planowania: <strong>{monthsHorizon} mies.</strong></label>
                <input type="range" min="3" max="12" value={monthsHorizon} onChange={(e) => setMonthsHorizon(parseInt(e.target.value))} className="w-full accent-purple-600" />
                <div className="flex justify-between text-xs text-stone-500 mt-1">
                  <span>3 mies (na pewno)</span>
                  <span>12 mies (bezpiecznie)</span>
                </div>
                <p className="text-xs text-stone-500 mt-1">💡 Algorytm liczy: śr. miesięczna sprzedaż × {monthsHorizon} - obecny stan - to co już w drodze</p>
              </div>
              <button onClick={generate} disabled={!manufacturerId || loading} 
                className="w-full py-3 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg font-bold flex items-center justify-center gap-2">
                {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                {loading ? 'Generuję...' : 'Wygeneruj sugestię'}
              </button>
            </div>
          )}

          {step === 2 && suggestion && (
            <div className="space-y-4">
              <h3 className="font-bold mb-3">2. Sugestia ({suggestion.items.length} produktów)</h3>
              
              {suggestion.items.length === 0 ? (
                <div className="bg-amber-50 border border-amber-200 p-4 rounded-lg text-center">
                  <p className="text-amber-900 font-bold">Brak produktów do zamówienia</p>
                  <p className="text-sm text-amber-700 mt-1">Ten producent nie ma produktów wymagających uzupełnienia w horyzoncie {monthsHorizon} miesięcy.</p>
                </div>
              ) : (
                <>
                  <div className="bg-purple-50 border border-purple-200 rounded-lg p-3">
                    <div className="grid grid-cols-3 gap-3 text-center">
                      <div>
                        <div className="text-xs text-purple-700 font-bold uppercase">CBM</div>
                        <div className="text-lg font-bold tabular-nums">{suggestion.total_cbm} / {suggestion.capacity_cbm}</div>
                      </div>
                      <div>
                        <div className="text-xs text-purple-700 font-bold uppercase">Sztuk</div>
                        <div className="text-lg font-bold tabular-nums">{suggestion.total_units}</div>
                      </div>
                      <div>
                        <div className="text-xs text-purple-700 font-bold uppercase">Wartość</div>
                        <div className="text-lg font-bold tabular-nums">{fmtPLN(suggestion.total_value)}</div>
                      </div>
                    </div>
                    <div className="mt-2 h-3 bg-purple-200 rounded-full overflow-hidden">
                      <div className={`h-full ${fillColor}`} style={{ width: `${Math.min(100, suggestion.fill_pct)}%` }}></div>
                    </div>
                    <div className="text-center text-xs font-bold text-purple-900 mt-1">Wypełnienie: {suggestion.fill_pct}%</div>
                  </div>
                  
                  <div className="space-y-2 max-h-72 overflow-y-auto">
                    {suggestion.items.map((item, idx) => (
                      <div key={idx} className={`p-2 rounded-lg flex gap-2 items-center ${item.is_partial ? 'bg-amber-50 border border-amber-300' : 'bg-stone-50'}`}>
                        <div className="flex-1 min-w-0">
                          <div className="font-mono font-bold text-sm">{item.sku}</div>
                          <div className="text-xs text-stone-600 truncate">{item.name}</div>
                          {item.is_partial && <div className="text-[10px] text-amber-700 font-bold">⚠ Częściowo (więcej się nie zmieści)</div>}
                        </div>
                        <input type="number" value={item.quantity} onChange={(e) => updateItemQty(idx, e.target.value)} 
                          className="w-20 px-2 py-1 border-2 border-stone-200 rounded text-sm tabular-nums text-center" />
                        <div className="text-xs text-stone-500 text-right whitespace-nowrap">
                          <div>{item.cbm_total} m³</div>
                          <div>{fmtPLN(item.unit_cost * item.quantity)}</div>
                        </div>
                        <button onClick={() => removeItem(idx)} className="p-1 text-red-600 hover:bg-red-50 rounded">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}
              
              <div className="flex gap-2">
                <button onClick={() => setStep(1)} className="flex-1 py-2 bg-stone-200 rounded-lg font-bold">← Wstecz</button>
                {suggestion.items.length > 0 && (
                  <button onClick={() => setStep(3)} className="flex-1 py-2 bg-purple-600 text-white rounded-lg font-bold">Dalej: utwórz kontener →</button>
                )}
              </div>
            </div>
          )}

          {step === 3 && suggestion && (
            <div className="space-y-4">
              <h3 className="font-bold mb-3">3. Dane kontenera</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-stone-600 mb-1">Nr kontenera *</label>
                  <input type="text" value={containerNumber} onChange={(e) => setContainerNumber(e.target.value)} 
                    placeholder="np. MSCU-7821934" className="w-full px-3 py-2 border-2 border-stone-200 rounded-lg font-mono" autoFocus />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-stone-600 mb-1">Nr zamówienia</label>
                  <input type="text" value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} 
                    placeholder="np. PO-2026-001" className="w-full px-3 py-2 border-2 border-stone-200 rounded-lg font-mono" />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-stone-600 mb-1">Data zamówienia *</label>
                  <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} className="w-full px-3 py-2 border-2 border-stone-200 rounded-lg" />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-stone-600 mb-1">ETA *</label>
                  <input type="date" value={etaDate} onChange={(e) => setEtaDate(e.target.value)} className="w-full px-3 py-2 border-2 border-stone-200 rounded-lg" />
                </div>
              </div>
              
              <div className="bg-purple-50 border border-purple-200 rounded-lg p-3">
                <div className="text-sm font-bold text-purple-900">Podsumowanie:</div>
                <div className="text-xs text-purple-700 mt-1">
                  {suggestion.items.length} produktów · {suggestion.total_units} szt · {fmtPLN(suggestion.total_value)} · wypełnienie {suggestion.fill_pct}%
                </div>
              </div>
              
              <div className="flex gap-2">
                <button onClick={() => setStep(2)} className="flex-1 py-2 bg-stone-200 rounded-lg font-bold">← Wstecz</button>
                <button onClick={createContainer} className="flex-1 py-2 bg-emerald-600 text-white rounded-lg font-bold flex items-center justify-center gap-2">
                  <Plus className="w-4 h-4" />Utwórz kontener
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


// ============================================================
// SYMULATOR SCENARIUSZY - "co jeśli sprzedaż +30% / dostawa +30 dni"
// ============================================================
function SimulatorModal({ products, onClose }) {
  const [salesMultiplier, setSalesMultiplier] = useState(1.0);  // 1.0 = bez zmian
  const [deliveryDelay, setDeliveryDelay] = useState(0);  // dni opóźnienia

  // Symulujemy stan każdego produktu z nowymi parametrami
  const simulated = useMemo(() => {
    return products.map(p => {
      const newAvg = p.avg_monthly_weighted * salesMultiplier;
      const newDailySales = newAvg / 30;
      
      // Symulacja: stan + dostawy (z opóźnieniem) - sprzedaż
      let stock = p.stock;
      let daysUntilEmpty = 9999;
      
      if (newDailySales > 0) {
        // Mapa dostaw z opóźnieniem
        const eta_offsets = (p.incoming_deliveries || []).map(d => {
          const days = Math.floor((new Date(d.eta_date) - new Date()) / 86400000);
          return { offset: days + deliveryDelay, qty: d.quantity };
        });
        
        for (let i = 0; i < 730; i++) {
          // Dostawy w tym dniu
          eta_offsets.forEach(d => {
            if (d.offset === i) stock += d.qty;
          });
          stock -= newDailySales;
          if (stock <= 0) {
            daysUntilEmpty = i;
            break;
          }
        }
      }
      
      const orderDate_offset = daysUntilEmpty - p.lead_time_days;
      let newStatus;
      if (orderDate_offset <= 0 && daysUntilEmpty < p.lead_time_days) newStatus = 'KRYTYCZNY';
      else if (orderDate_offset <= 7) newStatus = 'ZAMOW_TERAZ';
      else if (orderDate_offset <= 30) newStatus = 'ZAMOW_WKROTCE';
      else newStatus = 'OK';
      
      return {
        ...p,
        sim_avg_monthly: newAvg,
        sim_days_until_empty: daysUntilEmpty,
        sim_status: newStatus,
        status_changed: newStatus !== p.status,
      };
    });
  }, [products, salesMultiplier, deliveryDelay]);

  // Statystyki: ile produktów ma jaki status PRZED i PO
  const statsBefore = useMemo(() => {
    const counts = { KRYTYCZNY: 0, ZAMOW_TERAZ: 0, ZAMOW_WKROTCE: 0, OK: 0 };
    products.forEach(p => { counts[p.status] = (counts[p.status] || 0) + 1; });
    return counts;
  }, [products]);

  const statsAfter = useMemo(() => {
    const counts = { KRYTYCZNY: 0, ZAMOW_TERAZ: 0, ZAMOW_WKROTCE: 0, OK: 0 };
    simulated.forEach(p => { counts[p.sim_status] = (counts[p.sim_status] || 0) + 1; });
    return counts;
  }, [simulated]);

  const newCritical = simulated.filter(p => 
    p.status_changed && (p.sim_status === 'KRYTYCZNY' || p.sim_status === 'ZAMOW_TERAZ')
    && p.avg_monthly_weighted >= 1
  ).sort((a, b) => b.sim_avg_monthly - a.sim_avg_monthly).slice(0, 15);

  const reset = () => { setSalesMultiplier(1.0); setDeliveryDelay(0); };
  const isChanged = salesMultiplier !== 1.0 || deliveryDelay !== 0;

  return (
    <div className="fixed inset-0 bg-stone-900/70 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-4xl w-full max-h-[92vh] overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="bg-gradient-to-r from-purple-600 to-purple-800 text-white p-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <FlaskConical className="w-6 h-6" />
            <div>
              <h2 className="text-xl font-bold">Symulator scenariuszy</h2>
              <p className="text-xs opacity-80">Co jeśli sprzedaż wzrośnie? Co jeśli dostawa się opóźni?</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-black/20 rounded-lg"><X className="w-5 h-5" /></button>
        </div>
        
        <div className="p-6 space-y-5">
          {/* Suwaki */}
          <div className="grid md:grid-cols-2 gap-4">
            <div className="bg-purple-50 border-2 border-purple-200 rounded-xl p-4">
              <label className="block text-sm font-bold text-purple-900 mb-2">
                📈 Mnożnik sprzedaży: <span className="text-2xl tabular-nums">{(salesMultiplier * 100).toFixed(0)}%</span>
              </label>
              <input type="range" min="0.5" max="2.0" step="0.1" value={salesMultiplier} 
                onChange={(e) => setSalesMultiplier(parseFloat(e.target.value))} 
                className="w-full accent-purple-600" />
              <div className="flex justify-between text-xs text-purple-700 mt-1">
                <span>50% (kryzys)</span>
                <span>100% (bez zmian)</span>
                <span>200% (boom)</span>
              </div>
            </div>
            
            <div className="bg-blue-50 border-2 border-blue-200 rounded-xl p-4">
              <label className="block text-sm font-bold text-blue-900 mb-2">
                ⏰ Opóźnienie dostaw: <span className="text-2xl tabular-nums">+{deliveryDelay} dni</span>
              </label>
              <input type="range" min="0" max="60" step="5" value={deliveryDelay} 
                onChange={(e) => setDeliveryDelay(parseInt(e.target.value))} 
                className="w-full accent-blue-600" />
              <div className="flex justify-between text-xs text-blue-700 mt-1">
                <span>na czas</span>
                <span>+30 dni</span>
                <span>+60 dni (dramat)</span>
              </div>
            </div>
          </div>
          
          {isChanged && (
            <button onClick={reset} className="text-sm text-stone-600 hover:text-stone-900 underline">
              ↺ Resetuj do bazowego scenariusza
            </button>
          )}

          {/* Porównanie statystyk */}
          <div>
            <h3 className="font-bold mb-3">Porównanie: bazowy vs symulowany</h3>
            <div className="grid grid-cols-4 gap-3">
              {[
                { key: 'KRYTYCZNY', color: 'red', label: 'KRYTYCZNY' },
                { key: 'ZAMOW_TERAZ', color: 'orange', label: 'ZAMÓW TERAZ' },
                { key: 'ZAMOW_WKROTCE', color: 'amber', label: 'ZAMÓW WKRÓTCE' },
                { key: 'OK', color: 'emerald', label: 'OK' },
              ].map(s => {
                const before = statsBefore[s.key] || 0;
                const after = statsAfter[s.key] || 0;
                const diff = after - before;
                return (
                  <div key={s.key} className={`bg-${s.color}-50 border-2 border-${s.color}-200 rounded-xl p-3 text-center`}>
                    <div className={`text-xs font-bold uppercase tracking-wider text-${s.color}-700`}>{s.label}</div>
                    <div className="flex items-baseline justify-center gap-2 mt-2">
                      <span className="text-3xl font-bold tabular-nums">{after}</span>
                      <span className="text-xs text-stone-500 line-through tabular-nums">{before}</span>
                    </div>
                    {diff !== 0 && (
                      <div className={`text-xs font-bold ${diff > 0 && (s.key === 'KRYTYCZNY' || s.key === 'ZAMOW_TERAZ') ? 'text-red-600' : diff > 0 ? 'text-emerald-600' : 'text-stone-500'}`}>
                        {diff > 0 ? '+' : ''}{diff}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Lista nowych krytycznych */}
          {isChanged && newCritical.length > 0 && (
            <div>
              <h3 className="font-bold mb-3 flex items-center gap-2">
                <AlertOctagon className="w-5 h-5 text-red-600" />
                Produkty które staną się problematyczne ({newCritical.length})
              </h3>
              <div className="bg-stone-50 rounded-xl border border-stone-200 max-h-72 overflow-y-auto">
                {newCritical.map(p => (
                  <div key={p.sku} className="px-4 py-2 flex items-center justify-between border-b border-stone-100 last:border-0">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${STATUS_CONFIG[p.sim_status]?.bg} ${STATUS_CONFIG[p.sim_status]?.text}`}>
                        {STATUS_CONFIG[p.sim_status]?.label}
                      </span>
                      <span className="font-mono font-bold text-sm">{p.sku}</span>
                      <span className="text-sm text-stone-600 truncate">{p.name}</span>
                    </div>
                    <div className="text-right text-xs whitespace-nowrap ml-2">
                      <div className="font-bold">{p.sim_avg_monthly.toFixed(1)}/mies · stan {p.stock}</div>
                      <div className="text-stone-500">koniec za {p.sim_days_until_empty}d <span className="line-through">({p.days_until_empty}d)</span></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          
          {isChanged && newCritical.length === 0 && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-center">
              <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-emerald-600" />
              <div className="font-bold text-emerald-900">Świetnie! Magazyn wytrzymałby ten scenariusz.</div>
              <div className="text-xs text-emerald-700 mt-1">Żaden produkt nie staje się dodatkowo krytyczny.</div>
            </div>
          )}

          {!isChanged && (
            <div className="bg-stone-50 border border-stone-200 rounded-xl p-6 text-center">
              <FlaskConical className="w-12 h-12 mx-auto mb-3 text-stone-400" />
              <div className="font-bold text-stone-700">Przesuń suwaki aby zobaczyć efekt</div>
              <div className="text-sm text-stone-500 mt-1">Symulacja policzy w czasie rzeczywistym.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


// ============================================================
// GENERATOR PDF ZAMÓWIENIA - Purchase Order
// ============================================================
function OrderPdfModal({ group, onClose }) {
  const [items, setItems] = useState(group.products.map(p => ({
    sku: p.sku,
    name: p.name,
    quantity: p.recommended_quantity,
    unit_cost: p.purchase_price || 0,
    selected: true,
  })));
  const [orderNumber, setOrderNumber] = useState(`PO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${(group.manufacturer_id || 0).toString().padStart(3, '0')}`);
  const [notes, setNotes] = useState('');
  const [generating, setGenerating] = useState(false);

  const updateItem = (idx, field, value) => {
    const next = [...items];
    if (field === 'quantity' || field === 'unit_cost') {
      next[idx][field] = parseFloat(value) || 0;
    } else {
      next[idx][field] = value;
    }
    setItems(next);
  };

  const removeItem = (idx) => setItems(items.filter((_, i) => i !== idx));
  const toggleSelected = (idx) => {
    const next = [...items];
    next[idx].selected = !next[idx].selected;
    setItems(next);
  };

  const selectedItems = items.filter(i => i.selected && i.quantity > 0);
  const totalValue = selectedItems.reduce((s, i) => s + i.quantity * i.unit_cost, 0);
  const totalUnits = selectedItems.reduce((s, i) => s + i.quantity, 0);

  // Generuje PDF używając wbudowanej funkcjonalności drukowania przeglądarki
  const generatePdf = () => {
    if (selectedItems.length === 0) { alert('Zaznacz przynajmniej jeden produkt'); return; }
    setGenerating(true);
    
    // Tworzymy nowe okno z wydrukiem
    const printWindow = window.open('', '_blank', 'width=900,height=1200');
    if (!printWindow) {
      alert('Włącz pop-upy dla tej strony!');
      setGenerating(false);
      return;
    }
    
    const today = new Date().toLocaleDateString('pl-PL');
    const html = `
<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="UTF-8">
<title>Zamówienie ${orderNumber}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; padding: 40px; color: #1c1917; line-height: 1.5; }
  .header { display: flex; justify-content: space-between; border-bottom: 4px solid ${group.manufacturer_color || '#f59e0b'}; padding-bottom: 20px; margin-bottom: 30px; }
  .logo { font-size: 28px; font-weight: 800; color: #1c1917; }
  .logo .accent { color: #f59e0b; }
  .order-info { text-align: right; }
  .order-info h1 { font-size: 22px; margin-bottom: 5px; }
  .order-info .num { font-family: monospace; font-size: 18px; color: #f59e0b; font-weight: bold; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 30px; margin-bottom: 30px; }
  .info-block { background: #fafaf9; border-left: 4px solid ${group.manufacturer_color || '#f59e0b'}; padding: 15px; }
  .info-block h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #78716c; margin-bottom: 8px; }
  .info-block .name { font-size: 18px; font-weight: bold; }
  .info-block .detail { font-size: 13px; color: #57534e; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  th { background: #1c1917; color: white; padding: 10px 8px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  th.right { text-align: right; }
  td { padding: 10px 8px; border-bottom: 1px solid #e7e5e4; font-size: 13px; }
  td.right { text-align: right; font-variant-numeric: tabular-nums; }
  td.mono { font-family: monospace; font-weight: bold; }
  .total-row { background: #fef3c7; font-weight: bold; }
  .total-row td { border-top: 2px solid #1c1917; padding: 12px 8px; font-size: 15px; }
  .notes { background: #fafaf9; padding: 15px; border-left: 4px solid #78716c; margin-top: 20px; }
  .notes h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #78716c; margin-bottom: 5px; }
  .footer { margin-top: 40px; padding-top: 20px; border-top: 2px solid #e7e5e4; display: flex; justify-content: space-between; font-size: 11px; color: #78716c; }
  .signature { margin-top: 60px; display: grid; grid-template-columns: 1fr 1fr; gap: 100px; }
  .sig-line { border-top: 1px solid #1c1917; padding-top: 5px; font-size: 11px; text-align: center; color: #78716c; }
  @media print { body { padding: 20px; } .no-print { display: none; } }
  .print-btn { position: fixed; top: 20px; right: 20px; background: #f59e0b; color: #1c1917; padding: 12px 24px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
</style>
</head>
<body>
  <button class="print-btn no-print" onclick="window.print()">📄 Zapisz jako PDF / Drukuj</button>
  
  <div class="header">
    <div>
      <div class="logo">MAGAZYN<span class="accent">.</span></div>
      <div style="font-size: 11px; color: #78716c; margin-top: 5px;">System zarządzania magazynem</div>
    </div>
    <div class="order-info">
      <h1>ZAMÓWIENIE</h1>
      <div class="num">${orderNumber}</div>
      <div style="font-size: 13px; color: #57534e; margin-top: 5px;">Data: ${today}</div>
    </div>
  </div>
  
  <div class="info-grid">
    <div class="info-block">
      <h3>Dostawca</h3>
      <div class="name">${group.manufacturer_name || '—'}</div>
      ${group.manufacturer_email ? `<div class="detail">📧 ${group.manufacturer_email}</div>` : ''}
    </div>
    <div class="info-block">
      <h3>Podsumowanie</h3>
      <div class="name">${selectedItems.length} pozycji · ${totalUnits} szt</div>
      <div class="detail" style="font-size: 16px; color: #92400e; margin-top: 5px; font-weight: bold;">
        ${new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN', maximumFractionDigits: 2 }).format(totalValue)}
      </div>
    </div>
  </div>
  
  <table>
    <thead>
      <tr>
        <th style="width: 30px;">#</th>
        <th>SKU</th>
        <th>Nazwa produktu</th>
        <th class="right">Ilość</th>
        <th class="right">Cena jedn.</th>
        <th class="right">Wartość</th>
      </tr>
    </thead>
    <tbody>
      ${selectedItems.map((item, i) => `
        <tr>
          <td>${i + 1}</td>
          <td class="mono">${item.sku}</td>
          <td>${item.name}</td>
          <td class="right">${item.quantity}</td>
          <td class="right">${new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2 }).format(item.unit_cost)} zł</td>
          <td class="right"><strong>${new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2 }).format(item.quantity * item.unit_cost)} zł</strong></td>
        </tr>
      `).join('')}
      <tr class="total-row">
        <td colspan="3">RAZEM</td>
        <td class="right">${totalUnits} szt</td>
        <td></td>
        <td class="right">${new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN', minimumFractionDigits: 2 }).format(totalValue)}</td>
      </tr>
    </tbody>
  </table>
  
  ${notes ? `
  <div class="notes">
    <h3>Uwagi</h3>
    <div>${notes.replace(/\n/g, '<br>')}</div>
  </div>
  ` : ''}
  
  <div class="signature">
    <div class="sig-line">Zamawiający</div>
    <div class="sig-line">Dostawca / Akceptacja</div>
  </div>
  
  <div class="footer">
    <span>Wygenerowano: ${today}</span>
    <span>Magazyn v5</span>
  </div>
  
  <script>
    // Auto-otwórz dialog drukowania po krótkiej chwili
    setTimeout(() => window.print(), 500);
  </script>
</body>
</html>`;
    
    printWindow.document.write(html);
    printWindow.document.close();
    setGenerating(false);
  };

  const copyEmailDraft = () => {
    const lines = [
      `Witam,`,
      ``,
      `Proszę o realizację następującego zamówienia (${orderNumber}):`,
      ``,
      ...selectedItems.map((i, idx) => `${idx + 1}. ${i.sku} - ${i.name} - ilość: ${i.quantity} szt`),
      ``,
      `Łączna wartość: ${new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(totalValue)}`,
      ``,
      notes ? `Uwagi: ${notes}\n` : '',
      `Pozdrawiam`,
    ];
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      alert('✅ Treść zamówienia skopiowana do schowka. Możesz wkleić do maila!');
    });
  };

  return (
    <div className="fixed inset-0 bg-stone-900/70 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[92vh] overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="text-white p-5 flex items-center justify-between" style={{ background: `linear-gradient(135deg, ${group.manufacturer_color || '#f59e0b'} 0%, #1c1917 100%)` }}>
          <div className="flex items-center gap-3">
            <FileText className="w-6 h-6" />
            <div>
              <h2 className="text-xl font-bold">Generator zamówienia (PO)</h2>
              <p className="text-xs opacity-80">Producent: {group.manufacturer_name}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-black/20 rounded-lg"><X className="w-5 h-5" /></button>
        </div>
        
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-stone-600 mb-1">Numer PO</label>
              <input type="text" value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} 
                className="w-full px-3 py-2 border-2 border-stone-200 rounded-lg font-mono text-sm" />
            </div>
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-stone-600 mb-1">Email producenta</label>
              <input type="email" value={group.manufacturer_email || ''} disabled 
                placeholder="(nie ustawiono w ustawieniach)"
                className="w-full px-3 py-2 border-2 border-stone-200 rounded-lg text-sm bg-stone-50 text-stone-500" />
            </div>
          </div>
          
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-stone-600 mb-2">Pozycje zamówienia ({selectedItems.length} z {items.length})</label>
            <div className="space-y-1 max-h-72 overflow-y-auto bg-stone-50 rounded-lg p-2">
              {items.map((item, idx) => (
                <div key={idx} className={`flex items-center gap-2 p-2 rounded ${item.selected ? 'bg-white border border-stone-200' : 'bg-stone-100 opacity-60'}`}>
                  <input type="checkbox" checked={item.selected} onChange={() => toggleSelected(idx)} className="w-4 h-4 accent-amber-500" />
                  <div className="flex-1 min-w-0">
                    <div className="font-mono font-bold text-sm">{item.sku}</div>
                    <div className="text-xs text-stone-600 truncate">{item.name}</div>
                  </div>
                  <input type="number" value={item.quantity} onChange={(e) => updateItem(idx, 'quantity', e.target.value)} 
                    placeholder="ilość" min="0"
                    className="w-20 px-2 py-1 border-2 border-stone-200 rounded text-sm tabular-nums text-center" />
                  <input type="number" value={item.unit_cost} onChange={(e) => updateItem(idx, 'unit_cost', e.target.value)}
                    placeholder="cena" step="0.01" min="0"
                    className="w-24 px-2 py-1 border-2 border-stone-200 rounded text-sm tabular-nums text-right" />
                  <button onClick={() => removeItem(idx)} className="p-1 text-red-600 hover:bg-red-50 rounded">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-stone-500 mt-1">💡 Możesz odznaczyć pozycje, edytować ilości i ceny przed generowaniem PDF.</p>
          </div>
          
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-stone-600 mb-1">Uwagi (opcjonalnie)</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} 
              placeholder="np. Termin dostawy do końca marca, paleta EUR, opakowanie zbiorcze..."
              className="w-full px-3 py-2 border-2 border-stone-200 rounded-lg resize-none text-sm" />
          </div>
          
          <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-4">
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <div className="text-xs text-amber-800 font-bold uppercase">Pozycji</div>
                <div className="text-2xl font-bold tabular-nums">{selectedItems.length}</div>
              </div>
              <div>
                <div className="text-xs text-amber-800 font-bold uppercase">Sztuk</div>
                <div className="text-2xl font-bold tabular-nums">{totalUnits}</div>
              </div>
              <div>
                <div className="text-xs text-amber-800 font-bold uppercase">Wartość</div>
                <div className="text-2xl font-bold tabular-nums">{fmtPLN(totalValue)}</div>
              </div>
            </div>
          </div>
        </div>
        
        <div className="bg-stone-50 px-6 py-4 flex gap-2 justify-end border-t border-stone-200 flex-wrap">
          <button onClick={onClose} className="px-4 py-2 bg-stone-200 rounded-lg font-bold">Anuluj</button>
          <button onClick={copyEmailDraft} disabled={selectedItems.length === 0}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg font-bold flex items-center gap-2">
            📋 Kopiuj treść maila
          </button>
          <button onClick={generatePdf} disabled={selectedItems.length === 0 || generating}
            className="px-6 py-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-stone-900 rounded-lg font-bold flex items-center gap-2">
            <FileText className="w-4 h-4" />
            {generating ? 'Generuję...' : 'Generuj PDF'}
          </button>
        </div>
      </div>
    </div>
  );
}


// ============================================================
// USER MENU - avatar + dropdown w headerze
// ============================================================
function UserMenu({ user, onLogout, onChangePassword, onUsersPanel, onAuditLog }) {
  const [open, setOpen] = useState(false);
  const roleColors = { ADMIN: 'bg-red-600', IMPORT: 'bg-blue-600', VIEWER: 'bg-stone-500' };
  const roleLabels = { ADMIN: 'Admin', IMPORT: 'Import', VIEWER: 'Viewer' };
  const initials = (user.full_name || user.email).substring(0, 2).toUpperCase();

  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} 
        className="flex items-center gap-2 px-2 py-1.5 bg-stone-800 hover:bg-stone-700 rounded-lg transition">
        <div className={`w-7 h-7 rounded-full ${roleColors[user.role] || 'bg-stone-600'} flex items-center justify-center text-white text-xs font-bold`}>
          {initials}
        </div>
        <div className="hidden md:block text-left">
          <div className="text-white text-xs font-bold leading-tight">{user.full_name || user.email}</div>
          <div className="text-stone-400 text-[10px]">{roleLabels[user.role]}</div>
        </div>
        <ChevronDown className="w-3 h-3 text-stone-400 hidden md:block" />
      </button>
      {open && (
        <>
          {/* Klik poza menu = zamknij */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          {/* Dropdown - fixed żeby nie dziedziczyć koloru z headera */}
          <div className="absolute right-0 top-full mt-2 w-56 bg-white rounded-xl shadow-2xl border border-stone-200 z-50 overflow-hidden">
            <div className="bg-stone-900 px-4 py-3">
              <div className="text-white text-sm font-bold truncate">{user.full_name || '—'}</div>
              <div className="text-stone-400 text-xs truncate">{user.email}</div>
              <span className={`inline-block mt-1 px-2 py-0.5 rounded text-[10px] font-bold text-white ${roleColors[user.role]}`}>{roleLabels[user.role]}</span>
            </div>
            <div className="p-1 bg-white">
              <button onClick={() => { setOpen(false); onChangePassword(); }} 
                className="w-full text-left px-3 py-2.5 text-sm text-stone-800 hover:bg-stone-100 rounded-lg flex items-center gap-2 font-medium">
                🔑 Zmień hasło
              </button>
              {onUsersPanel && (
                <button onClick={() => { setOpen(false); onUsersPanel(); }} 
                  className="w-full text-left px-3 py-2.5 text-sm text-stone-800 hover:bg-stone-100 rounded-lg flex items-center gap-2 font-medium">
                  👥 Zarządzaj użytkownikami
                </button>
              )}
              {onAuditLog && (
                <button onClick={() => { setOpen(false); onAuditLog(); }} 
                  className="w-full text-left px-3 py-2.5 text-sm text-stone-800 hover:bg-stone-100 rounded-lg flex items-center gap-2 font-medium">
                  📜 Audit log
                </button>
              )}
              <div className="border-t border-stone-100 my-1"></div>
              <button onClick={() => { setOpen(false); onLogout(); }}
                className="w-full text-left px-3 py-2.5 text-sm text-red-600 hover:bg-red-50 rounded-lg flex items-center gap-2 font-bold">
                🚪 Wyloguj się
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}


// ============================================================
// ZMIANA HASŁA
// ============================================================
function ChangePasswordModal({ onClose }) {
  const [current, setCurrent] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSave = async () => {
    if (!current || !newPwd || !confirm) { setError('Wypełnij wszystkie pola'); return; }
    if (newPwd !== confirm) { setError('Nowe hasła nie są identyczne'); return; }
    if (newPwd.length < 8) { setError('Hasło musi mieć min. 8 znaków'); return; }
    if (!/[A-Z]/.test(newPwd)) { setError('Hasło musi zawierać dużą literę'); return; }
    if (!/[0-9]/.test(newPwd)) { setError('Hasło musi zawierać cyfrę'); return; }
    
    setLoading(true); setError('');
    try {
      await api.put('/auth/me/password', { current_password: current, new_password: newPwd });
      setSuccess(true);
      setTimeout(onClose, 2000);
    } catch (e) {
      setError(e.message.includes('400') ? 'Aktualne hasło jest nieprawidłowe' : e.message);
    } finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 bg-stone-900/70 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-md w-full shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="bg-stone-900 text-white p-5 flex items-center justify-between">
          <h2 className="font-bold text-lg">🔑 Zmień hasło</h2>
          <button onClick={onClose} className="p-1 hover:bg-stone-800 rounded"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-3">
          {success ? (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 text-center">
              <div className="text-2xl mb-1">✅</div>
              <div className="font-bold text-emerald-900">Hasło zmienione!</div>
            </div>
          ) : (
            <>
              {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>}
              <div>
                <label className="block text-xs font-bold text-stone-600 uppercase mb-1">Obecne hasło</label>
                <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)}
                  className="w-full px-3 py-2 border-2 border-stone-200 rounded-lg focus:border-amber-500 outline-none" autoFocus />
              </div>
              <div>
                <label className="block text-xs font-bold text-stone-600 uppercase mb-1">Nowe hasło</label>
                <input type="password" value={newPwd} onChange={(e) => setNewPwd(e.target.value)}
                  className="w-full px-3 py-2 border-2 border-stone-200 rounded-lg focus:border-amber-500 outline-none" />
                <p className="text-[11px] text-stone-500 mt-1">Min. 8 znaków, 1 duża litera, 1 cyfra</p>
              </div>
              <div>
                <label className="block text-xs font-bold text-stone-600 uppercase mb-1">Powtórz nowe hasło</label>
                <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
                  className="w-full px-3 py-2 border-2 border-stone-200 rounded-lg focus:border-amber-500 outline-none" />
              </div>
              <div className="flex gap-2 pt-2">
                <button onClick={onClose} className="flex-1 py-2 bg-stone-200 rounded-lg font-bold">Anuluj</button>
                <button onClick={handleSave} disabled={loading} className="flex-1 py-2 bg-amber-500 text-stone-900 rounded-lg font-bold disabled:opacity-50">
                  {loading ? 'Zapisuję...' : 'Zmień hasło'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}


// ============================================================
// PANEL UŻYTKOWNIKÓW (tylko admin)
// ============================================================
function UsersPanelModal({ onClose }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [newUser, setNewUser] = useState({ email: '', password: '', full_name: '', role: 'VIEWER' });
  const [resetTarget, setResetTarget] = useState(null);
  const [resetPwd, setResetPwd] = useState('');
  const [error, setError] = useState('');

  const roleColors = { ADMIN: 'bg-red-600', IMPORT: 'bg-blue-600', VIEWER: 'bg-stone-500' };
  const roleLabels = { ADMIN: 'Admin', IMPORT: 'Import', VIEWER: 'Viewer' };

  const load = async () => {
    try { setUsers(await api.get('/users')); } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  // Parsuje surowy błąd API na czytelny komunikat po polsku
  const parseApiError = (message) => {
    // Błąd Pydantic 422 - walidacja pól
    if (message.includes('string_too_short') || message.includes('at least 8')) return 'Hasło musi mieć minimum 8 znaków';
    if (message.includes('string_too_long')) return 'Wartość jest za długa';
    if (message.includes('value_error') && message.includes('email')) return 'Nieprawidłowy format email';
    if (message.includes('422')) return 'Sprawdź poprawność danych (hasło min. 8 znaków, 1 duża litera, 1 cyfra)';
    // Błędy backendu
    if (message.includes('409')) return 'Użytkownik z tym emailem już istnieje';
    if (message.includes('400') && message.includes('hasło')) return message.split(' - ')[1] || 'Nieprawidłowe hasło';
    if (message.includes('400')) {
      const match = message.match(/400 - (.+)/);
      return match ? match[1] : 'Błąd walidacji danych';
    }
    return message;
  };

  const validatePassword = (pwd) => {
    if (pwd.length < 8) return 'Hasło musi mieć minimum 8 znaków';
    if (!/[A-Z]/.test(pwd)) return 'Hasło musi zawierać przynajmniej jedną dużą literę (A-Z)';
    if (!/[0-9]/.test(pwd)) return 'Hasło musi zawierać przynajmniej jedną cyfrę (0-9)';
    return null;
  };

  const createUser = async () => {
    if (!newUser.email || !newUser.password || !newUser.full_name) { setError('Wypełnij wszystkie pola'); return; }
    // Walidacja hasła po stronie frontendu - przed wysłaniem do API
    const pwdErr = validatePassword(newUser.password);
    if (pwdErr) { setError(pwdErr); return; }
    setError('');
    try {
      await api.post('/users', newUser);
      setShowForm(false);
      setNewUser({ email: '', password: '', full_name: '', role: 'VIEWER' });
      await load();
    } catch (e) { setError(parseApiError(e.message)); }
  };

  const toggleActive = async (u) => {
    try { await api.patch(`/users/${u.id}`, { is_active: !u.is_active }); await load(); }
    catch (e) { setError(e.message); }
  };

  const changeRole = async (u, role) => {
    try { await api.patch(`/users/${u.id}`, { role }); await load(); }
    catch (e) { setError(e.message); }
  };

  const doResetPwd = async () => {
    if (!resetPwd) return;
    const pwdErr = validatePassword(resetPwd);
    if (pwdErr) { setError(pwdErr); return; }
    try {
      await api.put(`/users/${resetTarget.id}/password`, { new_password: resetPwd });
      setResetTarget(null); setResetPwd('');
    } catch (e) { setError(parseApiError(e.message)); }
  };

  const deleteUser = async (u) => {
    if (!window.confirm(`Usunąć użytkownika ${u.email}?`)) return;
    try { await api.del(`/users/${u.id}`); await load(); }
    catch (e) { setError(e.message); }
  };

  return (
    <div className="fixed inset-0 bg-stone-900/70 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="bg-stone-900 text-white p-5 flex items-center justify-between">
          <h2 className="font-bold text-lg">👥 Zarządzaj użytkownikami</h2>
          <button onClick={onClose} className="p-1 hover:bg-stone-800 rounded"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-4">
          {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}<button onClick={() => setError('')} className="ml-2 text-red-400">✕</button></div>}
          
          <div className="flex justify-between items-center">
            <div className="text-sm text-stone-600">{users.length} użytkowników</div>
            <button onClick={() => { setShowForm(true); setError(''); }} className="flex items-center gap-1 px-3 py-1.5 bg-amber-500 text-stone-900 rounded-lg font-bold text-sm">
              <Plus className="w-4 h-4" />Dodaj
            </button>
          </div>

          {showForm && (
            <div className="border-2 border-amber-500 rounded-xl p-4 space-y-3">
              <h3 className="font-bold text-sm">Nowy użytkownik</h3>
              <div className="grid grid-cols-2 gap-3">
                <input type="text" value={newUser.full_name} onChange={(e) => setNewUser({...newUser, full_name: e.target.value})}
                  placeholder="Imię i Nazwisko" className="px-3 py-2 border-2 border-stone-200 rounded-lg text-sm" />
                <input type="email" value={newUser.email} onChange={(e) => setNewUser({...newUser, email: e.target.value})}
                  placeholder="email@firma.pl" className="px-3 py-2 border-2 border-stone-200 rounded-lg text-sm" />
                <div className="col-span-2">
                  <input type="password" value={newUser.password} onChange={(e) => setNewUser({...newUser, password: e.target.value})}
                    placeholder="Hasło" className={`w-full px-3 py-2 border-2 rounded-lg text-sm ${newUser.password && validatePassword(newUser.password) ? 'border-red-400' : newUser.password && !validatePassword(newUser.password) ? 'border-emerald-500' : 'border-stone-200'}`} />
                  <div className="mt-1.5 flex gap-3 text-[11px]">
                    <span className={`flex items-center gap-0.5 ${!newUser.password ? 'text-stone-400' : newUser.password.length >= 8 ? 'text-emerald-600 font-bold' : 'text-red-500'}`}>
                      {newUser.password.length >= 8 ? '✓' : '✗'} min. 8 znaków
                    </span>
                    <span className={`flex items-center gap-0.5 ${!newUser.password ? 'text-stone-400' : /[A-Z]/.test(newUser.password) ? 'text-emerald-600 font-bold' : 'text-red-500'}`}>
                      {/[A-Z]/.test(newUser.password) ? '✓' : '✗'} duża litera
                    </span>
                    <span className={`flex items-center gap-0.5 ${!newUser.password ? 'text-stone-400' : /[0-9]/.test(newUser.password) ? 'text-emerald-600 font-bold' : 'text-red-500'}`}>
                      {/[0-9]/.test(newUser.password) ? '✓' : '✗'} cyfra
                    </span>
                  </div>
                </div>
                <select value={newUser.role} onChange={(e) => setNewUser({...newUser, role: e.target.value})}
                  className="px-3 py-2 border-2 border-stone-200 rounded-lg text-sm bg-white">
                  <option value="VIEWER">Viewer (tylko czytanie)</option>
                  <option value="IMPORT">Import (wszystko oprócz userów)</option>
                  <option value="ADMIN">Admin (pełny dostęp)</option>
                </select>
              </div>
              <div className="flex gap-2">
                <button onClick={() => setShowForm(false)} className="flex-1 py-2 bg-stone-200 rounded-lg font-bold text-sm">Anuluj</button>
                <button onClick={createUser} className="flex-1 py-2 bg-emerald-600 text-white rounded-lg font-bold text-sm">Utwórz</button>
              </div>
            </div>
          )}

          {resetTarget && (
            <div className="border-2 border-blue-500 rounded-xl p-4 space-y-3">
              <h3 className="font-bold text-sm">Reset hasła: <span className="text-blue-700">{resetTarget.email}</span></h3>
              <input type="password" value={resetPwd} onChange={(e) => setResetPwd(e.target.value)}
                placeholder="Nowe hasło (min. 8 znaków, A, 1)" className="w-full px-3 py-2 border-2 border-stone-200 rounded-lg text-sm" autoFocus />
              <div className="flex gap-2">
                <button onClick={() => { setResetTarget(null); setResetPwd(''); }} className="flex-1 py-2 bg-stone-200 rounded-lg font-bold text-sm">Anuluj</button>
                <button onClick={doResetPwd} className="flex-1 py-2 bg-blue-600 text-white rounded-lg font-bold text-sm">Ustaw hasło</button>
              </div>
            </div>
          )}

          {loading ? (
            <div className="text-center py-8 text-stone-400"><RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2" />Ładowanie...</div>
          ) : (
            <div className="space-y-2">
              {users.map(u => (
                <div key={u.id} className={`flex items-center gap-3 p-3 rounded-xl border ${u.is_active ? 'bg-stone-50 border-stone-200' : 'bg-red-50 border-red-200 opacity-60'}`}>
                  <div className={`w-8 h-8 rounded-full ${roleColors[u.role]} flex items-center justify-center text-white text-xs font-bold flex-shrink-0`}>
                    {(u.full_name || u.email).substring(0, 2).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-sm truncate">{u.full_name || '—'}</div>
                    <div className="text-xs text-stone-500 truncate">{u.email}</div>
                    {u.last_login && <div className="text-[10px] text-stone-400">Ostatnie logowanie: {new Date(u.last_login).toLocaleString('pl-PL')}</div>}
                  </div>
                  <select value={u.role} onChange={(e) => changeRole(u, e.target.value)}
                    className={`text-xs px-2 py-1 rounded-lg font-bold text-white border-0 outline-none cursor-pointer ${roleColors[u.role]}`}>
                    <option value="VIEWER" className="bg-stone-700">Viewer</option>
                    <option value="IMPORT" className="bg-stone-700">Import</option>
                    <option value="ADMIN" className="bg-stone-700">Admin</option>
                  </select>
                  <div className="flex gap-1">
                    <button onClick={() => { setResetTarget(u); setResetPwd(''); }} className="p-1.5 hover:bg-blue-100 text-blue-700 rounded text-xs" title="Reset hasła">🔑</button>
                    <button onClick={() => toggleActive(u)} className="p-1.5 hover:bg-stone-200 rounded text-xs" title={u.is_active ? 'Deaktywuj' : 'Aktywuj'}>
                      {u.is_active ? '⏸' : '▶️'}
                    </button>
                    <button onClick={() => deleteUser(u)} className="p-1.5 hover:bg-red-100 text-red-600 rounded text-xs" title="Usuń">🗑</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


// ============================================================
// AUDIT LOG (tylko admin)
// ============================================================
function AuditLogModal({ onClose }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterAction, setFilterAction] = useState('');

  useEffect(() => {
    api.get('/audit-log?limit=200')
      .then(setEntries)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const actionColors = {
    LOGIN: 'bg-emerald-100 text-emerald-800',
    LOGIN_FAILED: 'bg-red-100 text-red-800',
    LOGIN_BLOCKED: 'bg-red-200 text-red-900',
    USER_CREATED: 'bg-blue-100 text-blue-800',
    USER_UPDATED: 'bg-amber-100 text-amber-800',
    USER_DELETED: 'bg-red-100 text-red-800',
    PASSWORD_CHANGED: 'bg-purple-100 text-purple-800',
    PASSWORD_RESET_BY_ADMIN: 'bg-purple-200 text-purple-900',
  };

  const filtered = filterAction ? entries.filter(e => e.action === filterAction) : entries;
  const uniqueActions = [...new Set(entries.map(e => e.action))].sort();

  return (
    <div className="fixed inset-0 bg-stone-900/70 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="bg-stone-900 text-white p-5 flex items-center justify-between">
          <h2 className="font-bold text-lg">📜 Audit log</h2>
          <button onClick={onClose} className="p-1 hover:bg-stone-800 rounded"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-4 border-b border-stone-200 flex items-center gap-3">
          <select value={filterAction} onChange={(e) => setFilterAction(e.target.value)} className="px-3 py-2 border-2 border-stone-200 rounded-lg text-sm bg-white flex-1">
            <option value="">Wszystkie akcje ({entries.length})</option>
            {uniqueActions.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <span className="text-xs text-stone-500">{filtered.length} wpisów</span>
        </div>
        {loading ? (
          <div className="text-center py-12 text-stone-400"><RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2" />Ładowanie...</div>
        ) : (
          <div className="divide-y divide-stone-100 max-h-[500px] overflow-y-auto">
            {filtered.length === 0 && <div className="p-8 text-center text-stone-400">Brak wpisów</div>}
            {filtered.map(e => (
              <div key={e.id} className="px-4 py-3 flex items-start gap-3 hover:bg-stone-50">
                <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold whitespace-nowrap ${actionColors[e.action] || 'bg-stone-100 text-stone-700'}`}>
                  {e.action}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold text-stone-700 truncate">{e.user_email || '—'}</div>
                  {e.details && <div className="text-[11px] text-stone-500 truncate">{e.details}</div>}
                </div>
                <div className="text-[10px] text-stone-400 whitespace-nowrap flex-shrink-0">
                  {new Date(e.created_at).toLocaleString('pl-PL')}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
