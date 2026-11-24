# Registers the TabVideoGrab native helper in Firefox (current user only).
# Run:  powershell -ExecutionPolicy Bypass -File install.ps1
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
if (-not $py) { throw 'Python 3 not found. Install it (winget install Python.Python.3.12) and run this script again.' }
Write-Host "Python: $py"

# --- plik startowy i manifest ---
$bat = Join-Path $dir 'vg_host.bat'
$hostPy = Join-Path $dir 'vg_host.py'
Set-Content -Path $bat -Encoding ASCII -Value "@echo off`r`n`"$py`" -u `"$hostPy`" %*"

$json = Join-Path $dir "$name.json"
$manifest = [ordered]@{
    name               = $name
    description        = 'TabVideoGrab - downloads via yt-dlp'
    path               = $bat
    type               = 'stdio'
    allowed_extensions = @('tabvideograb@local')
}
[IO.File]::WriteAllText($json, ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))  # bez BOM

$key = "HKCU:\Software\Mozilla\NativeMessagingHosts\$name"
# old registration (before the rename to TabVideoGrab)
$legacy = 'HKCU:\Software\Mozilla\NativeMessagingHosts\video_grabber'
if (Test-Path $legacy) { Remove-Item -Path $legacy -Recurse -Force; Write-Host 'Removed the old video_grabber registration' }
Remove-Item -Path (Join-Path $dir 'video_grabber.json') -ErrorAction SilentlyContinue

New-Item -Path $key -Force | Out-Null
Set-Item -Path $key -Value $json
Write-Host "Registered: $key -> $json"

# --- yt-dlp / ffmpeg ---
$yt = Get-Command yt-dlp -ErrorAction SilentlyContinue
if (-not $yt) {
    Write-Host ''
    Write-Host 'yt-dlp not found.' -ForegroundColor Yellow
    $ans = Read-Host 'Install it now with winget? (y/n)'
    if ($ans -match '^[tTyY]') { winget install --id yt-dlp.yt-dlp -e --accept-source-agreements }
    else { Write-Host 'Later: winget install yt-dlp.yt-dlp' }
} else { Write-Host "yt-dlp: $($yt.Source)" }

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host 'Warning: ffmpeg is not on PATH - yt-dlp cannot merge video and audio. (winget install Gyan.FFmpeg)' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Done. Reopen the add-on popup in Firefox.' -ForegroundColor Green
