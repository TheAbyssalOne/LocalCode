import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  applyMarkerBlock,
  buildPlan,
  INSTALLED_FILES,
  memoryBudgetGb,
  vllmServeArgs,
  parseArgs,
  selectProvider,
  selectVariant,
  selectVllmHost,
} from "../scripts/setup.mjs";
import { kvBytesPerToken, profile, weightsGib } from "../scripts/vram-profile.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const exec = promisify(execFile);
const catalog = JSON.parse(await fs.readFile(path.join(root, "models.json"), "utf8"));

function environment(overrides = {}) {
  return {
    platform: "linux",
    arch: "x64",
    ramGb: 32,
    nodeVersion: process.version,
    gpu: { vendor: "none", cards: [], vramGb: 0 },
    wsl2: { available: false, distros: [] },
    docker: { available: false, version: null },
    python: { command: "python3", version: "3.12", meetsVllm: true },
    has: { ollama: true, opencode: true },
    servers: {},
    ...overrides,
  };
}

const nvidia = (vramGb) => ({ vendor: "nvidia", cards: [{ name: "Test GPU", vramGb }], vramGb });

test("unknown flags are rejected rather than silently ignored", () => {
  assert.throws(() => parseArgs(["--wat"]), /Unknown option: --wat/);
  assert.deepEqual(parseArgs(["--model", "phi3-mini", "-y"]).model, "phi3-mini");
});

test("provider selection follows the hardware", () => {
  assert.equal(selectProvider(environment({ gpu: nvidia(80) })).provider, "vllm");

  // Apple Silicon has no practical vLLM path.
  const apple = selectProvider(environment({ platform: "darwin", arch: "arm64", gpu: { vendor: "apple", cards: [], vramGb: 0 } }));
  assert.equal(apple.provider, "ollama");
  assert.equal(apple.fallbackFrom, "vllm");

  // A GPU without Python 3.9+ cannot run vLLM.
  const noPython = selectProvider(environment({ gpu: nvidia(48), python: { command: null, version: null, meetsVllm: false } }));
  assert.equal(noPython.provider, "ollama");
  assert.equal(noPython.fallbackFrom, "vllm");

  // An already-running server wins over speculative installation.
  const running = selectProvider(environment({
    gpu: nvidia(80),
    servers: { lmstudio: { baseURL: "http://127.0.0.1:1234/v1", models: ["x"] } },
  }));
  assert.equal(running.provider, "lmstudio");
});

test("vLLM on Windows routes through WSL2, never native", () => {
  assert.equal(selectVllmHost(environment({ platform: "win32", wsl2: { available: true, distros: ["Ubuntu"] } })), "wsl");
  assert.equal(selectVllmHost(environment({ platform: "linux" })), "native");
  assert.equal(selectVllmHost(environment({ platform: "win32" })), null);

  // Docker Model Runner cannot serve arbitrary HuggingFace repos, so its presence is not
  // a vLLM backend: a Docker-only Windows box must still report no host.
  assert.equal(
    selectVllmHost(environment({ platform: "win32", docker: { available: true, version: "29.6" } })),
    null,
  );

  // Explicit --provider vllm must fail loudly, naming the fix.
  assert.throws(
    () => buildPlan({ env: environment({ platform: "win32", gpu: nvidia(24) }), catalog, flags: { ...parseArgs([]), provider: "vllm" } }),
    /wsl --install/,
  );

  // A WSL entry with no shell (Docker's helper VM) must not count as available.
  const dockerVm = environment({
    platform: "win32",
    gpu: nvidia(24),
    wsl2: { available: false, distros: ["docker-desktop"], listedOnly: true },
  });
  assert.match(selectProvider(dockerVm).reason, /no usable WSL2/);
});

test("KV cache math counts only the layers that cache", () => {
  const qwen = catalog.models.find((m) => m.id === "qwen3.6-27b");

  // Hybrid: 16 of 64 layers cache KV. 2 * 16 * 4 * 256 * 2 bytes = 64 KiB/token.
  assert.equal(kvBytesPerToken(qwen.arch), 65536);
  // fp8 KV halves it.
  assert.equal(kvBytesPerToken(qwen.arch, "fp8"), 32768);

  // A conventional dense model of similar size caches on every layer and costs far more.
  const dense = catalog.models.find((m) => m.id === "qwen3-coder-30b");
  assert.ok(kvBytesPerToken(dense.arch) > kvBytesPerToken(qwen.arch));
});

