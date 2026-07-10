<div align="center">
  <img src="docs/assets/hero.svg" alt="OpenCode Local Setup — your models, one clean setup" width="100%" />

  <br />

  [![CI](https://github.com/groxaxo/opencode-local-setup/actions/workflows/ci.yml/badge.svg)](https://github.com/groxaxo/opencode-local-setup/actions/workflows/ci.yml)
  [![OpenCode schema](https://img.shields.io/badge/OpenCode-current%20schema-65e8c4)](https://opencode.ai/config.json)
  [![Node 18+](https://img.shields.io/badge/Node-18%2B-69a7ff)](https://nodejs.org/)
  [![License: MIT](https://img.shields.io/badge/License-MIT-b281ff.svg)](LICENSE)

  **A secure, low-friction bridge between OpenCode and your local, LAN, or OpenAI-compatible model servers.**

  [Quick start](#quick-start) · [How it works](#how-it-works) · [Configuration](#configuration) · [Troubleshooting](docs/troubleshooting.md)
</div>

## Why this exists

OpenCode already has excellent built-in providers. Local inference is different: models are loaded, unloaded, renamed, and moved between machines. This project keeps the custom provider section of `opencode.json` synchronized with the live `/models` endpoints you actually run—without replacing OpenCode's native authentication flow or writing API keys into your config.

| What you get | What it means |
|---|---|
| **Live model discovery** | LM Studio, Ollama, vLLM, llama.cpp, and compatible servers appear with their current model IDs. |
| **Current OpenCode config** | Generates `provider`, `options.baseURL`, `tool_call`, and valid `limit` metadata using the active schema. |
| **Safe credentials** | Uses `{env:VARIABLE}` references and never copies discovery tokens into generated config. |
| **Fast launches** | Refreshes configured endpoints before launch with short timeouts; post-exit sync and network discovery are opt-in. |
| **macOS + Linux** | Installs cleanly for Bash or Zsh without GNU-only `sed`/`grep` assumptions. |
| **Non-destructive updates** | Preserves unrelated OpenCode settings and writes config atomically with owner-only permissions. |

## Quick start

### 1. Install OpenCode

```bash
curl -fsSL https://opencode.ai/install | bash
```

### 2. Install this setup

```bash
git clone https://github.com/groxaxo/opencode-local-setup.git
cd opencode-local-setup
./scripts/install.sh
```

Restart your shell, then start your local server and run:

```bash
opencode
```

The wrapper quietly refreshes the model catalog before opening OpenCode. Inside the TUI, use `/models` to choose a model and `/connect` for OpenCode-managed cloud credentials.

> [!TIP]
> The default endpoint is LM Studio at `http://127.0.0.1:1234/v1`. Change it in `~/.config/opencode/local-setup/.env.local`.

## Local server shortcuts

These helpers synchronize the endpoint and then launch the selected provider:

```bash
oc-lmstudio                     # http://127.0.0.1:1234/v1
oc-ollama                       # http://127.0.0.1:11434/v1
oc-vllm                         # http://127.0.0.1:8000/v1
oc-llamacpp                     # http://127.0.0.1:8080/v1

oc-lmstudio "Review this repo" # non-interactive: opencode run --model ...
```

They are intentionally prefixed with `oc-`, so they never shadow the real `ollama`, `vllm`, or other server executables.

## How it works

```mermaid
flowchart LR
  A[Local / LAN model server] -->|GET /v1/models| B[Secure synchronizer]
  B -->|preserve + migrate| C[opencode.json / JSONC]
  C --> D[OpenCode]
  E[Environment variables] -->|{env:NAME}| C
  F[Tailscale discovery] -. opt-in .-> B
```

1. Reads the active OpenCode config from `OPENCODE_CONFIG` or `~/.config/opencode/opencode.json`.
2. Accepts both JSON and JSONC, including trailing commas.
3. Queries each explicitly configured OpenAI-compatible `/models` endpoint.
4. Refreshes display names, `tool_call`, reasoning capability, and token limits when the server reports them.
5. Migrates legacy `tools` model metadata and removes stale models by default.
6. Writes the result atomically with `0600` permissions.

## Configuration

### Main environment file

```bash
$EDITOR ~/.config/opencode/local-setup/.env.local
```

```bash
LOCAL_API_BASE=http://127.0.0.1:1234/v1

# Optional authentication for local or remote compatible servers
# LOCAL_API_KEY=...
# REMOTE_API_KEY=...
```

### Synchronize one endpoint

```bash
LOCAL_API_BASE=http://127.0.0.1:8000/v1 \
OPENCODE_PROVIDER_ID=vllm \
OPENCODE_PROVIDER_NAME="vLLM (local)" \
node scripts/sync-provider.mjs
```

### Synchronize configured endpoints

```bash
sync-models
```

Or refresh local defaults and OpenCode's built-in model cache:

```bash
./scripts/sync-all-providers.sh
opencode models --refresh
```

### Remote GPU server

Add an explicit provider to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "gpu-box": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "GPU Box",
      "options": {
        "baseURL": "http://100.100.100.100:8000/v1",
        "apiKey": "{env:REMOTE_API_KEY}"
      },
      "models": {}
    }
  }
}
```

For trusted tailnets, automatic discovery is available but disabled by default:

```bash
OPENCODE_TAILSCALE_DISCOVERY=1
OPENCODE_TAILSCALE_PORTS=1234,8000,8080,11434
```

Only online peers and the listed ports are probed. Explicit remote providers work without discovery.

## Security defaults

- API keys remain in environment variables or OpenCode's own credential store.
- The synchronizer converts known credentials to `{env:VARIABLE}` references.
- Literal `Authorization` headers are removed when a safe env reference is available.
- Config updates are atomic and permissions are restricted to the current user.
- Tailscale scanning and post-exit sync are off unless explicitly enabled.
- Automatic session sharing is not enabled by the installer (`share: "manual"`).

Run the built-in audit at any time:

```bash
oc-doctor
```

## Useful commands

```bash
opencode                         # Open the TUI with pre-launch sync
opencode run "Explain this"      # Non-interactive run
opencode models                  # List available provider/model IDs
opencode models --refresh        # Refresh OpenCode's built-in model cache
opencode auth login              # Authenticate a provider
opencode upgrade                 # Upgrade OpenCode
sync-models                      # Refresh custom compatible endpoints
oc-doctor                        # Validate version, config and secret hygiene
```

## Project map

```text
scripts/
  install.sh              Cross-platform installer
  sync-provider.mjs       One endpoint → one OpenCode provider
  sync-on-launch.mjs      Refresh configured endpoints safely
  sync-all-providers.sh   Refresh common local servers
  sync-core.mjs           JSONC, model metadata and atomic writes
  doctor.mjs              Compatibility and secret audit
  opencode-wrapper.sh     Bash/Zsh convenience layer
configs/                   Current configuration examples
docs/                      API reference, auth and troubleshooting
tests/                     Node integration tests
```

## Upgrade from an older checkout

```bash
git pull
./scripts/install.sh
oc-doctor
```

The installer preserves your existing `opencode.json` and `.env.local`. The next successful sync migrates model-level `tools` fields to `tool_call`; review any hand-written legacy agent config separately because current OpenCode uses `agent`, not `agents`.

## Development

```bash
npm run validate
```

The test suite exercises JSONC, capability migration, secure credentials, atomic permissions, multi-provider refresh, and opt-in Tailscale discovery.

## Documentation

- [Configuration and script reference](docs/api-reference.md)
- [Authentication and credentials](docs/auth-providers.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Example configs](configs/)

## License

[MIT](LICENSE)
