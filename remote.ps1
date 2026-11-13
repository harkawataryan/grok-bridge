# Keeps the bridge (HTTP mode) and the Cloudflare tunnel running for claude.ai / mobile access.
# Started hidden at login by remote-start.vbs. Restarts either process if it stops.
# Settings (env vars): GROK_BRIDGE_PORT (default 8790), CLOUDFLARED (path), GROK_TUNNEL (tunnel name, default grok-bridge)
$ErrorActionPreference = 'Continue'
$dir  = $PSScriptRoot
$port = if ($env:GROK_BRIDGE_PORT) { $env:GROK_BRIDGE_PORT } else { 8790 }
$cf   = if ($env:CLOUDFLARED) { $env:CLOUDFLARED } else { 'C:\Program Files (x86)\cloudflared\cloudflared.exe' }
$tun  = if ($env:GROK_TUNNEL) { $env:GROK_TUNNEL } else { 'grok-bridge' }
$node = (Get-Command node -ErrorAction Stop).Source
$logs = Join-Path $dir 'logs'; New-Item -ItemType Directory -Force $logs | Out-Null

# Only one supervisor at a time.
$mutex = New-Object System.Threading.Mutex($false, 'Global\grok-bridge-remote')
if (-not $mutex.WaitOne(0)) { exit }

$bridge = $null; $tunnel = $null
while ($true) {
  if (-not $bridge -or $bridge.HasExited) {
    $bridge = Start-Process $node -ArgumentList "`"$dir\server.mjs`"", '--http', $port -WorkingDirectory $dir `
      -WindowStyle Hidden -PassThru -RedirectStandardError "$logs\bridge.log" -RedirectStandardOutput "$logs\bridge.out.log"
  }
  if (-not $tunnel -or $tunnel.HasExited) {
    $tunnel = Start-Process $cf -ArgumentList 'tunnel', '--no-autoupdate', 'run', $tun -WindowStyle Hidden -PassThru `
      -RedirectStandardError "$logs\tunnel.log" -RedirectStandardOutput "$logs\tunnel.out.log"
  }
  Start-Sleep -Seconds 15
}
