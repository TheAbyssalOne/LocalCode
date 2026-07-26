# Configuration and script reference

This project manages only custom OpenAI-compatible providers. OpenCode's built-in providers, authentication, agents, permissions, MCP servers, and TUI settings remain owned by OpenCode.

## Paths

| Purpose | Default | Override |
|---|---|---|
| OpenCode config | `~/.config/opencode/opencode.json` | `OPENCODE_CONFIG` |
| OpenCode config root | `~/.config/opencode` | `XDG_CONFIG_HOME` |
| Installed helper files | `~/.config/opencode/local-setup` | `OPENCODE_LOCAL_SETUP_DIR` |
| Setup environment file | `<setup-dir>/.env.local` | `OPENCODE_LOCAL_ENV` |

Both `.json` and JSONC content are accepted by the synchronizer. Output is normalized to strict JSON so OpenCode, editors, and automation can all consume it reliably.

## Current provider shape

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "my-local-server": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "My local server",
      "options": {
        "baseURL": "http://127.0.0.1:8000/v1",
        "apiKey": "{env:LOCAL_API_KEY}"
      },
      "models": {
        "model-id": {
          "name": "Model display name",
          "tool_call": true,
          "reasoning": true,
          "limit": {
            "context": 131072,
            "output": 8192
          }
        }
      }
    }
  }
}
```

`@ai-sdk/openai-compatible` is appropriate for compatible `/v1/chat/completions` servers. A server or model using the OpenAI Responses API can override `npm` with `@ai-sdk/openai`; the sync script also accepts `OPENCODE_PROVIDER_NPM` and `OPENCODE_PROVIDER_API`.

The synchronizer emits `limit` only when both `context` and `output` are known, because the current schema requires both fields.

## Environment variables

### Endpoint and provider

| Variable | Default | Meaning |
|---|---|---|
| `LOCAL_API_BASE` | `http://127.0.0.1:1234/v1` | Compatible API base URL |
| `OPENCODE_PROVIDER_ID` | auto-detected | Provider key written under `provider` |
| `OPENCODE_PROVIDER_NAME` | auto-detected | Display name |
| `OPENCODE_PROVIDER_NPM` | provider default | AI SDK package override |
| `OPENCODE_PROVIDER_API` | unset | Provider API mode override |
| `OPENCODE_MODELS_PATH` | `/models` | Model-list path appended to the base URL |

### Credentials

| Variable | Used for |
|---|---|
| `LOCAL_API_KEY` | Authenticated local servers |
| `REMOTE_API_KEY` | LAN, VPN, and Tailscale servers |
| `API_KEY` | Generic compatible endpoint fallback |
| Provider-specific vars | `OPENAI_API_KEY`, `FIREWORKS_API_KEY`, `DEEPSEEK_API_KEY`, etc. |

Credentials are used for the discovery request but persisted only as `{env:VARIABLE}` references. Prefer OpenCode's `/connect` flow for built-in cloud providers.

### Sync behavior

| Variable | Default | Meaning |
|---|---|---|
| `OPENCODE_SYNC_TIMEOUT_MS` | `10000` single / `2500` launch | Discovery HTTP timeout |
| `OPENCODE_SYNC_PRUNE` | `1` | Remove models no longer returned; set `0` to retain them |
| `OPENCODE_SYNC_DRY_RUN` | `0` | Discover and report without writing |
| `OPENCODE_SYNC_VERBOSE` | `0` | Show launch-sync errors and summary |
| `OPENCODE_SYNC_AFTER_EXIT` | `0` | Also refresh when the TUI exits |

### Setup behavior

| Variable | Default | Meaning |
|---|---|---|
| `LOCALCODE_SKIP_PREREQS` | `0` | Configure only; never install OpenCode, Ollama or vLLM. Used by the test suite so a test run cannot mutate the host. |
| `LOCALCODE_NETWORK_TESTS` | `0` | Enable the catalog tests that hit HuggingFace and the Ollama registry |
| `VLLM_MODEL` | unset | Model `oc-vllm` starts when no server is running |
| `VLLM_PORT` | `8000` | Port for `vllm-server.sh` / `.ps1` |
| `HF_TOKEN` | unset | Required for gated HuggingFace repositories |

### Tailscale discovery

| Variable | Default | Meaning |
|---|---|---|
| `OPENCODE_TAILSCALE_DISCOVERY` | `0` | Set `1` to enable |
| `OPENCODE_TAILSCALE_PORTS` | `1234,8000,8080,11434` | Comma-separated ports or ranges |
| `OPENCODE_TAILSCALE_TIMEOUT_MS` | `150` | TCP probe timeout |
| `OPENCODE_TAILSCALE_HTTP_TIMEOUT_MS` | `1000` | `/models` request timeout |
| `OPENCODE_TAILSCALE_CONCURRENCY` | `16` | Maximum parallel TCP probes |

