# =============================================================================
# Thunderbird CLI — Windows Setup Script
# =============================================================================
# Run this after cloning the repo to install dependencies and link commands.
#
# Usage:
#   .\setup.ps1
# =============================================================================

$ErrorActionPreference = "Stop"

# ── Resolve repo root ───────────────────────────────────────────────────────
$RepoRoot = if ($PSScriptRoot) { $PSScriptRoot } else { $PWD.Path }

# ── Helper: colored output ──────────────────────────────────────────────────
function Write-Step {
    param([string]$Message)
    Write-Host "`n$Message" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Message)
    Write-Host "  ✓ $Message" -ForegroundColor Green
}

function Write-Fail {
    param([string]$Message)
    Write-Host "  ✗ $Message" -ForegroundColor Red
}

# ── Banner ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Thunderbird CLI — Windows Setup" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan

# ── Step 1: Check prerequisites ──────────────────────────────────────────────
Write-Step "Step 1 / 4: Checking prerequisites..."

# Check Node.js
$nodeExe = Get-Command "node" -ErrorAction SilentlyContinue
if (-not $nodeExe) {
    Write-Fail "Node.js is not installed."
    Write-Host ""
    Write-Host "  Please install Node.js >= 18 from https://nodejs.org" -ForegroundColor Red
    Write-Host "  After installing, restart your terminal and re-run this script." -ForegroundColor Red
    Write-Host ""
    exit 1
}

$nodeVersionRaw = & node --version
$nodeVersion = $nodeVersionRaw.TrimStart("v")
$nodeMajor = [int]($nodeVersion.Split(".")[0])

if ($nodeMajor -lt 18) {
    Write-Fail "Node.js $nodeVersion found — version 18 or higher is required."
    Write-Host ""
    Write-Host "  Please upgrade Node.js from https://nodejs.org" -ForegroundColor Red
    Write-Host "  After upgrading, restart your terminal and re-run this script." -ForegroundColor Red
    Write-Host ""
    exit 1
}

Write-Ok "Node.js $nodeVersion found (>= 18 ✓)"

# Check npm
$npmExe = Get-Command "npm" -ErrorAction SilentlyContinue
if (-not $npmExe) {
    Write-Fail "npm is not found on PATH."
    Write-Host ""
    Write-Host "  npm should be bundled with Node.js. Check your installation." -ForegroundColor Red
    Write-Host ""
    exit 1
}

$npmVersion = & npm --version
Write-Ok "npm $npmVersion found"

# ── Step 2: npm install (all workspaces) ─────────────────────────────────────
Write-Step "Step 2 / 4: Installing dependencies (all workspaces)..."

try {
    & npm install --prefix $RepoRoot 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) { throw "npm install exited with code $LASTEXITCODE" }
    Write-Ok "Dependencies installed"
} catch {
    Write-Fail "npm install failed: $_"
    exit 1
}

# ── Step 3: Link CLI globally ───────────────────────────────────────────────
Write-Step "Step 3 / 4: Linking commands globally..."

