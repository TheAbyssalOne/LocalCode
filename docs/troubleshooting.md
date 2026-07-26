# Troubleshooting

Start with the automated checks:

```bash
oc-doctor
OPENCODE_SYNC_VERBOSE=1 sync-models
```

## OpenCode is not found

```bash
curl -fsSL https://opencode.ai/install | bash
exec "$SHELL" -l
opencode --version
```

The setup installer does not silently install or downgrade OpenCode.

## Shell helpers are not available

Re-run the installer, then reload the active shell:

```bash
./scripts/install.sh
exec "$SHELL" -l
```

The installer updates `~/.zshrc` for Zsh and `~/.bashrc` otherwise. It replaces only the block between the `opencode-local-setup` markers.

## Connection refused or timeout

Confirm the server and model are loaded:

```bash
curl -fsS http://127.0.0.1:1234/v1/models | jq
```

Common endpoints:

| Server | URL |
|---|---|
| LM Studio | `http://127.0.0.1:1234/v1` |
| Ollama | `http://127.0.0.1:11434/v1` |
| vLLM | `http://127.0.0.1:8000/v1` |
| llama.cpp | `http://127.0.0.1:8080/v1` |

Increase the timeout only for genuinely slow links:

```bash
OPENCODE_SYNC_TIMEOUT_MS=10000 sync-models
```

## vLLM runs out of memory on startup

The context window is almost always the cause: the KV cache scales with `--max-model-len`,
and a model advertising 262k context cannot serve it on a consumer card. Setup derives a
limit from detected VRAM, but the tier table is a heuristic — real capacity varies with the
attention backend and `--gpu-memory-utilization`.

Lower it explicitly:

```bash
node scripts/setup.mjs --provider vllm --model qwen3.6-27b --max-model-len 16384
```

Or drop to a smaller variant:

```bash
node scripts/setup.mjs --provider vllm --model qwen3.6-27b --quant awq4
```

`vllm.log` in `$OPENCODE_LOCAL_SETUP_DIR` holds the startup output.

## vLLM on Windows is unreachable

vLLM has no native Windows build, so it runs inside WSL2. It must bind `0.0.0.0` there —
binding `127.0.0.1` inside the distro is not reachable from Windows.

```powershell
.\scripts\vllm-server.ps1 status
```

That reports the endpoint it resolved. If WSL2 localhost forwarding is disabled, the
distro address is used instead; check it with `wsl hostname -I` and confirm the `baseURL`
in your config matches.

## A model download fails with 401 or 403

The repository is gated. Accept its licence on HuggingFace, then export a token:

```bash
export HF_TOKEN='hf_...'
```

`llama3.1-8b` is the gated entry in the catalog. Its Ollama tag is not gated, so
`--provider ollama` avoids the issue entirely.

## The chosen model does not fit

Setup refuses rather than picking something that will not load:

```text
No Qwen3.6 27B variant fits 8 GB VRAM. Try a smaller model: ...
```

Run `node scripts/setup.mjs --dry-run` to see what your hardware resolves to before
committing to a download.

## Models sync but do not appear

Check the exact config path and provider IDs:

```bash
echo "${OPENCODE_CONFIG:-$HOME/.config/opencode/opencode.json}"
opencode models
opencode models --refresh
```

A project-level `opencode.json` can override global settings. A custom path set with `OPENCODE_CONFIG` is loaded in OpenCode's documented precedence order.

## The config contains comments

JSONC is supported. The synchronizer accepts line comments, block comments, and trailing commas. After writing, it normalizes the file to strict JSON. Invalid syntax still fails without changing the original file.

## `tools` fails schema validation

Current model metadata uses `tool_call`:

```json
{
  "my-model": {
    "name": "My Model",
    "tool_call": true
  }
}
```

Run `sync-models` to migrate discovered models automatically. Agent-level tool policy is separate and belongs under current OpenCode `agent.permission` configuration.

## `limit` fails schema validation

A model limit must include both context and output:

```json
{
  "limit": {
    "context": 131072,
    "output": 8192
  }
}
```

The synchronizer omits incomplete limits rather than writing invalid config.

## Authentication fails

For built-in providers:

```bash
opencode auth login
opencode auth list
```

For a custom server, verify the env variable is available in the same shell:

```bash
export REMOTE_API_KEY='...'
REMOTE_API_KEY="$REMOTE_API_KEY" \
LOCAL_API_BASE=http://100.100.100.100:8000/v1 \
OPENCODE_PROVIDER_ID=gpu-box \
node scripts/sync-provider.mjs
```

Never place a raw API key in a committed config. `oc-doctor` reports literal keys and Authorization headers.

## Tailscale peers are not discovered

Discovery is opt-in:

```bash
export OPENCODE_TAILSCALE_DISCOVERY=1
export OPENCODE_TAILSCALE_PORTS=1234,8000,8080,11434
tailscale status
OPENCODE_SYNC_VERBOSE=1 sync-models
```

Only online peers are considered. Explicitly configured remote providers are more predictable and do not require discovery.

## Launch feels slow

The wrapper only refreshes before launch by default. Reduce the custom endpoint timeout or disable an offline provider:

```bash
export OPENCODE_SYNC_TIMEOUT_MS=1000
```

Remove `OPENCODE_SYNC_AFTER_EXIT=1` and `OPENCODE_TAILSCALE_DISCOVERY=1` unless needed. The default discovery state is off.

## Preserve a model missing from `/models`

By default, stale entries are pruned. To merge without pruning:

```bash
OPENCODE_SYNC_PRUNE=0 sync-models
```

## Safe recovery

The writer uses a temporary file and atomic rename, so a failed write should leave the original intact. Before major manual edits:

```bash
cp ~/.config/opencode/opencode.json ~/.config/opencode/opencode.json.backup
```

Then validate:

```bash
oc-doctor
opencode models
```
