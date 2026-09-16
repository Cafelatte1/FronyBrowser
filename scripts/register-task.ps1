<#
.SYNOPSIS
  Register (or re-register) the "FronyBrowser Server" scheduled task on the home server.

.DESCRIPTION
  Runs ON the server as the service account. Boot trigger, S4U logon type, no time limit,
  single instance, runs C:\Users\<account>\wallet-server.cmd.

  ★ Must run as the service account, not SYSTEM — DPAPI is per-account.
  ★ S4U is enough for that, measured on 2026-09-16: a task running as the account with LogonType S4U
    decrypts CurrentUser DPAPI data written by another session, and the server recovers the vault
    unlock from the handoff file (FWL-042) across a restart. This task was Interactive until then, on
    the belief that S4U could not reach the user master key and that headful Chrome could not be
    launched from session 0. Both were untested and both are false: on the same date a session opened
    with browser = chrome and headless = false rendered a full page tree and a 988x653 screenshot from
    session 0. The cost of the old setting was real — the server did not come back from an unattended
    reboot at all, because nobody logs on to a headless machine.
  ★ Retry is 999 times a minute apart, not the Task Scheduler default: the launcher binds the Tailscale
    address (WALLET_BIND) and the boot trigger fires before Tailscale has one, so the first attempts die
    with EADDRNOTAVAIL. The sibling Frony services hit the same race and settled on the same numbers.

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
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
"registered: $TaskName -> $Launcher (S4U as $env:USERNAME, at startup, retry 999x1m)"
