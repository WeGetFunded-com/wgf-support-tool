#!/bin/sh
set -e

# ─────────────────────────────────────────────────
#  WGF Support Shell — Installateur macOS / Linux
# ─────────────────────────────────────────────────

REPO="WeGetFunded-com/wgf-support-tool"
DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/wgf-support.cjs"
INSTALL_DIR="$HOME/.wgf-support-tool"
BIN_FILE="$INSTALL_DIR/wgf-support.cjs"
WRAPPER="$INSTALL_DIR/wgf-support"
NODE_MIN_VERSION=18

# ── Couleurs ──
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()    { printf "${BLUE}  [i] %s${NC}\n" "$1"; }
success() { printf "${GREEN}  [OK] %s${NC}\n" "$1"; }
warn()    { printf "${YELLOW}  [!] %s${NC}\n" "$1"; }
fail()    { printf "${RED}  [ERR] %s${NC}\n" "$1"; exit 1; }

echo ""
echo "  WGF Support Shell — Installation"
echo "  ─────────────────────────────────"
echo ""

# ── 1. Detecter l'OS ──
OS="$(uname -s)"
case "$OS" in
  Linux*)  PLATFORM="linux" ;;
  Darwin*) PLATFORM="macos" ;;
  *)       fail "Systeme non supporte : $OS" ;;
esac
info "Systeme detecte : $PLATFORM"

# ── 2. Verifier / installer Node.js ──
check_node_version() {
  if command -v node >/dev/null 2>&1; then
    NODE_VER="$(node -v | sed 's/v//' | cut -d. -f1)"
    if [ "$NODE_VER" -ge "$NODE_MIN_VERSION" ] 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

if check_node_version; then
  success "Node.js $(node -v) detecte"
else
  warn "Node.js >= $NODE_MIN_VERSION requis mais non trouve."
  info "Installation de Node.js..."

  if command -v curl >/dev/null 2>&1; then
    FETCH="curl -fsSL"
  elif command -v wget >/dev/null 2>&1; then
    FETCH="wget -qO-"
  else
    fail "curl ou wget requis pour installer Node.js"
  fi

  $FETCH https://fnm.vercel.app/install | sh -s -- --skip-shell

  export FNM_DIR="$HOME/.local/share/fnm"
  export PATH="$FNM_DIR:$PATH"

  if command -v fnm >/dev/null 2>&1; then
    fnm install "$NODE_MIN_VERSION"
    eval "$(fnm env)"
  else
    fail "Echec. Installez Node.js manuellement : https://nodejs.org"
  fi

  if check_node_version; then
    success "Node.js $(node -v) installe"
  else
    fail "Echec. Installez Node.js manuellement : https://nodejs.org"
  fi
fi

# ── 3. Verifier kubectl ──
if command -v kubectl >/dev/null 2>&1; then
  success "kubectl detecte"
else
  warn "kubectl non trouve. Installation..."
  mkdir -p "$INSTALL_DIR"

  ARCH="$(uname -m)"
  if [ "$PLATFORM" = "macos" ]; then
    case "$ARCH" in
      x86_64) KUBE_ARCH="amd64" ;;
      arm64)  KUBE_ARCH="arm64" ;;
      *)      fail "Architecture non supportee : $ARCH" ;;
    esac
    KUBE_OS="darwin"
  else
    case "$ARCH" in
      x86_64)  KUBE_ARCH="amd64" ;;
      aarch64) KUBE_ARCH="arm64" ;;
      *)       fail "Architecture non supportee : $ARCH" ;;
    esac
    KUBE_OS="linux"
  fi

  curl -fsSLo "$INSTALL_DIR/kubectl" "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/${KUBE_OS}/${KUBE_ARCH}/kubectl"
  chmod +x "$INSTALL_DIR/kubectl"

  if "$INSTALL_DIR/kubectl" version --client >/dev/null 2>&1; then
    success "kubectl installe"
  else
    fail "Echec. Installez kubectl manuellement : https://kubernetes.io/docs/tasks/tools/"
  fi
fi

# ── 4. Telecharger l'outil ──
info "Telechargement de WGF Support Shell..."
mkdir -p "$INSTALL_DIR"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$DOWNLOAD_URL" -o "$BIN_FILE"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$DOWNLOAD_URL" -O "$BIN_FILE"
fi

success "Outil telecharge"

# ── 5. Creer le wrapper executable ──
cat > "$WRAPPER" << 'SCRIPT'
#!/bin/sh
TOOL_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="$TOOL_DIR:$PATH"
exec node "$TOOL_DIR/wgf-support.cjs" "$@"
SCRIPT
chmod +x "$WRAPPER"

# ── 6. Ajouter au PATH ──
SHELL_NAME="$(basename "$SHELL")"
case "$SHELL_NAME" in
  zsh)  RC_FILE="$HOME/.zshrc" ;;
  bash) RC_FILE="$HOME/.bashrc" ;;
  *)    RC_FILE="$HOME/.profile" ;;
esac

PATH_LINE="export PATH=\"\$HOME/.wgf-support-tool:\$PATH\""

if ! grep -qF ".wgf-support-tool" "$RC_FILE" 2>/dev/null; then
  echo "" >> "$RC_FILE"
  echo "# WGF Support Shell" >> "$RC_FILE"
  echo "$PATH_LINE" >> "$RC_FILE"
  warn "PATH mis a jour dans $RC_FILE"
fi

# Si fnm a ete installe, ajouter l'init fnm au shell RC
if command -v fnm >/dev/null 2>&1; then
  if ! grep -qF "fnm env" "$RC_FILE" 2>/dev/null; then
    echo "" >> "$RC_FILE"
    echo "# fnm (Node.js version manager)" >> "$RC_FILE"
    echo 'eval "$(fnm env)"' >> "$RC_FILE"
    warn "fnm env ajoute dans $RC_FILE"
  fi
fi

echo ""
echo "  ─────────────────────────────────"
success "Installation terminee !"
echo ""
info "Dossier : $INSTALL_DIR"
info "Placez le fichier .env fourni par votre admin dans ce dossier."
echo ""
warn "Redemarrez votre terminal, puis lancez : wgf-support"
echo ""
