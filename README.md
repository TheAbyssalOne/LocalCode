<div align="center">
  <img src="docs/assets/hero.svg" alt="Run your own AI models in OpenCode" width="100%" />

  <br />

  [![CI](https://github.com/TheAbyssalOne/LocalCode/actions/workflows/ci.yml/badge.svg)](https://github.com/TheAbyssalOne/LocalCode/actions/workflows/ci.yml)
  [![OpenCode compatible](https://img.shields.io/badge/OpenCode-current%20schema-65e8c4)](https://opencode.ai/config.json)
  [![Node 20+](https://img.shields.io/badge/Node-20%2B-69a7ff)](https://nodejs.org/)
  [![License: MIT](https://img.shields.io/badge/License-MIT-b281ff.svg)](LICENSE)

  ### Run OpenCode against models on your own hardware.

  It looks at your machine, picks a model variant that actually fits, installs and
  starts the server, writes the OpenCode config, and keeps it in sync.

  [Get started](#get-started) · [Models](#models) · [How it chooses](#how-it-chooses) · [Troubleshooting](docs/troubleshooting.md)
</div>

---

## Get started

```bash
git clone https://github.com/TheAbyssalOne/LocalCode.git
cd LocalCode
```

```bash
./scripts/install.sh          # macOS / Linux
```

```powershell
.\scripts\install.ps1         # Windows (PowerShell 7+)
```

It detects your hardware, shows you the plan, and asks before changing anything:

```text
  Detected
    OS            linux x64
    RAM           64 GB
    GPU           NVIDIA GeForce RTX 4090 (24 GB VRAM)
    OpenCode      installed

  Plan
    Server        vllm - NVIDIA GPU with 24 GB VRAM
    Model         Qwen3.6 27B @ awq4
    Source        QuantTrio/Qwen3.6-27B-AWQ
    Endpoint      http://127.0.0.1:8000/v1
    Context       32768 (capped from 262144 to fit VRAM)
    Config        /home/you/.config/opencode/opencode.json

Proceed? [Y/n]
```

Add `--yes` to skip the prompt, or `--dry-run` to see the plan and stop.

## The memory profiler

Model choice is computed, not guessed. See what your card can actually hold:

```bash
node scripts/setup.mjs --profile
```

```text
  Memory profile - 32 GB, fp16 KV cache

  Model                 Quant     Weights       KV   Context
  ----------------------------------------------------------
  Qwen3.6 27B           bf16       50.29G        -   too big  vllm
                        fp8        25.15G    1.73G       27K  vllm
                        awq4       13.36G   13.52G      216K  vllm
                        q6_k       20.62G    6.26G      100K  ollama
```

That table is real arithmetic: weights from parameter count × bits-per-weight, KV cache
from the model's own architecture. It exposes decisions a size heuristic hides — on a
32 GB card fp8 leaves only 27K of context while 4-bit leaves 216K, so **the
higher-precision weights are the worse choice for coding.** Selection ranks fidelity only
after a usable context is reached.

It is architecture-aware. Qwen3.6 runs linear attention on 48 of its 64 layers and caches
KV on only 16, so it holds roughly four times the context a conventional 27B would at the
same VRAM. Profile any card without owning it:

```bash
node scripts/setup.mjs --profile --vram 24 --kv-dtype fp8
```

`--kv-dtype fp8` halves the cache and roughly doubles the context.

## How it chooses

| Hardware | Server | Note |
|---|---|---|
| NVIDIA / ROCm on Linux | vLLM in a virtualenv | upstream vLLM |
| NVIDIA on Windows | vLLM inside WSL2 | vLLM has no native Windows build |
| Apple Silicon | Ollama | Metal; there is no practical vLLM path |
| No GPU | Ollama | GGUF, CPU or partial offload |

Fallbacks are always announced, never silent.

Docker Model Runner also serves vLLM on Windows, but only for images published to Docker
Hub with a `-vllm` suffix, on port 12434. It cannot serve an arbitrary HuggingFace
repository, so it is not offered as a backend — WSL2 runs real upstream vLLM and takes any
repo.

## Models

```bash
node scripts/setup.mjs --model qwen3.6-27b
```

| Id | Model | Ollama | vLLM |
|---|---|---|---|
| `qwen3.6-27b` | Qwen3.6 27B | `qwen3.6:27b`, `:27b-q8_0` | bf16 / fp8 / awq4 |
| `qwen3-coder-30b` | Qwen3 Coder 30B-A3B | `qwen3-coder:30b` | bf16 |
| `qwen2.5-coder-7b` | Qwen2.5 Coder 7B *(default)* | `qwen2.5-coder:7b` | bf16 / awq4 |
| `llama3.1-8b` | Llama 3.1 8B | `llama3.1:8b` | bf16 (gated) |
| `phi3-mini` | Phi-3 Mini 3.8B | `phi3:mini` | bf16 |

Every identifier in [`models.json`](models.json) is checked against the live HuggingFace
and Ollama registries by `tests/catalog.test.mjs`, which also verifies each model's
declared architecture against its published `config.json` — the numbers the profiler
depends on. CI re-checks weekly, so an upstream rename or repack cannot rot the catalog
silently.

Gated repositories (Llama) need an accepted licence and `HF_TOKEN` exported before vLLM
can fetch them. The Ollama tag is not gated.

## Options

```text
--provider <name>     vllm, ollama, lmstudio, llamacpp (auto-detected by default)
--model <id>          Model id from models.json
--quant <name>        Force a variant: bf16, fp8, awq4, q6_k, q4_k_m
--max-model-len <n>   Override the profiled context limit
--vram <gb>           Profile against a card of this size instead of the detected one
--kv-dtype <name>     KV cache precision: fp16 (default) or fp8, which doubles context
--tensor-parallel <n> Split across n GPUs
--profile             Show what every catalogued model needs, then exit
-y, --yes             Take the detected defaults, ask nothing
--dry-run             Print the plan and exit without changing anything
--skip-models         Do not download the model
--skip-serve          Configure only; do not start the model server
--skip-sync           Do not refresh the model list afterwards
--skip-doctor         Do not run the health check
--launch              Launch OpenCode when setup finishes
```

## Managing an install

```bash
node scripts/setup.mjs --status          # what is installed, and what removal would touch
node scripts/setup.mjs --reinstall       # remove, then install again
node scripts/setup.mjs --uninstall       # remove files, unwire shell, drop managed providers
node scripts/setup.mjs --uninstall --keep-config
node scripts/setup.mjs --reset-config    # restore defaults, keep providers you added
```

Removal is surgical. It takes back only what it added: its own marker block in your shell
profile, and the provider entries it created. Providers you wrote yourself, plus agents,
MCP servers, permissions, themes and keybindings, are never touched — `--status` shows the
split before you commit.

Downloaded weights are **not** removed; they live in the model server's own store
(`~/.ollama`, `~/.cache/huggingface`). Delete those with the server's own tools.

## Commands you get

After restarting your shell:

```bash
opencode              # launches OpenCode, refreshing the model list first
sync-models           # refresh the model list from your servers
oc-vllm               # sync vLLM and launch
oc-ollama             # sync Ollama and launch
oc-doctor             # config health and secret hygiene check
download-models <provider> [model-id...]
localcode-setup       # re-run setup
```

vLLM lifecycle:

```bash
bash "$OPENCODE_LOCAL_SETUP_DIR/vllm-server.sh" start Qwen/Qwen3.6-27B-FP8
bash "$OPENCODE_LOCAL_SETUP_DIR/vllm-server.sh" status
bash "$OPENCODE_LOCAL_SETUP_DIR/vllm-server.sh" stop
```

On Windows use `vllm-server.ps1` with the same verbs; it dispatches into WSL2 or Docker.

## Keeping the model list fresh

Load or unload a model and OpenCode sees the change on the next sync. The synchronizer
updates provider models without touching your agents, MCP servers, permissions, themes or
keybindings, and it accepts JSONC.

Secrets stay out of the config. Generated entries reference the environment:

```json
"apiKey": "{env:REMOTE_API_KEY}"
```

- Raw API keys are never written into generated configuration.
- Config updates are atomic and restricted to your user (`0600` on POSIX, ACL on Windows).
- Tailscale discovery is opt-in and narrowly scoped.
- Automatic session sharing is not enabled.

## Remote and LAN machines

Any reachable OpenAI-compatible endpoint can be synced — another desktop, a home server, a
Tailscale peer. Add it to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "gpu-box": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "My GPU Box",
      "options": {
        "baseURL": "http://100.100.100.100:8000/v1",
        "apiKey": "{env:REMOTE_API_KEY}"
      },
      "models": {}
    }
  }
}
```

<details>
<summary><strong>Opt-in Tailscale discovery</strong></summary>

```bash
export OPENCODE_TAILSCALE_DISCOVERY=1
export OPENCODE_TAILSCALE_PORTS=1234,8000,8080,11434
sync-models
```

Only online peers and the ports you list are checked.

</details>

## For contributors

```bash
pnpm run validate
```

Parses every `.mjs`, `.sh` and `.ps1` in the repo, then runs the test suite. CI runs it on
Linux, macOS and Windows across Node 20, 22 and 24. There are no dependencies.

To check the catalog against the live registries:

```bash
LOCALCODE_NETWORK_TESTS=1 node --test tests/catalog.test.mjs
```

## More documentation

- [Configuration and script reference](docs/api-reference.md)
- [Authentication and credentials](docs/auth-providers.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Example configurations](configs/)

## License

[MIT](LICENSE)
