# Usuwa rejestracje programu pomocniczego TabVideoGrab z Firefoksa.
$key = 'HKCU:\Software\Mozilla\NativeMessagingHosts\tabvideograb'
if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force; Write-Host "Usunieto $key" }
else { Write-Host 'Program pomocniczy nie byl zarejestrowany.' }
