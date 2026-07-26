/**
 * VRAM memory profiler.
 *
 * Replaces the tier table that guessed context from card size. That guess was badly wrong
 * for hybrid models: Qwen3.6-27B runs linear attention on 48 of its 64 layers and only
 * caches KV on the other 16, so it holds roughly four times the context a dense 27B would
 * at the same VRAM. A tier table cannot know that; this computes it.
 *
 * Everything here is pure so it can be tested without a GPU.
 */

const GIB = 1024 ** 3;

// Bits per weight, including quantization metadata (scales, zero points).
export const BITS_PER_WEIGHT = {
  bf16: 16,
  fp16: 16,
  fp8: 8,
  q8_0: 8.5,
  int8: 8,
  q6_k: 6.56,
  gptq4: 4.25,
  awq4: 4.25,
  q5_k_m: 5.5,
  q4_k_m: 4.85,
  q4_0: 4.55,
  iq4: 4.25,
};

export const KV_DTYPE_BYTES = { fp16: 2, bf16: 2, fp8: 1, int8: 1 };

/** Default profiling target when no GPU is detected: a 32 GB card. */
export const DEFAULT_PROFILE_VRAM_GB = 32;

/**
 * Bytes of KV cache per token.
 * Only layers that actually cache KV count - `kv_layers`, not `layers`.
 */
export function kvBytesPerToken({ kv_layers, kv_heads, head_dim }, kvDtype = "fp16") {
  const bytes = KV_DTYPE_BYTES[kvDtype] ?? 2;
  return 2 * kv_layers * kv_heads * head_dim * bytes; // 2 = one K tensor + one V tensor
}

/** Weight footprint in GiB for a parameter count at a given quantization. */
export function weightsGib(paramsB, quant) {
  const bpw = BITS_PER_WEIGHT[quant];
  if (!bpw) throw new Error(`Unknown quantization '${quant}'`);
  return (paramsB * 1e9 * bpw) / 8 / GIB;
}

/**
 * Non-weight, non-KV VRAM: CUDA context, activation buffers, graphs, fragmentation.
 * Scales mildly with card size because bigger cards run bigger batches.
 */
export function overheadGib(vramGb) {
  return Math.min(3, Math.max(1.2, vramGb * 0.06));
}

/**
 * Profile a model variant against a card.
 *
 * `utilization` mirrors vLLM's --gpu-memory-utilization: the fraction of the card the
 * server is allowed to claim. Leaving headroom matters on a desktop where a display
 * server is also resident.
 */
export function profile({
  vramGb = DEFAULT_PROFILE_VRAM_GB,
  paramsB,
  quant,
  arch,
  kvDtype = "fp16",
  utilization = 0.90,
  maxContext = Infinity,
  gpuCount = 1,
}) {
  const totalGib = vramGb * gpuCount * (1024 ** 3) / GIB;
  const budget = totalGib * utilization;
  const weights = weightsGib(paramsB, quant);
  const overhead = overheadGib(vramGb);
  const kvGib = budget - weights - overhead;

  const perToken = kvBytesPerToken(arch, kvDtype);
  const rawTokens = kvGib > 0 ? Math.floor((kvGib * GIB) / perToken) : 0;

  // Round down to a 1024 boundary: engines allocate cache in blocks anyway.
  const tokens = Math.max(0, Math.floor(rawTokens / 1024) * 1024);
  const maxModelLen = Math.min(tokens, maxContext);

  return {
    fits: kvGib > 0 && maxModelLen >= 4096,
    weightsGib: Number(weights.toFixed(2)),
    overheadGib: Number(overhead.toFixed(2)),
    kvGib: Number(Math.max(0, kvGib).toFixed(2)),
    kvBytesPerToken: perToken,
    maxModelLen,
    contextCapped: maxModelLen < maxContext && maxModelLen === tokens,
    vramGb: vramGb * gpuCount,
  };
}

/** Context worth having for agentic coding. Below this, precision is a poor trade. */
export const TARGET_CONTEXT = 32768;

/**
 * Pick the best variant for a card.
 *
 * Fidelity is ranked *after* reaching a usable context, not before. On a 32 GB card
 * Qwen3.6 at fp8 leaves ~27K of context while awq4 leaves ~216K; the higher-precision
 * weights are the worse choice for coding work. So: take every variant that reaches the
 * target context and pick the most precise of those. If none reach it, fall back to
 * whichever leaves the most context.
 *
 * A model whose own maximum is below the target (Phi-3 at 4096) is judged against its own
 * ceiling instead, otherwise it could never be selected at all.
 */
export function bestVariantFor({
  variants, paramsB, arch, vramGb, maxContext = Infinity,
  kvDtype = "fp16", gpuCount = 1, targetContext = TARGET_CONTEXT,
}) {
  const target = Math.min(targetContext, maxContext);

  const scored = variants
    .map((variant) => ({
      variant,
      profile: profile({ vramGb, paramsB, quant: variant.quant, arch, kvDtype, maxContext, gpuCount }),
    }))
    .filter((entry) => entry.profile.fits);

  if (!scored.length) return null;

  const bits = (entry) => BITS_PER_WEIGHT[entry.variant.quant] ?? 0;
  const reachesTarget = scored.filter((entry) => entry.profile.maxModelLen >= target);

  if (reachesTarget.length) {
    // Most precise among those with enough context; ties go to more context.
    return reachesTarget.reduce((best, entry) => {
      if (bits(entry) !== bits(best)) return bits(entry) > bits(best) ? entry : best;
      return entry.profile.maxModelLen > best.profile.maxModelLen ? entry : best;
    });
  }

  // Nothing reaches the target: context is the scarce resource, so maximise it.
  return scored.reduce((best, entry) => (
    entry.profile.maxModelLen > best.profile.maxModelLen ? entry : best
  ));
}

export function formatProfile(result) {
  if (!result.fits) return "does not fit";
  const k = (n) => (n >= 1024 ? `${Math.round(n / 1024)}K` : String(n));
  return `${result.weightsGib} GiB weights + ${result.kvGib} GiB KV -> ${k(result.maxModelLen)} context`;
}
