#!/usr/bin/env bash
set -euo pipefail

# Accept command-line options
SKIP_MODELS=false
INSTALL_OLLAMA=false
INSTALL_LMSTUDIO=false
INSTALL_VLLM=false
VLLM_MODEL=""
SKIP_SYNC=false
SKIP_DOCTOR=false
LAUNCH=false
PROVIDER=""
MODEL_LIST=""
SHOW_HELP=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --skip-models) SKIP_MODELS=true; shift ;;
    --install-ollama) INSTALL_OLLAMA=true; shift ;;
    --install-lmstudio) INSTALL_LMSTUDIO=true; shift ;;
    --install-vllm) INSTALL_VLLM=true; shift ;;
    --vllm-model) VLLM_MODEL="$2"; shift 2 ;;
    --skip-sync) SKIP_SYNC=true; shift ;;
    --skip-doctor) SKIP_DOCTOR=true; shift ;;
    --launch) LAUNCH=true; shift ;;
    --provider) PROVIDER="$2"; shift 2 ;;
    --models) MODEL_LIST="$2"; shift 2 ;;
    -h|--help) SHOW_HELP=true; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ "$SHOW_HELP" = true ]; then
  cat <<'HELPEOF'
OpenCode Local Setup - Unix Installer (Linux/macOS)

Usage:
  ./scripts/install.sh                              # Full auto-setup with defaults
  ./scripts/install.sh --install-ollama             # Auto-install Ollama + models
  ./scripts/install.sh --install-vllm               # Auto-install vLLM + Python venv
  ./scripts/install.sh --provider ollama            # Use Ollama as primary provider
  ./scripts/install.sh --models phi-3-mini llama-3.1-8b  # Specific models
  ./scripts/install.sh --skip-models                # Skip model download
  ./scripts/install.sh --launch                     # Setup everything and launch OpenCode

Options:
  --install-ollama       Auto-install Ollama if not present
  --install-lmstudio     Prompt to install LM Studio
  --install-vllm         Auto-install vLLM in Python venv (requires NVIDIA GPU)
  --vllm-model <repo>    HuggingFace repo for vLLM serve (e.g. meta-llama/Llama-3.1-8B-Instruct)
  --provider <name>      Primary provider: ollama, lmstudio, vllm (auto-detected by default)
  --models <comma-list>  Model IDs to download (from models.json)
  --skip-models          Skip automatic model download
  --skip-sync            Skip post-download model sync
  --skip-doctor          Skip configuration health check
  --launch               Launch OpenCode after setup completes
HELPEOF
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
SETUP_DIR="${OPENCODE_LOCAL_SETUP_DIR:-$CONFIG_DIR/local-setup}"
CONFIG_FILE="${OPENCODE_CONFIG:-$CONFIG_DIR/opencode.json}"
ENV_FILE="$SETUP_DIR/.env.local"
START_MARKER="# >>> opencode-local-setup >>>"
END_MARKER="# <<< opencode-local-setup <<<"

echo "OpenCode Local Setup (Unix)"
echo "==========================="

# Detect OS
detect_os() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    echo "${ID:-unknown}"
  elif [ "$(uname)" = "Darwin" ]; then
    echo "macos"
  else
    echo "unknown"
  fi
}

OS_DISTRO="$(detect_os)"
echo "Detected OS: $OS_DISTRO ($(uname -s))"

