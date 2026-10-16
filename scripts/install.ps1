# RIGS OS installer for Windows 10/11. Run in an *elevated* PowerShell:
#   irm https://raw.githubusercontent.com/XmXx/rigs/main/scripts/install.ps1 | iex
# Options via environment variables before running:
#   $env:RIGS_DIR="$HOME\.rigs\app"; $env:RIGS_NAME="gaming-pc"; $env:RIGS_AGENTS="1"; $env:RIGS_DESKTOP="1"; $env:RIGS_WSL="1"
$ErrorActionPreference = 'Stop'
$RigsDir = if ($env:RIGS_DIR) { $env:RIGS_DIR } else { Join-Path $HOME '.rigs\app' }
$Repo = if ($env:RIGS_REPO) { $env:RIGS_REPO } else { 'https://github.com/XmXx/rigs.git' }
$Agents = if ($env:RIGS_AGENTS) { $env:RIGS_AGENTS } else { '1' }
$Desktop = if ($env:RIGS_DESKTOP) { $env:RIGS_DESKTOP } else { '1' }

function Step($m) { Write-Host "`n> $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "  ok  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  !   $m" -ForegroundColor Yellow }
function Have($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ";$env:APPDATA\npm;$HOME\.local\bin" }
function WinGet($id) { winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements | Out-Null; Refresh-Path }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Warn 'Not elevated: OpenSSH Server, Sunshine and firewall steps will be skipped. Re-run in an Administrator PowerShell for the full setup.' }

Step 'Prerequisites'
if (-not (Have winget)) { throw 'winget is required (App Installer from the Microsoft Store).' }
if (-not (Have git)) { WinGet 'Git.Git' }
$nodeOk = $false
if (Have node) { $nodeOk = [int](node -p "process.versions.node.split('.')[0]") -ge 22 }
if (-not $nodeOk) { WinGet 'OpenJS.NodeJS.LTS' }
Ok "git $(git --version) · node $(node -v)"

Step 'Tailscale'
if (-not (Have tailscale)) { WinGet 'Tailscale.Tailscale' }
$ts = & tailscale status 2>$null
if ($LASTEXITCODE -ne 0) { Warn 'Sign in to Tailscale from the tray icon (same account as your other machines), then re-run this script.'; & tailscale up 2>$null } else { Ok "Tailscale up: $(tailscale ip -4)" }

Step 'SSH server'
if ($admin) {
  $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*'
  if ($cap.State -ne 'Installed') { Add-WindowsCapability -Online -Name $cap.Name | Out-Null }
  Set-Service sshd -StartupType Automatic; Start-Service sshd
  # PowerShell as the default SSH shell.
  New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force | Out-Null
  # Let admins use ~/.ssh/authorized_keys (which RIGS manages) instead of ProgramData.
  $cfg = "$env:ProgramData\ssh\sshd_config"
  if (Test-Path $cfg) {
    $t = Get-Content $cfg -Raw
    $t2 = $t -replace '(?m)^(Match Group administrators)', '#$1' -replace '(?m)^(\s+AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys)', '#$1'
    if ($t2 -ne $t) { Set-Content $cfg $t2; Restart-Service sshd }
  }
  # Only reachable over Tailscale: allow 22 on the tailnet range.
  if (-not (Get-NetFirewallRule -DisplayName 'RIGS SSH (tailnet)' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'RIGS SSH (tailnet)' -Direction Inbound -Protocol TCP -LocalPort 22 -RemoteAddress 100.64.0.0/10 -Action Allow | Out-Null
  }
  if (-not (Get-NetFirewallRule -DisplayName 'RIGS node (tailnet)' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'RIGS node (tailnet)' -Direction Inbound -Protocol TCP -LocalPort 4719 -RemoteAddress 100.64.0.0/10 -Action Allow | Out-Null
  }
  Ok 'OpenSSH Server running (PowerShell shell), firewall open to the tailnet only'
}

if ($Agents -eq '1') {
  Step 'Coding agents'
  if (-not (Have claude)) { try { Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression; Refresh-Path } catch { Warn "Claude Code install failed: $_" } }
  if (Have claude) { Ok "Claude Code $(claude --version)" }
  if (-not (Have codex)) { npm install -g @openai/codex | Out-Null; Refresh-Path }
  if (Have codex) { Ok "Codex $(codex --version)" }
  if (-not (Have ollama)) { WinGet 'Ollama.Ollama' }
  if (Have ollama) { Ok "Ollama $(ollama --version)" }
}

if ($Desktop -eq '1') {
  Step 'Remote desktop (Sunshine host + Moonlight client, NVENC/AMF/QuickSync)'
  if ($admin) { WinGet 'LizardByte.Sunshine' } else { Warn 'Sunshine needs an elevated shell' }
  WinGet 'MoonlightGameStreamingProject.Moonlight'
  if ($admin -and -not (Get-NetFirewallRule -DisplayName 'RIGS Sunshine (tailnet)' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'RIGS Sunshine (tailnet)' -Direction Inbound -Protocol TCP -LocalPort 47984,47989,47990,48010 -RemoteAddress 100.64.0.0/10 -Action Allow | Out-Null
    New-NetFirewallRule -DisplayName 'RIGS Sunshine UDP (tailnet)' -Direction Inbound -Protocol UDP -LocalPort 47998-48000,48002,48010 -RemoteAddress 100.64.0.0/10 -Action Allow | Out-Null
  }
  Ok 'Sunshine + Moonlight installed'
}

if ($env:RIGS_WSL -eq '1') {
  Step 'WSL (for OpenRig, which needs tmux)'
  if ($admin) { wsl --install -d Ubuntu --no-launch; Warn 'After reboot, open Ubuntu and run the Linux installer inside WSL to get OpenRig there.' }
}

Step "RIGS -> $RigsDir"
if (Test-Path "$RigsDir\.git") { git -C $RigsDir pull --ff-only } else { New-Item -ItemType Directory -Force (Split-Path $RigsDir) | Out-Null; git clone $Repo $RigsDir }
Push-Location $RigsDir
npm install --no-audit --no-fund
$bin = Join-Path $HOME '.local\bin'
New-Item -ItemType Directory -Force $bin | Out-Null
Set-Content -Path (Join-Path $bin 'rigs.cmd') -Value "@echo off`r`nnode `"$RigsDir\bin\rigs.js`" %*"
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$bin*") { [Environment]::SetEnvironmentVariable('Path', "$userPath;$bin", 'User') }
Ok 'rigs CLI -> ~\.local\bin\rigs.cmd'

$args2 = @('bin\rigs.js', 'setup')
if ($env:RIGS_NAME) { $args2 += @('--name', $env:RIGS_NAME) }
if ($Desktop -eq '1') { $args2 += '--desktop' }
node @args2
Pop-Location

Write-Host "`nNext: sign in to the agents you use (once per machine):  claude  ·  codex login  ·  gh auth login"
Write-Host 'Open the UI:  rigs open   (or http://localhost:4719)'
