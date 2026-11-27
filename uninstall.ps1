# Removes the plugin, startup shortcut, and stops the helper. Saved clips are left alone.
$plugin = Join-Path $env:APPDATA 'stremio-enhanced\plugins\stremio-clipper.plugin.js'
if (Test-Path $plugin) { Remove-Item $plugin; Write-Host 'Plugin removed.' }
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Stremio Clipper Helper.lnk'
if (Test-Path $lnk) { Remove-Item $lnk; Write-Host 'Startup shortcut removed.' }
Get-NetTCPConnection -LocalPort 47811 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess; Write-Host 'Helper stopped.' }