# --- Node.js check and install ---
install_nodejs() {
  echo ""
  echo "[1/8] Checking Node.js..."

  if command -v node >/dev/null 2>&1; then
    NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
    if [ "$NODE_MAJOR" -ge 18 ]; then
      echo "✓ Node.js $(node --version)"
      return 0
    else
      echo "! Node.js 18+ required; found $(node --version). Upgrading..."
    fi
  else
    echo "! Node.js not found. Installing..."
  fi

  local os_type
  os_type="$(uname -s)"

  case "$os_type" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        echo "  Installing via Homebrew..."
        brew install node@20
        echo "✓ Node.js installed via Homebrew"
      else
        echo "! Homebrew not found. Install from https://brew.sh/"
        echo "  Then run: brew install node@20"
        return 1
      fi
      ;;
    Linux)
      case "$OS_DISTRO" in
        ubuntu|debian|linuxmint)
          echo "  Installing via NodeSource APT repository..."
          curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
          sudo apt-get install -y nodejs
          echo "✓ Node.js installed via APT"
          ;;
        fedora|rhel|centos|rocky)
          echo "  Installing via NodeSource YUM repository..."
          curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo -E bash -
          sudo dnf install -y nodejs || sudo yum install -y nodejs
          echo "✓ Node.js installed via DNF/YUM"
          ;;
        arch|manjaro)
          echo "  Installing via pacman..."
          sudo pacman -S --noconfirm nodejs
          echo "✓ Node.js installed via pacman"
          ;;
        opensuse*tumbleweed|opensuse*leap)suse
          echo "  Installing via zypper..."
          sudo zypper install -y nodejs20
          echo "✓ Node.js installed via zypper"
          ;;
        *)
          echo "! Unsupported distro: $OS_DISTRO"
          echo "  Install Node.js 18+ from https://nodejs.org/"
          return 1
          ;;
      esac
      ;;
  esac

  if command -v node >/dev/null 2>&1; then
    echo "✓ Node.js $(node --version)"
  fi
}

install_nodejs

# --- OpenCode check and install ---
echo ""
echo "[2/8] Checking OpenCode..."

if command -v opencode >/dev/null 2>&1; then
  echo "✓ OpenCode $(opencode --version 2>/dev/null || echo installed)"
else
  echo "! OpenCode not found. Installing..."
  # Note: piping remote scripts is a supply-chain risk. Verify the script first if concerned:
  #   curl -fsSL https://opencode.ai/install -o /tmp/opencode-install.sh && cat /tmp/opencode-install.sh
  if curl -fsSL https://opencode.ai/install | bash; then
    echo "✓ OpenCode installed"
  else
    echo "! OpenCode installation failed. Install manually:"
    echo "  curl -fsSL https://opencode.ai/install | bash"
  fi
fi

# --- Create directories ---
echo ""
echo "[3/8] Creating directories..."

mkdir -p "$SETUP_DIR" "$(dirname "$CONFIG_FILE")"
chmod 700 "$SETUP_DIR" 2>/dev/null || true
echo "✓ Config: $CONFIG_DIR"
echo "✓ Setup:  $SETUP_DIR"

# --- GPU detection for vLLM ---
detect_gpu() {
  local gpu_type="none"

  if command -v nvidia-smi >/dev/null 2>&1; then
    local gpu_name
    gpu_name="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)"
    if [ -n "$gpu_name" ]; then
      echo "nvidia:$gpu_name"
      return 0
    fi
  fi

  if command -v rocm-smi >/dev/null 2>&1; then
    local gpu_name
    gpu_name="$(rocm-smi --showproductname 2>/dev/null | head -1)"
    if [ -n "$gpu_name" ]; then
      echo "amd:$gpu_name"
      return 0
    fi
  fi

  echo "none:"
  return 1
}