test("weight footprint follows bits per weight", () => {
  // 27B at bf16 = 27e9 * 2 bytes = ~50.3 GiB.
  assert.ok(Math.abs(weightsGib(27, "bf16") - 50.3) < 0.5);
  // 4-bit is roughly a quarter of that.
  assert.ok(Math.abs(weightsGib(27, "awq4") - 13.4) < 0.5);
});

test("32 GB card profile matches the hand calculation", () => {
  const qwen = catalog.models.find((m) => m.id === "qwen3.6-27b");
  const q6 = profile({ vramGb: 32, paramsB: 27, quant: "q6_k", arch: qwen.arch, maxContext: qwen.context });

  // ~20.6 GiB of weights leaves ~6 GiB of KV, which at 64 KiB/token is ~100K context.
  assert.ok(q6.fits);
  assert.ok(q6.maxModelLen >= 64 * 1024 && q6.maxModelLen <= 128 * 1024, `expected 64K-128K, got ${q6.maxModelLen}`);

  // fp8 weights are heavier and leave far less room, despite being "higher quality".
  const fp8 = profile({ vramGb: 32, paramsB: 27, quant: "fp8", arch: qwen.arch, maxContext: qwen.context });
  assert.ok(fp8.maxModelLen < q6.maxModelLen);

  // bf16 cannot fit at all on 32 GB.
  assert.equal(profile({ vramGb: 32, paramsB: 27, quant: "bf16", arch: qwen.arch }).fits, false);

  // fp8 KV roughly doubles the context for the same weights.
  const q6fp8 = profile({ vramGb: 32, paramsB: 27, quant: "q6_k", arch: qwen.arch, maxContext: qwen.context, kvDtype: "fp8" });
  assert.ok(q6fp8.maxModelLen >= q6.maxModelLen * 1.9);
});

test("context never exceeds the model's own maximum", () => {
  const phi = catalog.models.find((m) => m.id === "phi3-mini");
  // Tiny weights leave plenty of room, but the model only supports 4096.
  assert.equal(profile({ vramGb: 80, paramsB: 3.8, quant: "bf16", arch: phi.arch, maxContext: 4096 }).maxModelLen, 4096);
});

test("multiple GPUs pool their memory", () => {
  const qwen = catalog.models.find((m) => m.id === "qwen3.6-27b");
  const single = profile({ vramGb: 32, paramsB: 27, quant: "bf16", arch: qwen.arch, maxContext: qwen.context });
  const dual = profile({ vramGb: 32, gpuCount: 2, paramsB: 27, quant: "bf16", arch: qwen.arch, maxContext: qwen.context });

  assert.equal(single.fits, false);
  assert.equal(dual.fits, true, "bf16 should fit across 2x32 GB");
});

test("variant selection prefers fidelity but demands usable context", () => {
  const qwen = catalog.models.find((m) => m.id === "qwen3.6-27b");

  // 80 GB holds bf16 with room to spare.
  assert.equal(selectVariant(qwen, { provider: "vllm", budgetGb: 80 }).quant, "bf16");

  // 32 GB: fp8 technically fits but leaves little context, so awq4 wins on usable context.
  assert.equal(selectVariant(qwen, { provider: "vllm", budgetGb: 32 }).quant, "awq4");

  // Nothing fits an 8 GB card for a 27B model.
  assert.equal(selectVariant(qwen, { provider: "vllm", budgetGb: 8 }), null);

  // Ollama only ever picks a GGUF variant.
  assert.ok(selectVariant(qwen, { provider: "ollama", budgetGb: 32 }).ollama);

  assert.throws(() => selectVariant(qwen, { provider: "vllm", budgetGb: 80, quant: "nope" }), /no 'nope' variant/);
});

test("memory budget follows the accelerator, not just system RAM", () => {
  assert.equal(memoryBudgetGb(environment({ gpu: nvidia(24) }), "vllm"), 24);
  // Apple Silicon shares system memory with the GPU.
  assert.equal(memoryBudgetGb(environment({ ramGb: 64, gpu: { vendor: "apple", cards: [], vramGb: 0 } }), "ollama"), 48);
  // No GPU: Ollama runs on system RAM.
  assert.equal(memoryBudgetGb(environment({ ramGb: 16 }), "ollama"), 16);
});

test("a model too big for the machine fails with a usable message", () => {
  assert.throws(
    () => buildPlan({ env: environment({ ramGb: 4 }), catalog, flags: { ...parseArgs([]), model: "qwen3.6-27b" } }),
    /No Qwen3.6 27B variant fits 4 GB/,
  );
});

