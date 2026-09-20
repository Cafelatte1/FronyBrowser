<#
.SYNOPSIS
  Deploy a release tag to the GPU home server, or just restart the server.

.DESCRIPTION
  Runs ON the server, from its checkout. Stops the "FronyBrowser Server" scheduled
  task, optionally checks out -Tag and runs npm ci + playwright install + build,
  then starts the task again and prints its status.

  ★ 이 태스크는 SYSTEM이 아니라 서비스 계정으로 등록돼야 한다 — DPAPI가 계정
    종속이라 값을 등록한 계정과 서버 실행 계정이 다르면 복호화가 조용히 실패한다.

.EXAMPLE
  powershell -NoProfile -File scripts\deploy.ps1 -Tag v0.1.0   # release: checkout + build + restart
  powershell -NoProfile -File scripts\deploy.ps1               # restart only

  From a dev PC over Tailscale:
  ssh <server> "powershell -NoProfile -File <checkout>\scripts\deploy.ps1 -Tag v0.1.0"
#>
param(
    [string]$Tag,
    [string]$TaskName = "FronyBrowser Server"
)
$ErrorActionPreference = "Continue"
Set-Location (Split-Path -Parent $PSScriptRoot)

# 0. unlock handoff (FWL-042) — ask the running server to leave a short-lived DPAPI file so the new
#    process resumes the vault unlock with the same deadline.
#
#    /vault/handoff answers 403 for two unrelated things: "your key is not allowed" and "the vault is
#    already locked, there is nothing to hand off". The old message folded both into "skipped", and on
#    2026-09-16 that cost real time: Windows updates had rebooted the machine and left the vault locked,
#    the deploy printed a 403, and it was read as an auth problem and chased as one. So ask /health
#    first — no auth, and it reports vaultLocked outright — and say plainly which of the two happened.
#
#    Both accepted credentials are tried because which env var holds which is genuinely not visible
#    from here: on this server FRONY_KEY is the value the service itself runs under, so it passes
#    handoff while every other /vault route refuses it as "admin only". Looping costs six lines and
#    removes that guessing game.
$walletServer = if ($env:WALLET_SERVER) { $env:WALLET_SERVER } else { "http://$(tailscale ip -4 2>$null | Select-Object -First 1):9420" }

$vaultOpen = $null
try { $vaultOpen = -not (Invoke-RestMethod -Uri "$walletServer/health" -TimeoutSec 10).vaultLocked } catch { }

if ($vaultOpen -eq $null) {
    # /health did not answer, so the server is not up — there is nothing running to hand anything over.
    # Saying "key refused" here would send the next reader hunting an auth problem that does not exist.
    "unlock handoff: not needed - no server answering at $walletServer, run 'vault unlock' after restart"
} elseif ($vaultOpen -eq $false) {
    "unlock handoff: not needed - the vault is already locked, run 'vault unlock' after restart"
} else {
    $keys = @()
    if ($env:FRONY_KEY)         { $keys += [pscustomobject]@{ name = "FRONY_KEY";         value = $env:FRONY_KEY } }
    if ($env:FRONY_SERVICE_KEY) { $keys += [pscustomobject]@{ name = "FRONY_SERVICE_KEY"; value = $env:FRONY_SERVICE_KEY } }

    $handed = $false
    foreach ($k in $keys) {
        try {
            $r = Invoke-RestMethod -Method Post -Uri "$walletServer/vault/handoff" -Headers @{ authorization = "Bearer $($k.value)" } -TimeoutSec 10
            "unlock handoff: ok via $($k.name) ($([math]::Round($r.remainingMs / 60000)) min left)"
            $handed = $true
            break
        } catch {
            $status = try { [int]$_.Exception.Response.StatusCode } catch { 0 }
            "unlock handoff: $($k.name) refused$(if ($status) { " ($status)" } else { " ($($_.Exception.Message))" })"
        }
    }
    if (-not $handed) {
        # Loud on purpose. The deploy still succeeds, but the vault comes back locked and every fill
        # fails with vault_locked until someone types the master password.
        "unlock handoff: ** FAILED ** - $(if ($keys.Count) { "no key was accepted" } else { "FRONY_KEY and FRONY_SERVICE_KEY are both unset" }); the vault will be LOCKED after restart, run 'vault unlock'"
    }
}

# 1. stop — wait for the task to end, then kill any node process serving the api
schtasks /End /TN $TaskName 2>$null | Out-Null
$procs = { Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*backend*api*src*main.ts*" -and $_.CommandLine -like "*$((Get-Location).Path)*" } }
for ($i = 0; $i -lt 20 -and (& $procs); $i++) { Start-Sleep 1 }
& $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep 1

# 2. checkout + install + build (release only)
$failed = $false
if ($Tag) {
    git fetch --tags --quiet
    git checkout --quiet $Tag
    if ($LASTEXITCODE -ne 0) {
        "checkout $Tag failed - restarting what is checked out"
        $failed = $true
    } else {
        npm ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { "npm ci failed (exit $LASTEXITCODE)"; $failed = $true }
        if (-not $failed) {
            npx patchright install chromium
            if ($LASTEXITCODE -ne 0) { "playwright install failed (exit $LASTEXITCODE)"; $failed = $true }
        }
        if (-not $failed) {
            npm run build
            if ($LASTEXITCODE -ne 0) { "build failed (exit $LASTEXITCODE)"; $failed = $true }
        }
    }
}
"at: $(git describe --tags)"

# 3. start — always, so a failed step never leaves the server down
schtasks /Run /TN $TaskName | Out-Null
Start-Sleep 6
schtasks /Query /TN $TaskName /FO LIST | Select-String "Status"
if ($failed) { exit 1 }