# --- Install vLLM in Python venv ---
install_vllm() {
  local venv_dir="$SETUP_DIR/vllm-env"
  echo "  Installing vLLM..."

  # Check for NVIDIA GPU first
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo "! NVIDIA GPU not detected (nvidia-smi not found)."
    echo "  vLLM requires a CUDA-capable GPU. Continuing anyway (--install-vllm was explicit)."
  else
    local gpu_info
    gpu_info="$(detect_gpu)" || true
    if [ "$gpu_info" != "none:" ]; then
      echo "  ✓ GPU detected: $gpu_info"
    fi
  fi

  # Check Python3
  if ! command -v python3 >/dev/null 2>&1; then
    echo "! python3 not found. Install it first, then retry."
    return 1
  fi

  local pyver
  pyver="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
  if [ "$(echo "$pyver" | cut -d. -f2)" -lt 9 ]; then
    echo "! Python 3.9+ required for vLLM; found $pyver."
    return 1
  fi

  # Create venv
  if [ ! -d "$venv_dir" ]; then
    echo "  Creating Python venv at $venv_dir..."
    python3 -m venv "$venv_dir" || {
      echo "! Failed to create venv. Install python3-venv package."
      return 1
    }
  fi

  # Activate and install vLLM
  local pip_bin="$venv_dir/bin/pip"
  local python_bin="$venv_dir/bin/python"

  "$pip_bin" install --upgrade pip setuptools wheel >/dev/null 2>&1 || true

  echo "  Installing vllm (this may take several minutes)..."
  if "$pip_bin" install vllm; then
    echo "✓ vLLM installed in $venv_dir"
    local vllm_ver
    vllm_ver="$("$python_bin" -c 'import vllm; print(vllm.__version__)' 2>/dev/null || echo '?')"
    echo "  Version: $vllm_ver"

    # Create server management script
    cat > "$SETUP_DIR/vllm-server.sh" <<VLLMEOF
#!/usr/bin/env bash
# vLLM server lifecycle manager
set -euo pipefail

VENV_DIR="$venv_dir"
PID_FILE="\${XDG_CONFIG_HOME:-\$HOME/.config}/opencode/local-setup/.vllm.pid"
PORT=8000
HEALTH_RETRIES=30

activate_venv() {
  source "\$VENV_DIR/bin/activate"
}

is_running() {
  if [ -f "\$PID_FILE" ]; then
    local pid=\$(cat "\$PID_FILE")
    if kill -0 "\$pid" 2>/dev/null; then
      return 0
    fi
    rm -f "\$PID_FILE"
  fi
  curl -fsS http://127.0.0.1:\$PORT/v1/models >/dev/null 2>&1
}

start_server() {
  local model="\${1:-}"
  if [ -z "\$model" ]; then
    echo "Error: No model specified. Usage: vllm-server.sh start <hf-repo>" >&2
    return 1
  fi

  if is_running; then
    echo "vLLM server already running (PID \$(cat \$PID_FILE 2>/dev/null || echo '?'))"
    return 0
  fi

  activate_venv
  echo "Starting vLLM server with model: \$model"
  CUDA_VISIBLE_DEVICES="\${CUDA_VISIBLE_DEVICES:-0}" \\
    vllm serve "\$model" \\
      --host 127.0.0.1 \\
      --port \$PORT \\
      --max-model-len 8192 \\
      --disable-log-requests &>/dev/null &

  local pid=\$!
  echo "\$pid" > "\$PID_FILE"
  chmod 600 "\$PID_FILE" 2>/dev/null || true

  # Health check: wait for server to be ready
  local i=0
  while [ \$i -lt \$HEALTH_RETRIES ]; do
    if curl -fsS http://127.0.0.1:\$PORT/v1/models >/dev/null 2>&1; then
      echo "✓ vLLM server ready (PID \$pid)"
      return 0
    fi
    i=\$((i + 1))
    sleep 2
  done

  echo "! vLLM server did not become healthy in \${HEALTH_RETRIES} attempts."
  kill "\$pid" 2>/dev/null || true
  rm -f "\$PID_FILE"
  return 1
}

stop_server() {
  if [ -f "\$PID_FILE" ]; then
    local pid=\$(cat "\$PID_FILE")
    echo "Stopping vLLM server (PID \$pid)..."
    kill "\$pid" 2>/dev/null || true
    sleep 1
    kill -0 "\$pid" 2>/dev/null && kill -9 "\$pid" 2>/dev/null || true
    rm -f "\$PID_FILE"
    echo "✓ vLLM server stopped"
  else
    # Fallback: find and kill by port
    local pid
    pid=\$(lsof -ti:\$PORT 2>/dev/null || fuser \$PORT/tcp 2>/dev/null | tr -d ' ')
    if [ -n "\$pid" ]; then
      echo "Stopping vLLM server (PID \$pid, found via port)..."
      kill "\$pid" 2>/dev/null || true
      sleep 1
      kill -0 "\$pid" 2>/dev/null && kill -9 "\$pid" 2>/dev/null || true
    else
      echo "vLLM server not running"
    fi
  fi
}

status_server() {
  if is_running; then
    local pid=\$(cat "\$PID_FILE" 2>/dev/null || echo '?')
    echo "vLLM server is running (PID \$pid)"
    return 0
  else
    echo "vLLM server is not running"
    return 1
  fi
}

case "\${1:-status}" in
  start) start_server "\${2:-}" ;;
  stop) stop_server ;;
  restart) stop_server; sleep 1; start_server "\${2:-}" ;;
  status) status_server ;;
  *) echo "Usage: \$0 {start <model>|stop|restart <model>|status}" >&2; exit 1 ;;
