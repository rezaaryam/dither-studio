/*!
 * dither-studio core 1.0.0
 * Pure image functions: tone, ordered and error-diffusion dithering,
 * halftone, ASCII, palettes. No DOM, so it runs in a Web Worker and in Node.
 * MIT License, Reza Arya Maulana.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DitherCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------- colors
  function hexToRgb(hex) {
    var h = String(hex).replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (h.length !== 6 || isNaN(n)) throw new Error("Invalid color: " + hex);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(c) {
    return "#" + c.map(function (v) { return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"); }).join("");
  }
  /** Relative luminance on 0..1 using sRGB-ish weights (fast, good enough for dithering). */
  function luma(r, g, b) { return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }

  /** Palette helper: parse hex list, sort by luminance for ramp mapping. */
  function makePalette(hexes) {
    var cols = hexes.map(function (h, i) { var c = hexToRgb(h); return { i: i, rgb: c, l: luma(c[0], c[1], c[2]) }; });
    var ramp = cols.slice().sort(function (a, b) { return a.l - b.l; });
    return { colors: cols.map(function (c) { return c.rgb; }), ramp: ramp };
  }

  // ---------------------------------------------------------------- tone
  /**
   * Turn RGBA pixels into a float luminance plane with tone controls applied.
   * opts: brightness (-1..1), contrast (-1..1), gamma (0.2..3), invert, sharpen (0..2)
   */
  function toneLuma(data, w, h, opts) {
    opts = opts || {};
    var n = w * h, out = new Float32Array(n);
    var b = opts.brightness || 0, c = opts.contrast || 0, g = opts.gamma || 1;
    var cf = c >= 0 ? 1 + c * 3 : 1 + c; // stronger positive range feels better
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      var a = data[p + 3] / 255;
      // Transparent pixels are treated as white (paper).
      var v = luma(data[p], data[p + 1], data[p + 2]) * a + (1 - a);
      v = (v - 0.5) * cf + 0.5 + b;
      v = v <= 0 ? 0 : v >= 1 ? 1 : Math.pow(v, 1 / g);
      out[i] = opts.invert ? 1 - v : v;
    }
    if (opts.sharpen) sharpenPlane(out, w, h, opts.sharpen);
    return out;
  }

  /** RGB float planes (0..255) with the same tone controls, for color palettes. */
  function toneRgb(data, w, h, opts) {
    opts = opts || {};
    var n = w * h, out = new Float32Array(n * 3);
    var b = (opts.brightness || 0) * 255, c = opts.contrast || 0, g = opts.gamma || 1;
    var cf = c >= 0 ? 1 + c * 3 : 1 + c;
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      var a = data[p + 3] / 255;
      for (var k = 0; k < 3; k++) {
        var v = data[p + k] * a + 255 * (1 - a);
        v = (v - 127.5) * cf + 127.5 + b;
        v = v <= 0 ? 0 : v >= 255 ? 255 : 255 * Math.pow(v / 255, 1 / g);
        out[i * 3 + k] = opts.invert ? 255 - v : v;
      }
    }
    return out;
  }

  /** Unsharp mask (3x3 box blur) in place. Dithering loves a little extra edge. */
  function sharpenPlane(p, w, h, amount) {
    var src = Float32Array.from(p);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var s = 0, cnt = 0;
        for (var dy = -1; dy <= 1; dy++) {
          var yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (var dx = -1; dx <= 1; dx++) {
            var xx = x + dx; if (xx < 0 || xx >= w) continue;
            s += src[yy * w + xx]; cnt++;
          }
        }
        var i = y * w + x, v = src[i] + (src[i] - s / cnt) * amount;
        p[i] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
    }
    return p;
  }

  // ---------------------------------------------------------------- ordered
  /** Bayer matrix of size n (power of two), values normalized to 0..1 (exclusive). */
  function bayer(n) {
    var m = [[0]];
    for (var size = 1; size < n; size *= 2) {
      var next = [];
      for (var y = 0; y < size * 2; y++) {
        next.push([]);
        for (var x = 0; x < size * 2; x++) {
          var v = m[y % size][x % size] * 4;
          var q = (y < size ? 0 : 2) + (x < size ? 0 : 1);
          next[y].push(v + [0, 2, 3, 1][q]);
        }
      }
      m = next;
    }
    var nn = n * n;
    return m.map(function (row) { return row.map(function (v) { return (v + 0.5) / nn; }); });
  }

  // ---------------------------------------------------------------- diffusion kernels
  // [dx, dy, weight] with divisor
  var KERNELS = {
    "floyd-steinberg": { div: 16, k: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]] },
    "atkinson": { div: 8, k: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]] }, // loses 2/8 on purpose
    "jarvis": { div: 48, k: [[1, 0, 7], [2, 0, 5], [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3], [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]] },
    "stucki": { div: 42, k: [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2], [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1]] },
    "burkes": { div: 32, k: [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2]] },
    "sierra-lite": { div: 4, k: [[1, 0, 2], [-1, 1, 1], [0, 1, 1]] }
  };

  var ALGORITHMS = ["threshold", "bayer-2", "bayer-4", "bayer-8", "noise"].concat(Object.keys(KERNELS));

  /** Deterministic hash noise in 0..1, so frames do not shimmer. */
  function hash2(x, y) {
    var h = (x * 374761393 + y * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  /**
   * Dither a luminance plane onto a palette ramp (sorted dark to light).
   * Returns Uint8Array of palette indices (original palette order).
   */
  function ditherLuma(lum, w, h, palette, algorithm, opts) {
    opts = opts || {};
    var ramp = palette.ramp, steps = ramp.length - 1;
    var out = new Uint8Array(w * h);
    var levels = ramp.map(function (r) { return r.l; });
    // Spread levels evenly so a 2-color palette always splits at 50%,
    // unless "true tones" is requested.
    var even = !opts.trueTones;
    var lv = even ? levels.map(function (_, i) { return steps ? i / steps : 0; }) : levels;
    function nearest(v) {
      // ramp is sorted, so a linear walk is fine for small palettes
      var best = 0, bd = Infinity;
      for (var i = 0; i <= steps; i++) { var d = Math.abs(v - lv[i]); if (d < bd) { bd = d; best = i; } }
      return best;
    }
    var i, x, y;
    if (algorithm === "threshold" || algorithm === "noise" || /^bayer-/.test(algorithm)) {
      var mat = /^bayer-/.test(algorithm) ? bayer(+algorithm.split("-")[1]) : null;
      var ms = mat ? mat.length : 0;
      var spread = steps ? 1 / steps : 1;
      for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
        i = y * w + x;
        var t = mat ? mat[y % ms][x % ms] - 0.5 : algorithm === "noise" ? hash2(x, y) - 0.5 : 0;
        out[i] = ramp[nearest(lum[i] + t * spread)].i;
      }
      return out;
    }
    var K = KERNELS[algorithm];
    if (!K) throw new Error("Unknown algorithm: " + algorithm);
    var buf = Float32Array.from(lum);
    var serp = opts.serpentine !== false;
    for (y = 0; y < h; y++) {
      var rev = serp && y % 2 === 1;
      for (var xi = 0; xi < w; xi++) {
        x = rev ? w - 1 - xi : xi;
        i = y * w + x;
        var old = buf[i], q = nearest(old), err = old - lv[q];
        out[i] = ramp[q].i;
        for (var k = 0; k < K.k.length; k++) {
          var dx = rev ? -K.k[k][0] : K.k[k][0], dy = K.k[k][1];
          var nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= w || ny >= h) continue;
          buf[ny * w + nx] += err * K.k[k][2] / K.div;
        }
      }
    }
    return out;
  }

  /** Full-color dithering: nearest palette color in RGB with error diffusion or ordered. */
  function ditherRgb(rgb, w, h, palette, algorithm, opts) {
    opts = opts || {};
    var cols = palette.colors, nc = cols.length;
    var out = new Uint8Array(w * h);
    function nearest(r, g, b) {
      var best = 0, bd = Infinity;
      for (var i = 0; i < nc; i++) {
        var c = cols[i];
        // weighted RGB distance, cheaper than Lab and close enough
        var dr = r - c[0], dg = g - c[1], db = b - c[2];
        var d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    }
    var x, y, i;
    if (algorithm === "threshold" || algorithm === "noise" || /^bayer-/.test(algorithm)) {
      var mat = /^bayer-/.test(algorithm) ? bayer(+algorithm.split("-")[1]) : null;
      var ms = mat ? mat.length : 0, amp = 255 / Math.max(2, Math.cbrt(nc));
      for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
        i = y * w + x;
        var t = (mat ? mat[y % ms][x % ms] - 0.5 : algorithm === "noise" ? hash2(x, y) - 0.5 : 0) * amp;
        out[i] = nearest(rgb[i * 3] + t, rgb[i * 3 + 1] + t, rgb[i * 3 + 2] + t);
      }
      return out;
    }
    var K = KERNELS[algorithm];
    if (!K) throw new Error("Unknown algorithm: " + algorithm);
    var buf = Float32Array.from(rgb), serp = opts.serpentine !== false;
    for (y = 0; y < h; y++) {
      var rev = serp && y % 2 === 1;
      for (var xi = 0; xi < w; xi++) {
        x = rev ? w - 1 - xi : xi;
        i = y * w + x;
        var r = buf[i * 3], g = buf[i * 3 + 1], b = buf[i * 3 + 2];
        var q = nearest(r, g, b), c = cols[q];
        out[i] = q;
        var er = r - c[0], eg = g - c[1], eb = b - c[2];
        for (var k = 0; k < K.k.length; k++) {
          var dx = rev ? -K.k[k][0] : K.k[k][0], dy = K.k[k][1];
          var nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= w || ny >= h) continue;
          var j = (ny * w + nx) * 3, f = K.k[k][2] / K.div;
          buf[j] += er * f; buf[j + 1] += eg * f; buf[j + 2] += eb * f;
        }
      }
    }
    return out;
  }

  /** Paint palette indices into RGBA bytes. */
  function indicesToRgba(idx, palette, target) {
    var n = idx.length, out = target || new Uint8ClampedArray(n * 4), cols = palette.colors;
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      var c = cols[idx[i]];
      out[p] = c[0]; out[p + 1] = c[1]; out[p + 2] = c[2]; out[p + 3] = 255;
    }
    return out;
  }

  // ---------------------------------------------------------------- halftone
  /**
   * Classic halftone: a rotated grid of dots whose area matches local darkness.
   * Returns { dots: [x, y, r, ...] } in source pixel units.
   */
  function halftone(lum, w, h, cell, angleDeg) {
    cell = Math.max(2, cell || 6);
    var a = (angleDeg || 45) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    // Walk the rotated grid across a box that covers the whole image.
    var diag = Math.sqrt(w * w + h * h), half = diag / 2, cx = w / 2, cy = h / 2;
    var dots = [];
    var maxR = cell * 0.7071 * 1.02; // a full black cell overlaps its neighbours slightly
    for (var v = -half; v <= half; v += cell) {
      for (var u = -half; u <= half; u += cell) {
        var x = cx + u * ca - v * sa, y = cy + u * sa + v * ca;
        if (x < -cell || y < -cell || x > w + cell || y > h + cell) continue;
        // average luminance in the cell footprint (sampled 3x3)
        var sum = 0, cnt = 0;
        for (var sy = -1; sy <= 1; sy++) for (var sx = -1; sx <= 1; sx++) {
          var px = Math.round(x + sx * cell / 3), py = Math.round(y + sy * cell / 3);
          if (px < 0 || py < 0 || px >= w || py >= h) continue;
          sum += lum[py * w + px]; cnt++;
        }
        if (!cnt) continue;
        var dark = 1 - sum / cnt;
        if (dark <= 0.02) continue;
        // area of dot = darkness * area of cell
        var r = Math.min(maxR, Math.sqrt(dark * cell * cell / Math.PI));
        dots.push(+x.toFixed(2), +y.toFixed(2), +r.toFixed(2));
      }
    }
    return { dots: dots, cell: cell, angle: angleDeg || 45 };
  }

  // ---------------------------------------------------------------- ascii
  var RAMPS = {
    classic: " .:-=+*#%@",
    blocks: " ░▒▓█",
    dense: " .'`^\",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
    binary: " 01"
  };
  /**
   * Character grid. cols decides how many characters across; rows follow the
   * aspect of the glyph cell (about 0.5 wide per 1 tall).
   */
  function ascii(lum, w, h, cols, rampName, aspect) {
    var ramp = RAMPS[rampName] || rampName || RAMPS.classic;
    cols = Math.max(4, Math.round(cols || 80));
    var cw = w / cols, ch = cw / (aspect || 0.55), rows = Math.max(1, Math.round(h / ch));
    ch = h / rows;
    var lines = [];
    for (var r = 0; r < rows; r++) {
      var line = "";
      for (var c = 0; c < cols; c++) {
        var x0 = Math.floor(c * cw), x1 = Math.max(x0 + 1, Math.floor((c + 1) * cw));
        var y0 = Math.floor(r * ch), y1 = Math.max(y0 + 1, Math.floor((r + 1) * ch));
        var s = 0, n = 0;
        for (var y = y0; y < y1 && y < h; y += Math.max(1, (y1 - y0) >> 2)) {
          for (var x = x0; x < x1 && x < w; x += Math.max(1, (x1 - x0) >> 2)) { s += lum[y * w + x]; n++; }
        }
        var dark = 1 - (n ? s / n : 1);
        line += ramp[Math.min(ramp.length - 1, Math.floor(dark * ramp.length))];
      }
      lines.push(line);
    }
    return { lines: lines, cols: cols, rows: rows };
  }

  // ---------------------------------------------------------------- svg
  function esc(s) { return s.replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }

  /** Indexed pixels to SVG, merging horizontal runs so files stay reasonable. */
  function svgFromIndices(idx, w, h, palette, scale) {
    scale = scale || 1;
    var cols = palette.colors, bg = 0, counts = new Array(cols.length).fill(0);
    for (var i = 0; i < idx.length; i++) counts[idx[i]]++;
    for (var c = 1; c < cols.length; c++) if (counts[c] > counts[bg]) bg = c;
    var paths = cols.map(function () { return []; });
    for (var y = 0; y < h; y++) {
      var x = 0;
      while (x < w) {
        var v = idx[y * w + x], s = x;
        while (x < w && idx[y * w + x] === v) x++;
        if (v !== bg) paths[v].push("M" + s + " " + y + "h" + (x - s) + "v1h-" + (x - s) + "z");
      }
    }
    var body = paths.map(function (p, ci) {
      return p.length ? '<path fill="' + rgbToHex(cols[ci]) + '" d="' + p.join("") + '"/>' : "";
    }).join("");
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w * scale + '" height="' + h * scale + '" viewBox="0 0 ' + w + " " + h +
      '" shape-rendering="crispEdges"><rect width="' + w + '" height="' + h + '" fill="' + rgbToHex(cols[bg]) + '"/>' + body + "</svg>";
  }

  function svgHalftone(ht, w, h, ink, paper) {
    var d = ht.dots, circles = "";
    for (var i = 0; i < d.length; i += 3) circles += '<circle cx="' + d[i] + '" cy="' + d[i + 1] + '" r="' + d[i + 2] + '"/>';
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + " " + h + '"><rect width="' + w + '" height="' + h +
      '" fill="' + paper + '"/><g fill="' + ink + '">' + circles + "</g></svg>";
  }

  function svgAscii(a, w, h, ink, paper) {
    var lh = h / a.rows, fs = lh * 1.0;
    var text = a.lines.map(function (l, i) {
      return '<text x="0" y="' + ((i + 0.82) * lh).toFixed(2) + '" textLength="' + w + '" lengthAdjust="spacingAndGlyphs">' + esc(l).replace(/ /g, " ") + "</text>";
    }).join("");
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + " " + h + '"><rect width="' + w + '" height="' + h +
      '" fill="' + paper + '"/><g fill="' + ink + '" font-family="JetBrains Mono, Menlo, monospace" font-size="' + fs.toFixed(2) + '">' + text + "</g></svg>";
  }

  // ---------------------------------------------------------------- presets
  var PRESETS = {
    "classic": { label: "Classic 1-bit", mode: "pixel", algorithm: "atkinson", palette: ["#111111", "#f4f1ea"], pixel: 2, contrast: 0.15, sharpen: 0.6 },
    "newsprint": { label: "Newsprint", mode: "halftone", palette: ["#1b1a17", "#efe9dc"], cell: 7, angle: 45, contrast: 0.1 },
    "handheld": { label: "Handheld", mode: "pixel", algorithm: "bayer-4", palette: ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"], pixel: 3, contrast: 0.1 },
    "risograph": { label: "Risograph", mode: "pixel", algorithm: "floyd-steinberg", palette: ["#24307a", "#ff4f8b", "#f6efe4"], pixel: 2, contrast: 0.2, sharpen: 0.4 },
    "blueprint": { label: "Blueprint", mode: "pixel", algorithm: "bayer-8", palette: ["#0f3b7a", "#e8f0ff"], pixel: 2, invert: false, contrast: 0.05 },
    "terminal": { label: "Terminal", mode: "ascii", palette: ["#ffb22c", "#14100a"], cols: 110, ramp: "classic", contrast: 0.2 },
    "sixteen": { label: "Sixteen colors", mode: "pixel", color: true, algorithm: "floyd-steinberg", pixel: 3,
      palette: ["#1a1c2c", "#5d275d", "#b13e53", "#ef7d57", "#ffcd75", "#a7f070", "#38b764", "#257179", "#29366f", "#3b5dc9", "#41a6f6", "#73eff7", "#f4f4f4", "#94b0c2", "#566c86", "#333c57"] }
  };

  /**
   * One call that does it all, used by the worker.
   * Input RGBA pixels at working resolution; output either indices or shapes.
   */
  function process(data, w, h, s) {
    var pal = makePalette(s.palette);
    var tone = { brightness: s.brightness, contrast: s.contrast, gamma: s.gamma, invert: s.invert, sharpen: s.sharpen };
    // Halftone and ASCII draw ink (palette[0]) on paper (palette[1]). When the
    // paper is darker than the ink, bright areas must get the most ink.
    if (s.mode === "halftone" || s.mode === "ascii") {
      var ink = pal.colors[0], paper = pal.colors[1] || [255, 255, 255];
      if (luma(paper[0], paper[1], paper[2]) < luma(ink[0], ink[1], ink[2])) tone.invert = !tone.invert;
    }
    if (s.mode === "halftone") {
      var l1 = toneLuma(data, w, h, tone);
      return { kind: "halftone", w: w, h: h, ht: halftone(l1, w, h, s.cell, s.angle) };
    }
    if (s.mode === "ascii") {
      var l2 = toneLuma(data, w, h, tone);
      return { kind: "ascii", w: w, h: h, ascii: ascii(l2, w, h, s.cols, s.ramp) };
    }
    var idx = s.color
      ? ditherRgb(toneRgb(data, w, h, tone), w, h, pal, s.algorithm, s)
      : ditherLuma(toneLuma(data, w, h, tone), w, h, pal, s.algorithm, s);
    return { kind: "pixel", w: w, h: h, indices: idx };
  }

  return {
    version: "1.0.0",
    hexToRgb: hexToRgb, rgbToHex: rgbToHex, luma: luma, makePalette: makePalette,
    toneLuma: toneLuma, toneRgb: toneRgb, sharpenPlane: sharpenPlane,
    bayer: bayer, KERNELS: KERNELS, ALGORITHMS: ALGORITHMS, ditherLuma: ditherLuma, ditherRgb: ditherRgb,
    indicesToRgba: indicesToRgba, halftone: halftone, RAMPS: RAMPS, ascii: ascii,
    svgFromIndices: svgFromIndices, svgHalftone: svgHalftone, svgAscii: svgAscii,
    PRESETS: PRESETS, process: process
  };
});
