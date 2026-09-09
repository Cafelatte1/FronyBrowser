<#
.SYNOPSIS
  Register (or re-register) the "FronyBrowser Server" scheduled task on the home server.

.DESCRIPTION
  Runs ON the server as the service account. Logon trigger, interactive logon type, no time limit,
  single instance, runs C:\Users\<account>\wallet-server.cmd.

  ★ Interactive only (not S4U): an origin with headless = false launches a headful Chrome window
    (policy.toml [origins].headless = false, FWL-027) and a window cannot be
    created from session 0. Consequence: after a reboot the server starts only once
    that account logs on to the laptop. Keep that session logged on (lock is fine).
  ★ Must run as the service account, not SYSTEM — DPAPI is per-account.

.EXAMPLE
  powershell -NoProfile -File scripts\register-task.ps1
#>
param(
    [string]$TaskName = "FronyBrowser Server",
    [string]$Launcher = "$env:USERPROFILE\wallet-server.cmd"
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path $Launcher)) { throw "launcher not found: $Launcher" }

$action = New-ScheduledTaskAction -Execute $Launcher
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 10)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
"registered: $TaskName -> $Launcher (interactive, at logon of $env:USERNAME)"