esac
VLLMEOF
    chmod +x "$SETUP_DIR/vllm-server.sh"
    echo "✓ Created vllm-server.sh at $SETUP_DIR/vllm-server.sh"

  else
    echo "! Failed to install vLLM. Check pip output above."
    return 1
  fi
}

# --- Install Ollama if requested or not present ---
echo ""
echo "[4/8] Checking model servers..."

install_ollama() {
  echo "  Installing Ollama..."
  if command -v curl >/dev/null 2>&1; then
    # Note: piping remote scripts is a supply-chain risk. Verify first if concerned:
    #   curl -fsSL https://ollama.com/install.sh -o /tmp/ollama-install.sh && cat /tmp/ollama-install.sh
    if curl -fsSL https://ollama.com/install.sh | sh; then
      echo "✓ Ollama installed"
      # Start Ollama service if possible
      if command -v systemctl >/dev/null 2>&1; then
        systemctl --user enable ollama 2>/dev/null || true
        systemctl --user start ollama 2>/dev/null || true
      fi
    else
      echo "! Ollama installation failed. Install from https://ollama.com/"
    fi
  else
    echo "! curl not found. Install Ollama from https://ollama.com/"
  fi
}

if [ "$INSTALL_OLLAMA" = true ]; then
  if ! command -v ollama >/dev/null 2>&1; then
    install_ollama
  else
    echo "✓ Ollama already installed: $(ollama --version 2>/dev/null || echo 'installed')"
  fi
elif ! command -v ollama >/dev/null 2>&1 && [ -z "$PROVIDER" ]; then
  echo "! Ollama not found. To install automatically, run:"
  echo "  ./scripts/install.sh --install-ollama"
fi

# Check LM Studio
if command -v lms >/dev/null 2>&1; then
  echo "✓ LM Studio CLI found"
elif curl -fsS http://127.0.0.1:1234/v1/models >/dev/null 2>&1; then
  echo "✓ LM Studio is running"
else
  if [ "$INSTALL_LMSTUDIO" = true ]; then
    echo "! LM Studio not found. Download from https://lmstudio.ai/"
  fi
fi

# Install vLLM if requested
if [ "$INSTALL_VLLM" = true ]; then
  install_vllm || {
    echo "! vLLM installation failed."
  }
elif curl -fsS http://127.0.0.1:8000/v1/models >/dev/null 2>&1; then
  echo "✓ vLLM server is running"
fi

# --- Determine primary provider ---
if [ -z "$PROVIDER" ]; then
  if curl -fsS http://127.0.0.1:8000/v1/models >/dev/null 2>&1; then
    PROVIDER="vllm"
  elif command -v ollama >/dev/null 2>&1; then
    PROVIDER="ollama"
  elif curl -fsS http://127.0.0.1:1234/v1/models >/dev/null 2>&1; then
    PROVIDER="lmstudio"
  else
    PROVIDER="lmstudio"
  fi
fi
echo "Primary provider: $PROVIDER"

# --- Copy scripts ---
echo ""
echo "[5/8] Installing helper scripts..."

for name in providers.mjs sync-core.mjs sync-provider.mjs sync-local-models.mjs sync-on-launch.mjs doctor.mjs setup-env.mjs download-models.mjs; do
  if [ -f "$REPO_DIR/scripts/$name" ]; then
    install -m 700 "$REPO_DIR/scripts/$name" "$SETUP_DIR/$name"
  fi
done
install -m 700 "$REPO_DIR/scripts/opencode-wrapper.sh" "$SETUP_DIR/opencode-wrapper.sh"

# --- Create/update .env.local ---
echo ""
echo "[6/8] Configuring environment..."

if [ ! -f "$ENV_FILE" ]; then
  case "$PROVIDER" in
    ollama)
      cat > "$ENV_FILE" <<'ENVEOF'
