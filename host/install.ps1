# Rejestruje program pomocniczy TabVideoGrab w Firefoksie (tylko dla biezacego uzytkownika).
# Uruchom:  powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = 'tabvideograb'

# --- Python ---
$py = $null
foreach ($c in (Get-Command python, python3 -All -ErrorAction SilentlyContinue)) {
    if ($c.Source -notlike '*WindowsApps*') { $py = $c.Source; break }
}
if (-not $py) {
    $launcher = Get-Command py -ErrorAction SilentlyContinue
    if ($launcher) { $py = (& $launcher.Source -3 -c "import sys;print(sys.executable)").Trim() }
}
if (-not $py) { throw 'Nie znaleziono Pythona 3. Zainstaluj go (winget install Python.Python.3.12) i uruchom skrypt ponownie.' }
Write-Host "Python: $py"

# --- plik startowy i manifest ---
$bat = Join-Path $dir 'vg_host.bat'
$hostPy = Join-Path $dir 'vg_host.py'
Set-Content -Path $bat -Encoding ASCII -Value "@echo off`r`n`"$py`" -u `"$hostPy`" %*"

$json = Join-Path $dir "$name.json"
$manifest = [ordered]@{
    name               = $name
    description        = 'TabVideoGrab - pobieranie przez yt-dlp'
    path               = $bat
    type               = 'stdio'
    allowed_extensions = @('tabvideograb@local')
}
[IO.File]::WriteAllText($json, ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))  # bez BOM

$key = "HKCU:\Software\Mozilla\NativeMessagingHosts\$name"
# stara rejestracja (przed zmiana nazwy na TabVideoGrab)
$legacy = 'HKCU:\Software\Mozilla\NativeMessagingHosts\video_grabber'
if (Test-Path $legacy) { Remove-Item -Path $legacy -Recurse -Force; Write-Host 'Usunieto stara rejestracje video_grabber' }
Remove-Item -Path (Join-Path $dir 'video_grabber.json') -ErrorAction SilentlyContinue

New-Item -Path $key -Force | Out-Null
Set-Item -Path $key -Value $json
Write-Host "Zarejestrowano: $key -> $json"

# --- yt-dlp / ffmpeg ---
$yt = Get-Command yt-dlp -ErrorAction SilentlyContinue
if (-not $yt) {
    Write-Host ''
    Write-Host 'Nie znaleziono yt-dlp.' -ForegroundColor Yellow
    $ans = Read-Host 'Zainstalowac teraz przez winget? (t/n)'
    if ($ans -match '^[tTyY]') { winget install --id yt-dlp.yt-dlp -e --accept-source-agreements }
    else { Write-Host 'Pozniej: winget install yt-dlp.yt-dlp' }
} else { Write-Host "yt-dlp: $($yt.Source)" }

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host 'Uwaga: brak ffmpeg w PATH - yt-dlp nie polaczy obrazu z dzwiekiem. (winget install Gyan.FFmpeg)' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Gotowe. Otworz ponownie okienko dodatku w Firefoksie.' -ForegroundColor Green