# Always link the main CLI (tb)
try {
    Push-Location (Join-Path $RepoRoot "cli")
    & npm link 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) { throw "npm link in cli/ exited with code $LASTEXITCODE" }
    Write-Ok "tb command linked globally"
    Pop-Location
} catch {
    Pop-Location
    Write-Fail "Failed to link 'tb': $_"
    Write-Host ""
    Write-Host "  Hint: This usually means you need to run this script as Administrator," -ForegroundColor Yellow
    Write-Host "        or check that your npm global prefix is writable." -ForegroundColor Yellow
    Write-Host "        Run 'npm prefix -g' to check, then:" -ForegroundColor Yellow
    Write-Host "        npm config set prefix '$env:APPDATA\npm'" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

# ── Step 4: Ask about linking tb-bridge and tb-mcp ───────────────────────────
Write-Step "Step 4 / 4: Optional — link tb-bridge and tb-mcp globally?"

Write-Host ""
Write-Host "  tb-bridge  — HTTP ↔ WebSocket proxy (the CLI auto-starts it when needed)"
Write-Host "  tb-mcp     — MCP server for AI agents (e.g. Claude Desktop)"
Write-Host ""

$answer = Read-Host "  Link both globally? [Y/n]"

if ($answer -eq "" -or $answer -match "^[Yy]") {
    # Link tb-bridge
    try {
        Push-Location (Join-Path $RepoRoot "bridge")
        & npm link 2>&1 | ForEach-Object { Write-Host "  $_" }
        if ($LASTEXITCODE -ne 0) { throw "npm link in bridge/ exited with code $LASTEXITCODE" }
        Write-Ok "tb-bridge command linked globally"
        Pop-Location
    } catch {
        Pop-Location
        Write-Fail "Failed to link 'tb-bridge': $_"
        Write-Host "  The CLI auto-starts the bridge, so this is optional." -ForegroundColor Yellow
    }

    # Link tb-mcp
    try {
        Push-Location (Join-Path $RepoRoot "mcp")
        & npm link 2>&1 | ForEach-Object { Write-Host "  $_" }
        if ($LASTEXITCODE -ne 0) { throw "npm link in mcp/ exited with code $LASTEXITCODE" }
        Write-Ok "tb-mcp command linked globally"
        Pop-Location
    } catch {
        Pop-Location
        Write-Fail "Failed to link 'tb-mcp': $_"
        Write-Host "  You can still run the MCP server directly with the full path." -ForegroundColor Yellow
    }
} else {
    Write-Host "  Skipped tb-bridge and tb-mcp linking." -ForegroundColor Yellow
}

# ── Locate the XPI ──────────────────────────────────────────────────────────
$xpiDir = Join-Path $RepoRoot "dist\releases"
$xpiFile = $null

if (Test-Path $xpiDir) {
    $xpiCandidates = Get-ChildItem -Path $xpiDir -Filter "*.xpi" -ErrorAction SilentlyContinue
    if ($xpiCandidates.Count -gt 0) {
        $xpiFile = $xpiCandidates[0]
    }
}

# ── Next Steps ───────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "  ✓ Setup Complete — Next Steps" -ForegroundColor Green
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Green

# 1. Install the Thunderbird extension
Write-Host ""
Write-Host "  1. Install the Thunderbird Extension" -ForegroundColor Cyan
Write-Host "     ─────────────────────────────────────────" -ForegroundColor DarkGray

if ($xpiFile) {
    Write-Host "     Extension file:" -ForegroundColor White
    Write-Host "     $($xpiFile.FullName)" -ForegroundColor White
    Write-Host ""
} else {
    Write-Host "     No .xpi file found in dist\releases\" -ForegroundColor Yellow
    Write-Host "     Build it first with:  npm run build:xpi" -ForegroundColor Yellow
    Write-Host ""
}

Write-Host "     In Thunderbird:" -ForegroundColor White
Write-Host "       1. Open Add-ons and Themes  (Tools → Add-ons and Themes)"
Write-Host "       2. Click the ⚙ gear icon at the top"
Write-Host "       3. Choose 'Install Add-on From File...'"
Write-Host "       4. Select the .xpi file shown above"
Write-Host "       5. Confirm the installation when prompted"

# 2. Verify the setup
Write-Host ""
Write-Host "  2. Verify the Setup" -ForegroundColor Cyan
Write-Host "     ─────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host "     tb health          # Check bridge + extension connection"
Write-Host "     tb stats           # Show mailbox statistics"

# 3. MCP server config for Claude Desktop
$mcpServerPath = Join-Path $RepoRoot "mcp\src\server.js"

# Build the JSON snippet with the actual repo path (backslashes for Windows)
$mcpJson = @{
    mcpServers = @{
        thunderbird = @{
            command = "node"
            args    = @($mcpServerPath)
        }
    }
} | ConvertTo-Json -Depth 5

# ConvertTo-Json uses single backslashes — that's valid JSON
$mcpJsonLines = $mcpJson -split "`n"

Write-Host ""
Write-Host "  3. MCP Server Config (for Claude Desktop)" -ForegroundColor Cyan
Write-Host "     ─────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host "     Add this to your Claude Desktop config file:"
Write-Host "     (usually %APPDATA%\Claude\claude_desktop_config.json)"
Write-Host ""
foreach ($line in $mcpJsonLines) {
    Write-Host "     $line" -ForegroundColor White
}

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "  All done — happy emailing! 📬" -ForegroundColor Green
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host ""