# OpenCode Local Setup - Environment
# Primary model server endpoint
LOCAL_API_BASE=http://127.0.0.1:11434/v1

# Provider identification
OPENCODE_PROVIDER_ID=ollama
OPENCODE_PROVIDER_NAME="Ollama (local)"

# --- Local server authentication (optional) ---
# LOCAL_API_KEY=

# --- Cloud provider API keys (set as needed) ---
# OPENAI_API_KEY=sk-...
# FIREWORKS_API_KEY=fw_...
# DEEPSEEK_API_KEY=sk-...
# XAI_API_KEY=xai-...
# GROQ_API_KEY=gsk_...
# TOGETHER_API_KEY=...
# MISTRAL_API_KEY=...
# OPENROUTER_API_KEY=sk-or-...
# DASHSCOPE_API_KEY=sk-...
# ALIBABA_API_KEY=sk-...

# --- Remote OpenAI-compatible servers ---
# REMOTE_API_BASE=https://your-server.com/v1
# REMOTE_API_KEY=...

# --- Tailscale discovery (opt-in) ---
# OPENCODE_TAILSCALE_DISCOVERY=1
# OPENCODE_TAILSCALE_PORTS=1234,8000,8080,11434
ENVEOF
      ;;
    vllm)
      cat > "$ENV_FILE" <<VLLMEOF
# OpenCode Local Setup - Environment
# Primary model server endpoint
LOCAL_API_BASE=http://127.0.0.1:8000/v1

# Provider identification
OPENCODE_PROVIDER_ID=vllm
OPENCODE_PROVIDER_NAME="vLLM (local)"

# --- vLLM configuration ---
VLLM_HOST=127.0.0.1:8000
VLLM_MODEL="${VLLM_MODEL:-meta-llama/Meta-Llama-3.1-8B-Instruct}"
VLLM_VENV_DIR="$SETUP_DIR/vllm-env"
VLLM_SERVER_SCRIPT="$SETUP_DIR/vllm-server.sh"

# --- Local server authentication (optional) ---
# LOCAL_API_KEY=

# --- Cloud provider API keys (set as needed) ---
# OPENAI_API_KEY=sk-...
# FIREWORKS_API_KEY=fw_...
# DEEPSEEK_API_KEY=sk-...
# XAI_API_KEY=xai-...
# GROQ_API_KEY=gsk_...
# TOGETHER_API_KEY=...
# MISTRAL_API_KEY=...
# OPENROUTER_API_KEY=sk-or-...
# DASHSCOPE_API_KEY=sk-...
# ALIBABA_API_KEY=sk-...

# --- Remote OpenAI-compatible servers ---
# REMOTE_API_BASE=https://your-server.com/v1
# REMOTE_API_KEY=...

# --- Tailscale discovery (opt-in) ---
# OPENCODE_TAILSCALE_DISCOVERY=1
# OPENCODE_TAILSCALE_PORTS=1234,8000,8080,11434
VLLMEOF
      ;;
    *)
       cat > "$ENV_FILE" <<'ENVEOF'
# OpenCode Local Setup - Environment
# Primary model server endpoint
LOCAL_API_BASE=http://127.0.0.1:1234/v1

# Provider identification
OPENCODE_PROVIDER_ID=lmstudio
OPENCODE_PROVIDER_NAME="LM Studio (local)"

# --- Local server authentication (optional) ---
# LOCAL_API_KEY=

# --- Cloud provider API keys (set as needed) ---
# OPENAI_API_KEY=sk-...
# FIREWORKS_API_KEY=fw_...
# DEEPSEEK_API_KEY=sk-...
# XAI_API_KEY=xai-...
# GROQ_API_KEY=gsk_...
# TOGETHER_API_KEY=...
# MISTRAL_API_KEY=...
# OPENROUTER_API_KEY=sk-or-...
# DASHSCOPE_API_KEY=sk-...
# ALIBABA_API_KEY=sk-...

# --- Remote OpenAI-compatible servers ---
# REMOTE_API_BASE=https://your-server.com/v1
# REMOTE_API_KEY=...