test("serve args carry everything the model needs", () => {
  const qwen = catalog.models.find((m) => m.id === "qwen3.6-27b");
  const awq = qwen.variants.find((v) => v.quant === "awq4");

  const args = vllmServeArgs({
    model: qwen, variant: awq, maxModelLen: 221184, gpuCount: 1, kvDtype: "fp16",
  });

  // Context limit must reach the server or vLLM allocates for the full 262144 and OOMs.
  assert.deepEqual(args.slice(0, 2), ["--max-model-len", "221184"]);
  // AWQ weights need the quantization flag.
  assert.ok(args.join(" ").includes("--quantization awq"));
  // Qwen3.6 needs its reasoning parser or reasoning output is never parsed.
  assert.ok(args.join(" ").includes("--reasoning-parser qwen3"));

  const multi = vllmServeArgs({
    model: qwen, variant: awq, maxModelLen: 32768, gpuCount: 4, kvDtype: "fp8",
  });
  assert.ok(multi.join(" ").includes("--tensor-parallel-size 4"));
  assert.ok(multi.join(" ").includes("--kv-cache-dtype fp8"));
});

test("INSTALLED_FILES covers the whole import graph", async () => {
  // The previous installer shipped without files its own wrappers called. Walk the
  // imports of every installed .mjs and fail if the list falls behind.
  const seen = new Set();
  const queue = INSTALLED_FILES.filter((name) => name.endsWith(".mjs"));

  while (queue.length) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    seen.add(name);

    const source = await fs.readFile(path.join(root, "scripts", name), "utf8");
    for (const match of source.matchAll(/from\s+"\.\/([\w.-]+\.mjs)"/g)) {
      const dependency = match[1];
      assert.ok(
        INSTALLED_FILES.includes(dependency),
        `${name} imports ${dependency}, which INSTALLED_FILES does not copy`,
      );
      queue.push(dependency);
    }
  }

  // Every listed file must actually exist.
  for (const name of INSTALLED_FILES) {
    assert.ok(
      await fs.access(path.join(root, "scripts", name)).then(() => true, () => false),
      `INSTALLED_FILES lists ${name}, which does not exist`,
    );
  }
});

test("shell marker block is idempotent and preserves surrounding content", () => {
  const original = "export PATH=/custom\n";
  const once = applyMarkerBlock(original, "line-a");
  const twice = applyMarkerBlock(once, "line-b");

  assert.equal((twice.match(/# >>> opencode-local-setup >>>/g) ?? []).length, 1);
  assert.ok(twice.includes("export PATH=/custom"));
  assert.ok(twice.includes("line-b"));
  assert.ok(!twice.includes("line-a"));
});

test("setup writes config and wires the shell without clobbering user content", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "localcode-setup-"));
  const configHome = path.join(temp, ".config");
  const rcFile = path.join(temp, process.platform === "win32" ? "Documents/PowerShell/Microsoft.PowerShell_profile.ps1" : ".bashrc");

  await fs.mkdir(path.dirname(rcFile), { recursive: true });
  await fs.writeFile(rcFile, "# user content\n");

  const env = {
    ...process.env,
    HOME: temp,
    USERPROFILE: temp,
    XDG_CONFIG_HOME: configHome,
    SHELL: "/bin/bash",
    OPENCODE_SYNC_TIMEOUT_MS: "50",
    // Never let a test install OpenCode, Ollama or vLLM onto the machine running it.
    LOCALCODE_SKIP_PREREQS: "1",
  };

  try {
    // --skip-models keeps the test offline; sync and doctor still exercise the real paths.
    const args = ["scripts/setup.mjs", "--yes", "--provider", "lmstudio", "--model", "phi3-mini", "--skip-models", "--skip-serve"];
    await exec(process.execPath, args, { cwd: root, env, encoding: "utf8" });

    const configPath = path.join(configHome, "opencode", "opencode.json");
    const cfg = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(cfg.$schema, "https://opencode.ai/config.json");
    assert.equal(cfg.share, "manual");
    assert.equal(cfg.provider.lmstudio.options.baseURL, "http://127.0.0.1:1234/v1");

    const envFile = path.join(configHome, "opencode", "local-setup", ".env.local");
    await fs.appendFile(envFile, "\n# preserve-me\n");

    // Second run must be idempotent: one marker block, preserved env file, preserved user content.
    await exec(process.execPath, args, { cwd: root, env, encoding: "utf8" });

    const rc = await fs.readFile(rcFile, "utf8");
    assert.equal((rc.match(/# >>> opencode-local-setup >>>/g) ?? []).length, 1);
    assert.ok(rc.includes("# user content"));
    assert.ok((await fs.readFile(envFile, "utf8")).includes("# preserve-me"));

    if (process.platform !== "win32") {
      assert.equal((await fs.stat(envFile)).mode & 0o777, 0o600);
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
