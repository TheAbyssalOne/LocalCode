import test from "node:test";
import assert from "node:assert/strict";
import { parseNvidiaSmi, parseWslDistros } from "../scripts/detect.mjs";

test("nvidia-smi output becomes card records", () => {
  // Real format: name, memory.total in MiB, no header, no units.
  const cards = parseNvidiaSmi("NVIDIA GeForce RTX 5090, 32607\n");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].name, "NVIDIA GeForce RTX 5090");
  assert.equal(cards[0].vramGb, 32);
});

test("multi-GPU output keeps every card", () => {
  const cards = parseNvidiaSmi([
    "NVIDIA A100-SXM4-40GB, 40960",
    "NVIDIA A100-SXM4-40GB, 40960",
    "NVIDIA A100-SXM4-40GB, 40960",
  ].join("\n"));

  assert.equal(cards.length, 3);
  assert.deepEqual([...new Set(cards.map((c) => c.vramGb))], [40]);
});

test("absent or unparseable nvidia-smi output yields no cards", () => {
  assert.deepEqual(parseNvidiaSmi(null), []);
  assert.deepEqual(parseNvidiaSmi(""), []);
  // Driver present but no GPU: the value is not a number.
  assert.deepEqual(parseNvidiaSmi("No devices were found"), []);
});

test("wsl --list output survives its UTF-16 mangling", () => {
  // Node reads wsl.exe's UTF-16LE as UTF-8, interleaving NULs between characters.
  const mangled = "U\0b\0u\0n\0t\0u\0\n\0D\0e\0b\0i\0a\0n\0\n\0";
  assert.deepEqual(parseWslDistros(mangled), ["Ubuntu", "Debian"]);
});

test("a Docker helper VM is still just a listed distro", () => {
  // This is what a Docker-only Windows machine reports. It parses fine - proving it has
  // no shell is a separate probe, which is why listing alone must never imply usable.
  assert.deepEqual(parseWslDistros("docker-desktop\n"), ["docker-desktop"]);
  assert.deepEqual(parseWslDistros(""), []);
  assert.deepEqual(parseWslDistros(null), []);
});
