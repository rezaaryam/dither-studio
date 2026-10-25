"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Gif = require("../src/gif.js");

/**
 * Minimal GIF decoder, only for the tests: reads the global palette and the
 * LZW image data of every frame, so we can check the encoder round trip.
 */
function decode(bytes) {
  let p = 0;
  const u8 = () => bytes[p++];
  const u16 = () => { const v = bytes[p] | (bytes[p + 1] << 8); p += 2; return v; };
  const sig = String.fromCharCode(...bytes.slice(0, 6)); p = 6;
  const width = u16(), height = u16(), flags = u8(); u8(); u8();
  const size = 1 << ((flags & 7) + 1);
  const palette = [];
  for (let i = 0; i < size; i++) palette.push([u8(), u8(), u8()]);
  const frames = []; let loop = null; const delays = [];
  for (;;) {
    const b = u8();
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = u8();
      if (label === 0xff) {
        const len = u8(); const app = String.fromCharCode(...bytes.slice(p, p + len)); p += len;
        if (app === "NETSCAPE2.0") { u8(); u8(); loop = u16(); }
        while (u8() !== 0) {} // ends with the 0 terminator
      } else if (label === 0xf9) {
        u8(); u8(); delays.push(u16()); u8(); u8();
      } else { let n; while ((n = u8())) p += n; }
      continue;
    }
    if (b !== 0x2c) throw new Error("unexpected block " + b);
    u16(); u16(); const fw = u16(), fh = u16(); u8();
    const min = u8();
    const data = [];
    let n; while ((n = u8())) { for (let i = 0; i < n; i++) data.push(u8()); }
    frames.push(lzwDecode(data, min, fw * fh));
  }
  return { sig, width, height, palette, frames, loop, delays };
}

function lzwDecode(data, min, count) {
  const clear = 1 << min, eoi = clear + 1;
  let size = min + 1, dict = [], next = eoi + 1, prev = null;
  const reset = () => { dict = []; for (let i = 0; i < clear; i++) dict[i] = [i]; size = min + 1; next = eoi + 1; prev = null; };
  reset();
  const out = []; let bit = 0;
  const read = () => {
    let v = 0;
    for (let i = 0; i < size; i++) { const byte = data[(bit + i) >> 3]; v |= ((byte >> ((bit + i) & 7)) & 1) << i; }
    bit += size; return v;
  };
  for (;;) {
    const code = read();
    if (code === clear) { reset(); continue; }
    if (code === eoi) break;
    let entry;
    if (code < next && dict[code]) entry = dict[code];
    else if (code === next && prev) entry = prev.concat(prev[0]);
    else throw new Error("bad code " + code);
    out.push(...entry);
    if (prev) { dict[next++] = prev.concat(entry[0]); if (next === (1 << size) && size < 12) size++; }
    prev = entry;
  }
  assert.equal(out.length, count, "pixel count");
  return Uint8Array.from(out);
}

function pattern(w, h, colors, seed) {
  const f = new Uint8Array(w * h);
  let s = seed;
  for (let i = 0; i < f.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; f[i] = (i % 7 === 0 ? s >> 16 : i >> 4) % colors; }
  return f;
}

test("header, palette padding, and a single frame round trip", () => {
  const pal = [[0, 0, 0], [255, 255, 255], [255, 0, 0]];
  const frame = pattern(10, 6, 3, 1);
  const g = decode(Gif.encode({ width: 10, height: 6, palette: pal, frames: [frame] }));
  assert.equal(g.sig, "GIF89a");
  assert.equal(g.width, 10);
  assert.equal(g.palette.length, 4); // padded to a power of two
  assert.deepEqual(g.palette.slice(0, 3), pal);
  assert.deepEqual(Array.from(g.frames[0]), Array.from(frame));
  assert.equal(g.loop, null);
});

test("animated: loop extension, delays, every frame decodes", () => {
  const pal = [[15, 56, 15], [48, 98, 48], [139, 172, 15], [155, 188, 15]];
  const frames = [1, 2, 3].map((s) => pattern(40, 30, 4, s));
  const g = decode(Gif.encode({ width: 40, height: 30, palette: pal, frames, delay: 80 }));
  assert.equal(g.loop, 0);
  assert.deepEqual(g.delays, [8, 8, 8]);
  frames.forEach((f, i) => assert.deepEqual(Array.from(g.frames[i]), Array.from(f)));
});

test("large noisy frame forces dictionary resets and still round trips", () => {
  const w = 320, h = 240, pal = Array.from({ length: 16 }, (_, i) => [i * 16, i * 8, 255 - i * 16]);
  const f = new Uint8Array(w * h);
  let s = 7;
  for (let i = 0; i < f.length; i++) { s = (s * 48271) % 2147483647; f[i] = s % 16; }
  const bytes = Gif.encode({ width: w, height: h, palette: pal, frames: [f] });
  const g = decode(bytes);
  assert.deepEqual(Array.from(g.frames[0]), Array.from(f));
});

test("two-color palette uses the minimum code size of 2", () => {
  const f = Uint8Array.from({ length: 64 }, (_, i) => (i >> 3) % 2);
  const g = decode(Gif.encode({ width: 8, height: 8, palette: [[0, 0, 0], [255, 255, 255]], frames: [f] }));
  assert.deepEqual(Array.from(g.frames[0]), Array.from(f));
});

test("invalid input is rejected", () => {
  assert.throws(() => Gif.encode({ width: 2, height: 2, palette: [], frames: [new Uint8Array(4)] }));
  assert.throws(() => Gif.encode({ width: 2, height: 2, palette: [[0, 0, 0]], frames: [new Uint8Array(3)] }));
  assert.throws(() => Gif.encode({ width: 2, height: 2, palette: [[0, 0, 0]], frames: [] }));
});
