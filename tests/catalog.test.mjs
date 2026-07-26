import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BITS_PER_WEIGHT } from "../scripts/vram-profile.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const catalog = JSON.parse(await fs.readFile(path.join(root, "models.json"), "utf8"));

// Network checks are opt-in so offline runs and CI stay green:
//   LOCALCODE_NETWORK_TESTS=1 node --test tests/catalog.test.mjs
const online = process.env.LOCALCODE_NETWORK_TESTS === "1";

test("catalog is internally consistent", () => {
  const ids = catalog.models.map((model) => model.id);
  assert.equal(new Set(ids).size, ids.length, "model ids must be unique");
  assert.ok(ids.includes(catalog.default_model), "default_model must exist in the catalog");

  for (const model of catalog.models) {
    assert.ok(model.variants.length > 0, `${model.id} has no variants`);
    assert.ok(Number.isInteger(model.context) && model.context > 0, `${model.id} needs a context length`);

    // The profiler needs both to size anything.
    assert.ok(model.params_b > 0, `${model.id} needs params_b`);
    assert.ok(model.arch, `${model.id} needs an arch block`);
    for (const field of ["layers", "kv_layers", "kv_heads", "head_dim"]) {
      assert.ok(model.arch[field] > 0, `${model.id}.arch.${field} must be a positive number`);
    }
    assert.ok(
      model.arch.kv_layers <= model.arch.layers,
      `${model.id}: kv_layers cannot exceed layers`,
    );

    for (const variant of model.variants) {
      assert.ok(variant.quant, `${model.id} has a variant with no quant name`);
      assert.ok(
        variant.vllm || variant.ollama,
        `${model.id}/${variant.quant} must name a vLLM repo or an Ollama tag`,
      );
      // An unknown quant has no bits-per-weight, so the profiler cannot size it.
      assert.ok(
        BITS_PER_WEIGHT[variant.quant],
        `${model.id}/${variant.quant}: no bits-per-weight entry in vram-profile.mjs`,
      );
    }

    // Every model must stay reachable on a modest machine via at least one Ollama variant.
    assert.ok(
      model.variants.some((variant) => variant.ollama),
      `${model.id} has no Ollama variant, so non-GPU machines cannot run it`,
    );
  }
});

test("every HuggingFace repository resolves", { skip: online ? false : "set LOCALCODE_NETWORK_TESTS=1" }, async () => {
  const repos = catalog.models.flatMap((model) => (
    model.variants.flatMap((variant) => [variant.vllm, variant.gguf].filter(Boolean))
  ));

  for (const repo of [...new Set(repos)]) {
    const response = await fetch(`https://huggingface.co/api/models/${repo}`, {
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(response.status, 200, `HuggingFace repo not found: ${repo}`);
  }
});

test("every Ollama tag resolves", { skip: online ? false : "set LOCALCODE_NETWORK_TESTS=1" }, async () => {
  const tags = catalog.models.flatMap((model) => (
    model.variants.map((variant) => variant.ollama).filter(Boolean)
  ));

  for (const tag of [...new Set(tags)]) {
    const [name, version = "latest"] = tag.split(":");
    const repo = name.includes("/") ? name : `library/${name}`;
    const response = await fetch(`https://registry.ollama.ai/v2/${repo}/manifests/${version}`, {
      headers: { Accept: "application/vnd.docker.distribution.manifest.v2+json" },
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(response.status, 200, `Ollama tag not found: ${tag}`);
  }
});

test("architecture matches the published config", { skip: online ? false : "set LOCALCODE_NETWORK_TESTS=1" }, async () => {
  for (const model of catalog.models) {
    // Use the first ungated vLLM repo; gated ones refuse the raw config endpoint.
    const variant = model.variants.find((v) => v.vllm && !v.gated);
    if (!variant) continue;

    const response = await fetch(`https://huggingface.co/${variant.vllm}/raw/main/config.json`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) continue; // quantized mirrors do not always publish a config

    const raw = await response.json();
    const text = raw.text_config ?? raw; // multimodal models nest the language config

    assert.equal(model.arch.layers, text.num_hidden_layers, `${model.id}: layer count drifted`);
    assert.equal(model.arch.kv_heads, text.num_key_value_heads, `${model.id}: kv head count drifted`);

    const headDim = text.head_dim ?? text.hidden_size / text.num_attention_heads;
    assert.equal(model.arch.head_dim, headDim, `${model.id}: head_dim drifted`);

    // Hybrid models cache on only a fraction of their layers; that fraction drives the
    // whole context calculation, so verify it rather than trusting the catalog.
    const layerTypes = text.layer_types ?? [];
    const expectedKvLayers = layerTypes.length
      ? layerTypes.filter((type) => type === "full_attention").length
      : text.num_hidden_layers;

    assert.equal(
      model.arch.kv_layers,
      expectedKvLayers,
      `${model.id}: kv_layers should be ${expectedKvLayers}`,
    );
  }
});

test("gated repositories are labelled", { skip: online ? false : "set LOCALCODE_NETWORK_TESTS=1" }, async () => {
  for (const model of catalog.models) {
    for (const variant of model.variants.filter((v) => v.vllm)) {
      const response = await fetch(`https://huggingface.co/api/models/${variant.vllm}`, {
        signal: AbortSignal.timeout(20_000),
      });
      const body = await response.json();
      const isGated = body.gated !== false;
      assert.equal(
        Boolean(variant.gated),
        isGated,
        `${model.id}/${variant.quant}: ${variant.vllm} is gated=${body.gated}; the catalog says gated=${Boolean(variant.gated)}`,
      );
    }
  }
});
