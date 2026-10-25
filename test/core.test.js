"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../src/dither.js");

/** A w x h RGBA buffer filled with one gray level (0..255). */
function flat(w, h, v, a = 255) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) d.set([v, v, v, a], i * 4);
  return d;
}
/** Horizontal gradient from black to white. */
function ramp(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = Math.round((x / (w - 1)) * 255);
    d.set([v, v, v, 255], (y * w + x) * 4);
  }
  return d;
}
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
const BW = D.makePalette(["#000000", "#ffffff"]);
const whiteIndex = 1;

test("colors parse and round trip", () => {
  assert.deepEqual(D.hexToRgb("#ff8000"), [255, 128, 0]);
  assert.deepEqual(D.hexToRgb("0f0"), [0, 255, 0]);
  assert.equal(D.rgbToHex([255, 128, 0]), "#ff8000");
  assert.throws(() => D.hexToRgb("#zz0000"));
});

test("palette ramp is sorted from dark to light but keeps original indices", () => {
  const p = D.makePalette(["#ffffff", "#000000", "#808080"]);
  assert.deepEqual(p.ramp.map((r) => r.i), [1, 2, 0]);
});

test("bayer matrices hold every rank exactly once", () => {
  for (const n of [2, 4, 8]) {
    const m = D.bayer(n);
    const ranks = m.flat().map((v) => Math.round(v * n * n - 0.5)).sort((a, b) => a - b);
    assert.deepEqual(ranks, [...Array(n * n).keys()]);
  }
  assert.deepEqual(D.bayer(2).map((r) => r.map((v) => v * 4 - 0.5)), [[0, 2], [3, 1]]);
});

test("tone: brightness, contrast, gamma, invert, and transparent pixels as paper", () => {
  const mid = flat(2, 2, 128);
  assert.ok(Math.abs(D.toneLuma(mid, 2, 2)[0] - 128 / 255) < 1e-3);
  assert.ok(D.toneLuma(mid, 2, 2, { brightness: 0.2 })[0] > 0.65);
  assert.ok(D.toneLuma(mid, 2, 2, { invert: true })[0] < 0.5);
  assert.equal(D.toneLuma(flat(2, 2, 0, 0), 2, 2)[0], 1);
  const dark = flat(2, 2, 60);
  assert.ok(D.toneLuma(dark, 2, 2, { contrast: 0.5 })[0] < D.toneLuma(dark, 2, 2)[0]);
});

for (const algo of D.ALGORITHMS.filter((a) => a !== "threshold")) {
  test(`${algo}: 50% gray turns into about half white pixels`, () => {
    const w = 64, h = 64;
    const lum = D.toneLuma(flat(w, h, 128), w, h);
    const idx = D.ditherLuma(lum, w, h, BW, algo);
    const white = mean(Array.from(idx, (i) => (i === whiteIndex ? 1 : 0)));
    const tolerance = algo === "atkinson" ? 0.2 : 0.06; // Atkinson drops 1/4 of the error by design
    assert.ok(Math.abs(white - 0.5) < tolerance, `${algo} gave ${white.toFixed(3)}`);
  });
}

test("error diffusion keeps the average brightness of a gradient", () => {
  const w = 128, h = 32;
  const lum = D.toneLuma(ramp(w, h), w, h);
  const idx = D.ditherLuma(lum, w, h, BW, "floyd-steinberg");
  const got = mean(Array.from(idx, (i) => (i === whiteIndex ? 1 : 0)));
  assert.ok(Math.abs(got - mean(Array.from(lum))) < 0.02);
});

test("threshold splits exactly at the middle", () => {
  const lum = new Float32Array([0.1, 0.49, 0.51, 0.9]);
  assert.deepEqual(Array.from(D.ditherLuma(lum, 4, 1, BW, "threshold")), [0, 0, 1, 1]);
});

test("multi-tone palettes use every level on a gradient", () => {
  const p = D.makePalette(["#0f380f", "#306230", "#8bac0f", "#9bbc0f"]);
  const w = 64, h = 8;
  const idx = D.ditherLuma(D.toneLuma(ramp(w, h), w, h), w, h, p, "bayer-4");
  assert.deepEqual([...new Set(idx)].sort(), [0, 1, 2, 3]);
});

test("color dithering picks the right palette colors", () => {
  const pal = D.makePalette(["#000000", "#ff0000", "#0000ff", "#ffffff"]);
  const w = 8, h = 8, d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) d.set(i < 32 ? [250, 10, 10, 255] : [10, 10, 245, 255], i * 4);
  const idx = D.ditherRgb(D.toneRgb(d, w, h), w, h, pal, "floyd-steinberg");
  assert.ok(Array.from(idx.slice(0, 24)).every((i) => i === 1));
  assert.ok(Array.from(idx.slice(40)).every((i) => i === 2));
});

test("halftone dots grow with darkness and stay within the cell", () => {
  const w = 60, h = 60;
  const light = D.halftone(D.toneLuma(flat(w, h, 200), w, h), w, h, 6, 45);
  const dark = D.halftone(D.toneLuma(flat(w, h, 50), w, h), w, h, 6, 45);
  const avgR = (ht) => mean(ht.dots.filter((_, i) => i % 3 === 2));
  assert.ok(avgR(dark) > avgR(light));
  assert.ok(Math.max(...dark.dots.filter((_, i) => i % 3 === 2)) <= 6 * 0.7071 * 1.02 + 0.01);
  assert.equal(D.halftone(D.toneLuma(flat(w, h, 255), w, h), w, h, 6, 45).dots.length, 0);
});

test("ascii maps dark to dense glyphs and keeps the requested width", () => {
  const w = 100, h = 50;
  const a = D.ascii(D.toneLuma(ramp(w, h), w, h), w, h, 20, "classic");
  assert.equal(a.lines[0].length, 20);
  assert.equal(a.lines[0][0], "@");
  assert.equal(a.lines[0][19], " ");
  assert.ok(a.rows > 4 && a.rows < 12);
});

test("svg export: runs are merged and the background is the most common color", () => {
  const idx = new Uint8Array([0, 0, 0, 1, 1, 1, 1, 1]);
  const svg = D.svgFromIndices(idx, 4, 2, BW);
  assert.match(svg, /<rect width="4" height="2" fill="#ffffff"\/>/);
  assert.match(svg, /M0 0h3v1h-3z/);
  assert.ok(D.svgHalftone({ dots: [1, 2, 3] }, 10, 10, "#000", "#fff").includes('<circle cx="1" cy="2" r="3"/>'));
  assert.ok(D.svgAscii({ lines: ["a<b"], rows: 1 }, 10, 10, "#000", "#fff").includes("a&lt;b"));
});

test("presets are valid and process() returns the right kind", () => {
  const w = 32, h = 24, data = ramp(w, h);
  for (const [name, p] of Object.entries(D.PRESETS)) {
    p.palette.forEach((c) => D.hexToRgb(c));
    const r = D.process(data, w, h, p);
    const kind = { pixel: "pixel", halftone: "halftone", ascii: "ascii" }[p.mode];
    assert.equal(r.kind, kind, name);
    if (kind === "pixel") {
      assert.equal(r.indices.length, w * h);
      assert.ok(Math.max(...r.indices) < p.palette.length);
    }
  }
});
