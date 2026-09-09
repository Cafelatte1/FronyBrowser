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

# 0. unlock handoff (FWL-042) — ask the running server to leave a short-lived DPAPI file so the
#    new process resumes the vault unlock with the same deadline. Needs an admin device key in
#    FRONY_KEY; without it (or with a locked vault) the vault simply stays locked after restart.
$walletServer = if ($env:WALLET_SERVER) { $env:WALLET_SERVER } else { "http://$(tailscale ip -4 2>$null | Select-Object -First 1):9420" }
if ($env:FRONY_KEY) {
    try {
        $r = Invoke-RestMethod -Method Post -Uri "$walletServer/vault/handoff" -Headers @{ authorization = "Bearer $env:FRONY_KEY" } -TimeoutSec 10
        "unlock handoff: ok ($([math]::Round($r.remainingMs / 60000)) min left)"
    } catch {
        "unlock handoff: skipped ($($_.Exception.Message)) - run 'wallet unlock' after restart"
    }
} else {
    "unlock handoff: skipped (FRONY_KEY not set) - run 'wallet unlock' after restart"
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
