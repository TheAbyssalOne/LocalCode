import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspect, removeMarkerBlock, resetConfig, uninstall, START_MARKER, END_MARKER } from "../scripts/manage.mjs";

async function withInstall(run) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "localcode-manage-"));
  const setupDir = path.join(temp, "local-setup");
  const configPath = path.join(temp, "opencode.json");

  const previous = { dir: process.env.OPENCODE_LOCAL_SETUP_DIR, config: process.env.OPENCODE_CONFIG };
  process.env.OPENCODE_LOCAL_SETUP_DIR = setupDir;
  process.env.OPENCODE_CONFIG = configPath;

  await fs.mkdir(setupDir, { recursive: true });
  await fs.writeFile(path.join(setupDir, "doctor.mjs"), "// installed\n");
  await fs.writeFile(path.join(setupDir, ".env.local"), "LOCAL_API_BASE=http://127.0.0.1:8000/v1\n");

  try {
    await run({ temp, setupDir, configPath });
  } finally {
    if (previous.dir === undefined) delete process.env.OPENCODE_LOCAL_SETUP_DIR;
    else process.env.OPENCODE_LOCAL_SETUP_DIR = previous.dir;
    if (previous.config === undefined) delete process.env.OPENCODE_CONFIG;
    else process.env.OPENCODE_CONFIG = previous.config;
    await fs.rm(temp, { recursive: true, force: true });
  }
}

test("marker removal takes the block and nothing else", () => {
  const original = [
    "# my settings",
    "export EDITOR=vim",
    "",
    START_MARKER,
    "export OPENCODE_LOCAL_SETUP_DIR=/tmp/x",
    ". /tmp/x/opencode-wrapper.sh",
    END_MARKER,
    "",
    "alias ll='ls -la'",
  ].join("\n");

  const { content, removed } = removeMarkerBlock(original);
  assert.equal(removed, true);
  assert.ok(content.includes("export EDITOR=vim"));
  assert.ok(content.includes("alias ll='ls -la'"));
  assert.ok(!content.includes("opencode-local-setup"));
  assert.ok(!content.includes("opencode-wrapper.sh"));

  // Idempotent: removing again changes nothing.
  assert.equal(removeMarkerBlock(content).removed, false);
});

test("marker removal leaves a file that never had a block untouched", () => {
  const original = "# nothing to do here\nexport PATH=/usr/bin\n";
  const { content, removed } = removeMarkerBlock(original);
  assert.equal(removed, false);
  assert.equal(content.trim(), original.trim());
});

test("uninstall reports before it acts", async () => {
  await withInstall(async ({ setupDir }) => {
    const planned = await uninstall({ dryRun: true });
    assert.ok(planned.some((a) => a.action === "remove directory"));
    // Dry run must not touch the disk.
    assert.ok(await fs.access(setupDir).then(() => true, () => false));

    await uninstall();
    assert.equal(await fs.access(setupDir).then(() => true, () => false), false);
  });
});

test("uninstall removes managed providers but never the user's own", async () => {
  await withInstall(async ({ configPath }) => {
    await fs.writeFile(configPath, JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      agent: { build: { model: "vllm/qwen" } },
      mcp: { filesystem: { command: "mcp-fs" } },
      provider: {
        vllm: { options: { baseURL: "http://127.0.0.1:8000/v1" }, models: {} },
        ollama: { options: { baseURL: "http://127.0.0.1:11434/v1" }, models: {} },
        "my-gpu-box": { options: { baseURL: "http://100.64.0.5:8000/v1" }, models: {} },
      },
    }));

    await uninstall();
    const cfg = JSON.parse(await fs.readFile(configPath, "utf8"));

    assert.deepEqual(Object.keys(cfg.provider), ["my-gpu-box"]);
    // Everything LocalCode does not own survives.
    assert.ok(cfg.agent.build);
    assert.ok(cfg.mcp.filesystem);
    assert.equal(cfg.$schema, "https://opencode.ai/config.json");
  });
});

test("--keep-config leaves the config completely alone", async () => {
  await withInstall(async ({ configPath }) => {
    const original = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      provider: { vllm: { options: { baseURL: "http://127.0.0.1:8000/v1" }, models: {} } },
    });
    await fs.writeFile(configPath, original);

    await uninstall({ keepConfig: true });
    const cfg = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.ok(cfg.provider.vllm, "managed provider should survive --keep-config");
  });
});

test("reset-config restores defaults and keeps foreign providers", async () => {
  await withInstall(async ({ configPath }) => {
    await fs.writeFile(configPath, JSON.stringify({
      provider: {
        vllm: { options: { baseURL: "http://127.0.0.1:8000/v1" }, models: { a: {} } },
        "my-gpu-box": { options: { baseURL: "http://100.64.0.5:8000/v1" }, models: {} },
      },
      theme: "tokyonight",
    }));

    const result = await resetConfig();
    assert.deepEqual(result.cleared, ["vllm"]);
    assert.deepEqual(result.kept, ["my-gpu-box"]);

    const cfg = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(cfg.theme, "tokyonight", "unrelated settings must survive a reset");
    assert.equal(cfg.share, "manual");
    assert.ok(!cfg.provider.vllm);
  });
});

test("inspect separates managed from foreign providers", async () => {
  await withInstall(async ({ configPath }) => {
    await fs.writeFile(configPath, JSON.stringify({
      provider: {
        ollama: { options: { baseURL: "http://127.0.0.1:11434/v1" } },
        "my-gpu-box": { options: { baseURL: "http://100.64.0.5:8000/v1" } },
      },
      agent: { build: {} },
    }));

    const state = await inspect();
    assert.equal(state.installed, true);
    assert.equal(state.hasEnvFile, true);
    assert.deepEqual(state.config.managed, ["ollama"]);
    assert.deepEqual(state.config.foreign, ["my-gpu-box"]);
    assert.equal(state.config.hasAgents, true);
  });
});
