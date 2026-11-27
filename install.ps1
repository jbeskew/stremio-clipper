# Installs the Stremio Clipper plugin into Stremio Enhanced and sets the helper to start at login.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js was not found on PATH. Install it from https://nodejs.org first.' }

New-Item -ItemType Directory -Force (Join-Path $root 'stremio clips') | Out-Null

# 1. plugin -> Stremio Enhanced plugins folder
$plugins = Join-Path $env:APPDATA 'stremio-enhanced\plugins'
New-Item -ItemType Directory -Force $plugins | Out-Null
Copy-Item (Join-Path $root 'plugin\stremio-clipper.plugin.js') $plugins -Force
Write-Host "Plugin copied to $plugins"

# 2. start-at-login shortcut for the helper
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'Stremio Clipper Helper.lnk'
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($lnk)
$s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$s.Arguments = '"' + (Join-Path $root 'helper\start-hidden.vbs') + '"'
$s.WorkingDirectory = Join-Path $root 'helper'
$s.Save()
Write-Host "Startup shortcut created: $lnk"

# 3. start the helper now if it is not already running
$up = $false
try { $up = (Invoke-RestMethod 'http://127.0.0.1:47811/health' -TimeoutSec 2).ok } catch {}
if (-not $up) {
  Start-Process wscript.exe -ArgumentList ('"' + (Join-Path $root 'helper\start-hidden.vbs') + '"')
  Start-Sleep -Seconds 6
  try { $h = Invoke-RestMethod 'http://127.0.0.1:47811/health' -TimeoutSec 3; Write-Host "Helper running. Encoder: $($h.encoder)" } catch { Write-Warning 'Helper did not respond. Try running helper\start-hidden.vbs manually.' }
} else { Write-Host 'Helper already running.' }

Write-Host ''
Write-Host 'Last step: open Stremio Enhanced > Settings > Plugins and enable "Stremio Clipper", then reload.'
