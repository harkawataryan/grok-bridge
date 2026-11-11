# Show or hide the Grok Bot window(s) without closing the app.
#   powershell -NoProfile -ExecutionPolicy Bypass -File winctl.ps1 hide|show|state|hidewait
#   hidewait: used right after launch; keeps hiding the window as soon as it appears
#             (the app may show it a moment after creating it) for up to -Seconds.
param([ValidateSet('hide', 'show', 'state', 'hidewait')][string]$Action = 'state', [int]$Seconds = 30)

Add-Type -Namespace GB -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
public delegate bool EnumProc(IntPtr h, IntPtr p);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
'@

function Find-GrokWindows {
  $script:pids = @(Get-Process -Name 'Grok Bot' -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
  $script:found = New-Object System.Collections.Generic.List[IntPtr]
  $cb = [GB.Win+EnumProc] {
    param($h, $p)
    $wp = [uint32]0; [void][GB.Win]::GetWindowThreadProcessId($h, [ref]$wp)
    if ($script:pids -contains $wp) {
      $sb = New-Object System.Text.StringBuilder 256; [void][GB.Win]::GetWindowText($h, $sb, 256)
      if ($sb.ToString() -eq 'Grok Bot') { $script:found.Add($h) }
    }
    return $true
  }
  [void][GB.Win]::EnumWindows($cb, [IntPtr]::Zero)
  return , $script:found
}

if ($Action -eq 'hidewait') {
  $end = (Get-Date).AddSeconds($Seconds); $quietSince = $null
  while ((Get-Date) -lt $end) {
    $ws = Find-GrokWindows
    foreach ($h in $ws) { if ([GB.Win]::IsWindowVisible($h)) { [void][GB.Win]::ShowWindow($h, 0); $quietSince = $null } }
    if ($ws.Count -gt 0) { if (-not $quietSince) { $quietSince = Get-Date } elseif (((Get-Date) - $quietSince).TotalSeconds -ge 4) { break } }
    Start-Sleep -Milliseconds 50
  }
  $Action = 'state'
}

$found = Find-GrokWindows

foreach ($h in $found) {
  if ($Action -eq 'hide') { [void][GB.Win]::ShowWindow($h, 0) }                    # SW_HIDE
  if ($Action -eq 'show') { [void][GB.Win]::ShowWindow($h, 9); [void][GB.Win]::SetForegroundWindow($h) } # SW_RESTORE
}
$vis = @($found | Where-Object { [GB.Win]::IsWindowVisible($_) }).Count
"windows=$($found.Count) visible=$vis"
