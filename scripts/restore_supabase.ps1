param(
    [Parameter(Mandatory=$true)]
    [string]$BackupDir,

    [Parameter(Mandatory=$true)]
    [string]$NewDbUrl
)

$ErrorActionPreference = "Stop"

$BackupDir = (Resolve-Path $BackupDir).Path

$required = @("roles.sql", "schema.sql", "data.sql")
foreach ($name in $required) {
    if (-not (Test-Path (Join-Path $BackupDir $name))) {
        throw "Brak pliku $name w $BackupDir"
    }
}

Write-Host "" 
Write-Host "UWAGA: restore zapisze dane do wskazanej bazy." -ForegroundColor Yellow
Write-Host "Backup: $BackupDir"
Write-Host "Cel:    $NewDbUrl"
Write-Host ""
$confirm = Read-Host "Wpisz RESTORE aby kontynuowac"
if ($confirm -ne "RESTORE") {
    throw "Przerwano."
}

$mount = $BackupDir -replace '\\','/'

Write-Host "Uruchamiam restore przez psql w Dockerze..." -ForegroundColor Cyan

docker run --rm `
    -v "${mount}:/backup:ro" `
    postgres:17-alpine `
    psql `
      --single-transaction `
      --variable ON_ERROR_STOP=1 `
      --file /backup/roles.sql `
      --file /backup/schema.sql `
      --command "SET session_replication_role = replica" `
      --file /backup/data.sql `
      --dbname "$NewDbUrl"

if ($LASTEXITCODE -ne 0) {
    throw "Restore zakonczyl sie bledem: $LASTEXITCODE"
}

Write-Host "" 
Write-Host "RESTORE ZAKONCZONY POPRAWNIE" -ForegroundColor Green
Write-Host "Sprawdz teraz tabele public, auth.users i app_container_attachments." -ForegroundColor Green
