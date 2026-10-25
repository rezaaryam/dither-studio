/*!
 * dither-studio GIF encoder 1.0.0
 * A small animated GIF89a writer. Dithered frames already use a tiny palette,
 * so there is no color quantization step: indices go straight into LZW.
 * MIT License, Reza Arya Maulana.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GifEncoder = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function ByteWriter() { this.buf = new Uint8Array(1 << 16); this.len = 0; }
  ByteWriter.prototype.grow = function (n) {
    if (this.len + n <= this.buf.length) return;
    var next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  };
  ByteWriter.prototype.byte = function (b) { this.grow(1); this.buf[this.len++] = b & 255; };
  ByteWriter.prototype.word = function (w) { this.byte(w & 255); this.byte((w >> 8) & 255); };
  ByteWriter.prototype.bytes = function (arr) { this.grow(arr.length); this.buf.set(arr, this.len); this.len += arr.length; };
  ByteWriter.prototype.str = function (s) { for (var i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); };
  ByteWriter.prototype.result = function () { return this.buf.slice(0, this.len); };

  /** Smallest power of two (>= 2 entries) that fits n colors, as GIF "size" bits. */
  function tableBits(n) { var b = 1; while ((1 << b) < n) b++; return Math.max(1, b); }

  /**
   * LZW compression of palette indices, emitted as GIF data sub-blocks.
   * minCodeSize is the bit width of the palette (at least 2).
   */
  function lzw(indices, minCodeSize, out) {
    var clear = 1 << minCodeSize, eoi = clear + 1;
    var codeSize = minCodeSize + 1, next = eoi + 1;
    var dict = new Map();
    var cur = 0, bits = 0;
    var block = new Uint8Array(255), blen = 0;

    function flushBlock() {
      if (!blen) return;
      out.byte(blen);
      out.bytes(block.subarray(0, blen));
      blen = 0;
    }
    function emit(code) {
      cur |= code << bits;
      bits += codeSize;
      while (bits >= 8) {
        block[blen++] = cur & 255;
        if (blen === 255) flushBlock();
        cur >>>= 8;
        bits -= 8;
      }
    }

    out.byte(minCodeSize);
    emit(clear);
    var prefix = indices[0];
    for (var i = 1; i < indices.length; i++) {
      var k = indices[i];
      var key = prefix * 4096 + k;
      var hit = dict.get(key);
      if (hit !== undefined) { prefix = hit; continue; }
      emit(prefix);
      if (next < 4096) {
        dict.set(key, next++);
        // The decoder grows its code size one code later than we add entries.
        if (next > (1 << codeSize) && codeSize < 12) codeSize++;
      } else {
        emit(clear);
        dict.clear();
        codeSize = minCodeSize + 1;
        next = eoi + 1;
      }
      prefix = k;
    }
    emit(prefix);
    emit(eoi);
    if (bits > 0) { block[blen++] = cur & 255; if (blen === 255) flushBlock(); }
    flushBlock();
    out.byte(0); // block terminator
  }

  /**
   * encode({ width, height, palette: [[r,g,b], ...], frames: [Uint8Array], delay: ms, loop: 0 })
   * Returns a Uint8Array with the GIF file.
   */
  function encode(opts) {
    var w = opts.width, h = opts.height, pal = opts.palette, frames = opts.frames;
    if (!w || !h) throw new Error("width and height are required");
    if (!pal || pal.length < 1 || pal.length > 256) throw new Error("palette must have 1 to 256 colors");
    if (!frames || !frames.length) throw new Error("at least one frame is required");
    var bitsN = tableBits(pal.length), tableLen = 1 << bitsN;
    var minCode = Math.max(2, bitsN);
    var delay = Math.round((opts.delay == null ? 100 : opts.delay) / 10); // centiseconds

    var out = new ByteWriter();
    out.str("GIF89a");
    out.word(w); out.word(h);
    out.byte(0x80 | ((bitsN - 1) << 4) | (bitsN - 1)); // global table, color resolution, size
    out.byte(0); out.byte(0); // background index, aspect
    for (var i = 0; i < tableLen; i++) {
      var c = pal[i] || [0, 0, 0];
      out.byte(c[0]); out.byte(c[1]); out.byte(c[2]);
    }
    if (frames.length > 1) {
      out.byte(0x21); out.byte(0xff); out.byte(11); out.str("NETSCAPE2.0");
      out.byte(3); out.byte(1); out.word(opts.loop == null ? 0 : opts.loop); out.byte(0);
    }
    frames.forEach(function (f) {
      if (f.length !== w * h) throw new Error("frame size does not match width x height");
      out.byte(0x21); out.byte(0xf9); out.byte(4); // graphic control extension
      out.byte(0); out.word(delay); out.byte(0); out.byte(0);
      out.byte(0x2c); out.word(0); out.word(0); out.word(w); out.word(h); out.byte(0);
      lzw(f, minCode, out);
    });
    out.byte(0x3b);
    return out.result();
  }

  return { encode: encode, version: "1.0.0" };
});