## Scripts

### `sync-provider.mjs`

Synchronizes one endpoint.

```bash
LOCAL_API_BASE=http://127.0.0.1:8080/v1 \
OPENCODE_PROVIDER_ID=llamacpp \
OPENCODE_PROVIDER_NAME="llama.cpp (local)" \
node scripts/sync-provider.mjs
```

The script validates the URL, fetches model metadata with a timeout, preserves unknown provider/model fields, migrates legacy `tools`, and atomically updates the config.

### `sync-on-launch.mjs`

Reads every custom provider containing `options.baseURL` and refreshes reachable compatible endpoints. Failures are isolated per provider so an offline server does not prevent OpenCode from starting.

```bash
OPENCODE_SYNC_VERBOSE=1 node scripts/sync-on-launch.mjs
```

To sync several fixed endpoints regardless of what is in the config, list them as providers
in `opencode.json` — see [`configs/opencode-multi-provider.json`](../configs/opencode-multi-provider.json).
`sync-on-launch.mjs` then refreshes whichever are reachable.

### `setup.mjs`

Detects the machine, profiles memory, resolves a model variant that fits, installs and
configures the server, starts it, waits for health, then syncs.

```bash
node scripts/setup.mjs --dry-run
node scripts/setup.mjs --provider vllm --model qwen3.6-27b --yes
node scripts/setup.mjs --status
node scripts/setup.mjs --uninstall
```

### `vram-profile.mjs`

Pure memory arithmetic, importable and testable without a GPU.

```js
import { profile, bestVariantFor } from "./vram-profile.mjs";

profile({ vramGb: 32, paramsB: 27, quant: "q6_k",
          arch: { kv_layers: 16, kv_heads: 4, head_dim: 256 }, maxContext: 262144 });
// { fits: true, weightsGib: 20.62, kvGib: 6.26, maxModelLen: 102400, ... }
```

`kv_layers` counts only layers that cache KV. For hybrid models it is far below the layer
count, and it dominates the context calculation.

```bash
node scripts/setup.mjs --profile --vram 24 --kv-dtype fp8
```

### `manage.mjs`

Install lifecycle: `inspect()`, `uninstall({ keepConfig })`, `resetConfig()`. Removal is
scoped to the providers in `MANAGED_PROVIDERS` and the marker block in the shell profile;
everything else is left byte-for-byte intact.

### `detect.mjs`

Hardware and environment detection, importable on its own:

```bash
node -e "import('./scripts/detect.mjs').then(async m => console.log(await m.detect()))"
```

### `download-models.mjs`

Dispatches to the server's own downloader — `ollama pull`, `hf download`, `lms get`.
Exits non-zero if any model fails.

```bash
node scripts/download-models.mjs ollama qwen2.5-coder-7b
```

### `vllm-server.sh` / `vllm-server.ps1`

vLLM lifecycle: `start <hf-repo> [args...]`, `stop`, `restart`, `status`. The PowerShell
version dispatches into WSL2 or Docker, since vLLM has no native Windows build. Logs go to
`$OPENCODE_LOCAL_SETUP_DIR/vllm.log`.

### `doctor.mjs`

Checks:

- OpenCode availability and version
- active config path and schema
- legacy model `tools` fields
- incomplete `limit` objects
- literal API keys and Authorization headers
- provider base URLs

```bash
node scripts/doctor.mjs
```

## Shell helpers

| Helper | Action |
|---|---|
| `sync-models [url]` | Refresh all configured endpoints or one URL |
| `oc-provider <provider> [model] [prompt]` | Launch TUI or non-interactive run |
| `oc-lmstudio` | Sync and use LM Studio |
| `oc-ollama` | Sync and use Ollama |
| `oc-vllm` | Sync and use vLLM |
| `oc-llamacpp` | Sync and use llama.cpp |
| `oc-doctor` | Run the compatibility audit |
| `oc-upgrade` | Run `opencode upgrade` |
| `download-models <provider> [ids...]` | Download models through the server's own tool |
| `localcode-setup [options]` | Re-run `setup.mjs` |

The same helpers exist for PowerShell in `opencode-wrapper.ps1`.

## OpenCode-native commands

```bash
opencode                       # TUI
opencode run "prompt"          # non-interactive
opencode models [provider]     # list provider/model IDs
opencode models --refresh      # refresh built-in provider cache
opencode auth login            # authenticate a provider
opencode auth list             # inspect authentication state
opencode upgrade               # install the current release
```
