# Removes the TabVideoGrab native helper registration from Firefox.
$key = 'HKCU:\Software\Mozilla\NativeMessagingHosts\tabvideograb'
if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force; Write-Host "Removed $key" }
else { Write-Host 'The native helper was not registered.' }