# --- Tailscale discovery (opt-in) ---
# OPENCODE_TAILSCALE_DISCOVERY=1
# OPENCODE_TAILSCALE_PORTS=1234,8000,8080,11434
ENVEOF
       ;;
  esac
  chmod 600 "$ENV_FILE"
  echo "✓ Created $ENV_FILE (mode 600)"
else
  echo "✓ Preserved existing $ENV_FILE"
fi

# --- Create opencode.json ---
echo ""
echo "[7/8] Generating configuration..."

if [ ! -f "$CONFIG_FILE" ]; then
  case "$PROVIDER" in
    ollama)
      cat > "$CONFIG_FILE" <<'JSONEOF'
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": "notify",
  "share": "manual",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (local)",
      "options": {
        "baseURL": "http://127.0.0.1:11434/v1"
      },
      "models": {}
    }
  }
}
JSONEOF
      ;;
    vllm)
       cat > "$CONFIG_FILE" <<'JSONEOF'
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": "notify",
  "share": "manual",
  "provider": {
    "vllm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "vLLM (local)",
      "options": {
        "baseURL": "http://127.0.0.1:8000/v1"
      },
      "models": {}
    }
  }
}
JSONEOF
      ;;
    *)
       cat > "$CONFIG_FILE" <<'JSONEOF'
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": "notify",
  "share": "manual",
  "provider": {
    "lmstudio": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LM Studio (local)",
      "options": {
        "baseURL": "http://127.0.0.1:1234/v1"
      },
      "models": {}
    }
  }
}
JSONEOF
      ;;
  esac
  chmod 600 "$CONFIG_FILE"
  echo "✓ Created $CONFIG_FILE"
else
  echo "✓ Preserved existing $CONFIG_FILE"
fi

# --- Update shell rc ---
update_rc() {
  rc_file="$1"
  touch "$rc_file"
  tmp_file="$(mktemp)"
  awk -v start="$START_MARKER" -v end="$END_MARKER" '
    $0 == start { skip = 1; next }
    $0 == end { skip = 0; next }
    !skip { print }
  ' "$rc_file" > "$tmp_file"
  cat >> "$tmp_file" <<RCEOF

$START_MARKER
export OPENCODE_LOCAL_SETUP_DIR="$SETUP_DIR"
[ -f "$SETUP_DIR/opencode-wrapper.sh" ] && . "$SETUP_DIR/opencode-wrapper.sh"
$END_MARKER
RCEOF
  cat "$tmp_file" > "$rc_file"
  rm -f "$tmp_file"
  echo "✓ Updated $rc_file"
}

case "${SHELL:-}" in
  */zsh) update_rc "$HOME/.zshrc" ;;
  *) update_rc "$HOME/.bashrc" ;;
esac

