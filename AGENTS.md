# Repository guidance

## Purpose

Full automated setup for OpenCode with local AI models. Handles environment detection, prerequisite installation, model server setup, model downloading, and configuration generation across Windows, macOS, and Linux.

## Architecture

### Entry points
- **Windows**: `scripts/install.ps1` - Full PowerShell installer (LM Studio primary, vLLM secondary)
- **Unix**: `scripts/install.sh` - Bash installer with Ollama auto-install, distro detection
- **Cross-platform**: `node scripts/full-setup.mjs` - Unified Node.js entry point for entire chain

### Core modules
- `setup-env.mjs` - OS detection, prerequisite checks (Node.js, OpenCode, model servers), RAM-based model recommendations
- `download-models.mjs` - Automatic model download for Ollama/LM Studio/vLLM
- `models.json` - Pre-configured model catalog with metadata per provider
- `sync-core.mjs` - Config read/write, JSONC parsing, model sync logic (unchanged)
- `sync-provider.mjs` - Single-provider model sync (unchanged)
- `sync-on-launch.mjs` - Pre-launch multi-provider sync (unchanged)
- `providers.mjs` - Provider metadata and URL detection (unchanged)
- `doctor.mjs` - Configuration health check (unchanged)

### Design constraints

- Track the live schema at `https://opencode.ai/config.json`.
- Never persist raw API keys, bearer tokens, or private credentials.
- Use `tool_call`, not legacy model-level `tools`.
- Emit `limit` only with both `context` and `output`.
- Preserve unrelated config fields and unknown model/provider metadata.
- Keep launch sync bounded, quiet, and failure-tolerant.
- Keep network discovery opt-in and narrowly scoped.
- Support Windows (PowerShell 7+), macOS, and Linux (Bash/Zsh).
- Auto-detect system RAM to recommend appropriate models.
- Do not shadow server binaries such as `ollama` or `vllm`.

### Platform defaults

| Platform | Primary provider | Secondary | Installer |
|---|---|---|---|
| Windows | LM Studio | vLLM (opt-in) | `install.ps1` |
| macOS/Linux | Ollama | LM Studio | `install.sh` |

### Model catalog

Models in `models.json` include per-provider identifiers:
- **Ollama**: tag name for `ollama pull`
- **LM Studio**: HuggingFace repo + GGUF file pattern
- **vLLM**: HuggingFace repo for model weights

Recommended models are selected by available RAM (4GB/8GB/16GB/32GB tiers).

## Validation

Run before committing:

```bash
pnpm run validate
```

When changing configuration output, add or update an integration test under `tests/` that reads the resulting file and verifies secret hygiene and schema-compatible fields.
