#!/usr/bin/env bash
set -euo pipefail

# ─── Thunderbird CLI — One-shot Setup ────────────────────────────────────────
# Run this after `git clone` to install dependencies, link commands globally,
# and get everything ready to go.

# ─── Colors ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

success() { echo -e "${GREEN}✓${RESET} $*"; }
error()   { echo -e "${RED}✗${RESET} $*"; }
info()    { echo -e "${CYAN}→${RESET} $*"; }

# ─── Detect repo root (directory where this script lives) ────────────────────
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── 1. Check prerequisites ─────────────────────────────────────────────────
info "Checking prerequisites..."

if ! command -v node &>/dev/null; then
    error "Node.js is not installed."
    echo ""
    echo "  Please install Node.js >= 18, then re-run this script."
    echo "  Recommended: https://nodejs.org/ or via nvm (https://github.com/nvm-sh/nvm)"
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/^v//' | cut -d. -f1)
if [[ "$NODE_VERSION" -lt 18 ]]; then
    error "Node.js $(node -v) found, but >= 18 is required."
    echo ""
    echo "  Please upgrade Node.js to v18 or later, then re-run this script."
    exit 1
fi

success "Node.js $(node -v) detected"

# ─── 2. Install dependencies ────────────────────────────────────────────────
info "Installing dependencies (npm install at repo root)..."
(
    cd "$DIR"
    npm install
)
success "Dependencies installed"

# ─── 3. Link the tb CLI globally ────────────────────────────────────────────
info "Linking tb CLI globally..."
(
    cd "$DIR/cli"
    npm link 2>/dev/null
) || {
    error "npm link failed in cli/ — this is usually a permissions issue."
    echo ""
    echo "  To fix this, either:"
    echo "    1. Use nvm (https://github.com/nvm-sh/nvm) to manage Node without sudo"
    echo "    2. Fix npm global prefix permissions:"
    echo "       mkdir -p ~/.npm-global && npm config set prefix '~/.npm-global'"
    echo "       then add ~/.npm-global/bin to your PATH"
    echo ""
    echo "  After fixing permissions, re-run this script."
    exit 1
}
success "tb command linked globally"

# ─── 4. Optionally link tb-bridge and tb-mcp ────────────────────────────────
echo ""
read -p "Also link tb-bridge and tb-mcp globally? [Y/n] " LINK_EXTRA
LINK_EXTRA="${LINK_EXTRA:-Y}"

if [[ "$LINK_EXTRA" =~ ^[Yy] ]]; then
    info "Linking tb-bridge globally..."
    (
        cd "$DIR/bridge"
        npm link 2>/dev/null
    ) || {
        error "npm link failed in bridge/"
        exit 1
    }
    success "tb-bridge linked globally"

    info "Linking tb-mcp globally..."
    (
        cd "$DIR/mcp"
        npm link 2>/dev/null
    ) || {
        error "npm link failed in mcp/"
        exit 1
    }
    success "tb-mcp linked globally"
else
    info "Skipping tb-bridge and tb-mcp global link."
fi

# ─── 5. Next Steps ──────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}══════════════════════════════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}  Setup complete! Here's what to do next:${RESET}"
echo -e "${BOLD}══════════════════════════════════════════════════════════════════════════${RESET}"
echo ""

# — Install the Thunderbird extension —
XPI_FILE=$(find "$DIR/dist/releases" -maxdepth 1 -name '*.xpi' 2>/dev/null | head -1)

echo -e "${CYAN}1. Install the Thunderbird extension${RESET}"
echo ""
if [[ -n "$XPI_FILE" ]]; then
    echo "   Extension file: $XPI_FILE"
else
    echo "   Extension file: $DIR/dist/releases/<extension>.xpi"
    echo "   (no .xpi file found in dist/releases/ yet — check the repo)"
fi
echo ""
echo "   Steps:"
echo "     a) Open Thunderbird"
echo "     b) Go to  Add-ons and Themes  (≡ menu → Add-ons and Themes)"
echo "     c) Click the ⚙ gear icon → Install Add-on From File…"
echo "     d) Select the .xpi file above"
echo "     e) Approve the installation when prompted"
echo ""

# — Verify the CLI works —
echo -e "${CYAN}2. Verify everything works${RESET}"
echo ""
echo "   tb health       # Check bridge + extension connection"
echo "   tb stats        # Show mailbox statistics"
echo ""

# — MCP server config —
REPO_DIR="$DIR"
# Resolve to absolute path in case of symlinks
REPO_DIR="$(cd "$REPO_DIR" && pwd)"

echo -e "${CYAN}3. MCP server config (for Claude Desktop, Cursor, etc.)${RESET}"
echo ""
echo "   Add this to your MCP client config file:"
echo ""
echo -e "   ${GREEN}{${RESET}"
echo -e "   ${GREEN}  \"mcpServers\": {${RESET}"
echo -e "   ${GREEN}    \"thunderbird\": {${RESET}"
echo -e "   ${GREEN}      \"command\": \"node\",${RESET}"
echo -e "   ${GREEN}      \"args\": [\"${REPO_DIR}/mcp/src/server.js\"]${RESET}"
echo -e "   ${GREEN}    }${RESET}"
echo -e "   ${GREEN}  }${RESET}"
echo -e "   ${GREEN}}${RESET}"
echo ""
echo -e "${BOLD}══════════════════════════════════════════════════════════════════════════${RESET}"
echo -e "  Done. Run ${CYAN}tb --help${RESET} to see all available commands."
echo -e "${BOLD}══════════════════════════════════════════════════════════════════════════${RESET}"