# --- Download models ---
if [ "$SKIP_MODELS" = false ]; then
  echo ""
  echo "[8/8] Downloading models..."

  if command -v ollama >/dev/null 2>&1 && { [ "$PROVIDER" = "ollama" ] || [ "$INSTALL_OLLAMA" = true ]; }; then
    # Start Ollama if not running
    if ! curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
      echo "  Starting Ollama..."
      ollama serve &>/dev/null &
      sleep 2
    fi

    MODELS_TO_DOWNLOAD="${MODEL_LIST:-phi-3-mini,qwen2.5-coder-7b,llama-3.1-8b}"
    IFS=',' read -ra MODEL_ARRAY <<< "$MODELS_TO_DOWNLOAD"

    echo "  Downloading ${#MODEL_ARRAY[@]} models for Ollama..."
    node "$SETUP_DIR/download-models.mjs" ollama "${MODEL_ARRAY[@]}" || true
  elif command -v lms >/dev/null 2>&1 || curl -fsS http://127.0.0.1:1234/v1/models >/dev/null 2>&1; then
    MODELS_TO_DOWNLOAD="${MODEL_LIST:-phi-3-mini,qwen2.5-coder-7b,llama-3.1-8b}"
    IFS=',' read -ra MODEL_ARRAY <<< "$MODELS_TO_DOWNLOAD"

    echo "  Downloading ${#MODEL_ARRAY[@]} models for LM Studio..."
    node "$SETUP_DIR/download-models.mjs" lmstudio "${MODEL_ARRAY[@]}" || true
  elif [ -f "$SETUP_DIR/vllm-server.sh" ]; then
    MODELS_TO_DOWNLOAD="${MODEL_LIST:-phi-3-mini,qwen2.5-coder-7b,llama-3.1-8b}"
    IFS=',' read -ra MODEL_ARRAY <<< "$MODELS_TO_DOWNLOAD"

    echo "  Downloading ${#MODEL_ARRAY[@]} models for vLLM..."
    node "$SETUP_DIR/download-models.mjs" vllm "${MODEL_ARRAY[@]}" || true

    # Start vLLM server with the first model if not already running
    VLLM_HF_REPO=""
    case "${MODEL_ARRAY[0]:-}" in
      phi-3-mini) VLLM_HF_REPO="microsoft/Phi-3-mini-4k-instruct" ;;
      qwen2.5-coder-7b|qwen2.5-coder-32b) VLLM_HF_REPO="Qwen/Qwen2.5-Coder-7B-Instruct" ;;
      llama-3.1-8b) VLLM_HF_REPO="meta-llama/Meta-Llama-3.1-8B-Instruct" ;;
      mistral-nemo) VLLM_HF_REPO="mistralai/Mistral-Nemo-Instruct-2407" ;;
      *) VLLM_HF_REPO="${VLLM_MODEL:-meta-llama/Meta-Llama-3.1-8B-Instruct}" ;;
    esac

    if ! curl -fsS http://127.0.0.1:8000/v1/models >/dev/null 2>&1; then
      echo "  Starting vLLM server with $VLLM_HF_REPO..."
      bash "$SETUP_DIR/vllm-server.sh" start "$VLLM_HF_REPO" || {
        echo "! Failed to start vLLM server."
      }
    fi
  else
    echo "! No model server detected. Start one and run:"
    echo "  download-models <provider> [model-ids...]"
  fi
else
  echo ""
  echo "[8/8] Skipping model download (--skip-models)"
fi

# --- Run initial sync and doctor ---
if [ "$SKIP_SYNC" = false ]; then
  echo ""
  echo "Running initial sync..."
  (
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
    OPENCODE_CONFIG="$CONFIG_FILE" node "$SETUP_DIR/sync-on-launch.mjs" || true
  )

  if [ "$SKIP_DOCTOR" = false ]; then
    OPENCODE_CONFIG="$CONFIG_FILE" node "$SETUP_DIR/doctor.mjs" || true
  else
    echo ""
    echo "Skipping doctor check (--skip-doctor)"
  fi
else
  echo ""
  echo "Skipping sync and doctor (--skip-sync)"
fi

# --- Launch OpenCode if requested ---
if [ "$LAUNCH" = true ]; then
  echo ""
  echo "Launching OpenCode..."
  opencode &>/dev/null & || {
    echo "! Failed to launch OpenCode. Run 'opencode' manually." >&2
  }
fi

echo ""
echo "========================================"
echo "Setup complete!"
echo ""
if [ "$LAUNCH" = true ]; then
  echo "OpenCode is launching..."
else
  echo "Next steps:"
  echo "  1. Restart your shell or run: . \"$SETUP_DIR/opencode-wrapper.sh\""
  if [ "$PROVIDER" = "ollama" ]; then
    echo "  2. Start Ollama if needed: ollama serve"
  elif [ "$PROVIDER" = "vllm" ]; then
    echo "  2. Start vLLM server: bash \"$SETUP_DIR/vllm-server.sh\" start <hf-repo>"
  fi
  echo "  3. Launch OpenCode: opencode"
fi
echo ""
echo "Commands:"
echo "  oc-ollama        - Sync Ollama and launch (if available)"
echo "  oc-lmstudio      - Sync LM Studio and launch"
echo "  oc-vllm          - Start vLLM server, sync models, and launch"
echo "  sync-models      - Refresh model list from servers"
echo "  download-models <provider> [models...] - Download models"
echo "  oc-doctor        - Check configuration health"
echo ""
echo "Configuration files:"
echo "  Config:  $CONFIG_FILE"
echo "  Env:     $ENV_FILE"
