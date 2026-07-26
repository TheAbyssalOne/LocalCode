# Repository guidance

## Purpose

Get OpenCode running against models on local hardware. Detect the machine, pick a model
variant that fits it, install and serve it, write the OpenCode config, keep it in sync.
Windows, macOS and Linux.

## Architecture

### Entry points

- `scripts/setup.mjs` — the only place setup logic lives. Builds a plan from detection plus
  flags, then either confirms it interactively or executes it with `--yes`.
- `scripts/install.sh` / `scripts/install.ps1` — thin shims that verify Node and exec
  `setup.mjs`. Keep them thin; logic added here will drift from the other platform.

### Core modules

- `detect.mjs` — OS, RAM, GPU/VRAM, WSL2, Docker, Python, already-running servers.
- `vram-profile.mjs` — pure memory arithmetic: weights, KV cache, usable context.
- `manage.mjs` — install lifecycle: inspect, uninstall, reset-config.
- `sync-core.mjs` — config read/write, JSONC parsing, model sync logic.
- `sync-provider.mjs` — single-provider sync. `sync-on-launch.mjs` — pre-launch multi-provider sync.
- `providers.mjs` — provider metadata and URL detection.
- `download-models.mjs` — dispatcher over `ollama pull` / `hf download` / `lms get`.
- `doctor.mjs` — configuration health check.
- `vllm-server.sh` / `vllm-server.ps1` — vLLM lifecycle.
- `opencode-wrapper.sh` / `opencode-wrapper.ps1` — shell helper functions.
- `check-syntax.mjs` — parses every `.mjs`, `.sh` and `.ps1`.

## Design constraints

- Track the live schema at `https://opencode.ai/config.json`.
- Never persist raw API keys, bearer tokens, or private credentials.
- Use `tool_call`, not legacy model-level `tools`.
- Emit `limit` only with both `context` and `output`.
- Preserve unrelated config fields and unknown model/provider metadata.
- Keep launch sync bounded, quiet, and failure-tolerant.
- Keep network discovery opt-in and narrowly scoped.
- Do not shadow server binaries such as `ollama` or `vllm`.

### Rules this repository learned the hard way

- **Anything that must parse is a tracked file, never a generated string.** The previous
  installer built its PowerShell wrapper by escaping inside a here-string and shipped
  invalid PowerShell. Wrappers and server scripts are real files that CI parses.
- **One code path per decision.** Three parallel installers drifted until each supported a
  different flag set. Automated and guided modes now share `buildPlan`.
- **Importing a module must have no side effects.** Guard entry points with
  `import.meta.url === pathToFileURL(process.argv[1]).href`.
- **Failures must propagate.** A helper returning `{success:false}` inside a `try` block
  reported every failed download as a success.
- **Size by arithmetic, not tiers.** A VRAM tier table put Qwen3.6 at 32K on a 32 GB card;
  the real figure is ~100K, because only 16 of its 64 layers cache KV. Compute from
  `params_b`, bits-per-weight and `arch.kv_layers`, and keep the override.
- **Rank fidelity only after usable context.** On 32 GB, fp8 leaves 27K and awq4 leaves
  216K; the more precise weights are the worse choice. Reach the context target first.
- **Compute it, then pass it.** `maxModelLen`, `vllm_args` and `extra_args` were once
  computed and only displayed, so models ran mis-configured. If a value is derived, some
  command must consume it.
- **Configure and serve, then sync.** Writing a config against a port nothing is listening
  on yields an empty model list and an install that looks successful.
- **Removal is scoped.** Take back only the marker block and `MANAGED_PROVIDERS`; never a
  provider, agent or MCP server the user wrote.
- **Catalog identifiers are verified, not remembered.** `tests/catalog.test.mjs` resolves
  every repo and tag against the live registries. Run it before editing `models.json`.

## Platform notes

| Platform | Default server | Note |
|---|---|---|
| Linux + NVIDIA/ROCm | vLLM (venv) | upstream |
| Windows + NVIDIA | vLLM in WSL2, Docker fallback | no native Windows vLLM build |
| macOS (Apple Silicon) | Ollama | Metal; no practical vLLM path |
| No GPU | Ollama | GGUF |

## Validation

```bash
pnpm run validate
```

Parses every script, then runs the tests. CI covers Linux, macOS and Windows on Node
20/22/24. When changing configuration output, add or update a test under `tests/` that
reads the resulting file and verifies secret hygiene and schema-compatible fields.
