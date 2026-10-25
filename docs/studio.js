/*
 * Dither Studio app. MIT License, Reza Arya Maulana.
 * The heavy lifting happens in worker.js; this file keeps the UI responsive,
 * draws results, and handles sources and exports.
 */
(function () {
  "use strict";

  var D = window.DitherCore;
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  var TONE = { brightness: 0, contrast: 0, gamma: 1, sharpen: 0, invert: false };
  var BASE = { mode: "pixel", algorithm: "floyd-steinberg", pixel: 2, color: false, cell: 7, angle: 45, cols: 110, ramp: "classic" };
  var settings = {};

  var out = $("#out"), outCtx = out.getContext("2d");
  var orig = $("#orig"), origCtx = orig.getContext("2d");
  var frame = $("#frame"), stage = $("#stage");
  var grab = document.createElement("canvas"), grabCtx = grab.getContext("2d", { willReadFrequently: true });
  var tmp = document.createElement("canvas"), tmpCtx = tmp.getContext("2d");
  var video = $("#vid");

  // ---------------------------------------------------------------- worker
  var worker = new Worker("worker.js");
  var nextId = 1, waiting = {};
  worker.onmessage = function (e) {
    var m = e.data, cb = waiting[m.id];
    delete waiting[m.id];
    if (cb) cb(m);
  };
  function call(msg, transfer) {
    return new Promise(function (resolve, reject) {
      msg.id = nextId++;
      waiting[msg.id] = function (m) { if (m.error) reject(new Error(m.error)); else resolve(m); };
      worker.postMessage(msg, transfer || []);
    });
  }

  // ---------------------------------------------------------------- source
  var src = null; // { kind, el, w, h, mirror }
  function live() { return src && (src.kind === "video" || src.kind === "camera"); }

  function loadImage(url, label) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.decoding = "async";
      img.onload = function () { resolve({ kind: "image", el: img, w: img.naturalWidth, h: img.naturalHeight, label: label }); };
      img.onerror = reject;
      img.src = url;
    });
  }

  function useSource(s) {
    stopLive();
    src = s;
    firstRender = true;
    requestRender();
    refreshThumbs();
    updateExportHint();
  }

  function setSourceButton(which) {
    $$(".sources .src").forEach(function (b) {
      var on = b.getAttribute("data-sample") === which || b.id === which;
      b.classList.toggle("on", on);
      if (b.hasAttribute("aria-pressed")) b.setAttribute("aria-pressed", String(on));
    });
  }

  $$(".src[data-sample]").forEach(function (b) {
    b.addEventListener("click", function () {
      var name = b.getAttribute("data-sample");
      setSourceButton(name);
      loadImage("samples/" + name + ".webp", name).then(useSource);
    });
  });

  // files: button, drop, paste
  $("#fileIn").addEventListener("change", function (e) { if (e.target.files[0]) openFile(e.target.files[0]); e.target.value = ""; });
  function openFile(file) {
    var url = URL.createObjectURL(file);
    if (/^video\//.test(file.type)) {
      setSourceButton("fileIn");
      startVideo(url, false);
    } else if (/^image\//.test(file.type)) {
      setSourceButton("fileIn");
      loadImage(url, file.name).then(useSource).catch(function () { toast("That image could not be opened."); });
    } else toast("Open an image or a video file.");
  }
  var dragDepth = 0;
  stage.addEventListener("dragenter", function (e) { e.preventDefault(); dragDepth++; $("#drop").hidden = false; });
  stage.addEventListener("dragover", function (e) { e.preventDefault(); });
  stage.addEventListener("dragleave", function () { if (--dragDepth <= 0) { dragDepth = 0; $("#drop").hidden = true; } });
  stage.addEventListener("drop", function (e) {
    e.preventDefault(); dragDepth = 0; $("#drop").hidden = true;
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) openFile(f);
  });
  window.addEventListener("paste", function (e) {
    var item = Array.prototype.find.call(e.clipboardData.items || [], function (i) { return /^image\//.test(i.type); });
    if (item) openFile(item.getAsFile());
  });

  // camera and video
  var stream = null, liveRaf = 0;
  $("#camBtn").addEventListener("click", function () {
    if (src && src.kind === "camera") { $("[data-sample]").click(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { camMessage("This browser cannot use the camera here. Open an image instead."); return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then(function (s) {
        stopLive();
        stream = s;
        video.srcObject = s;
        setSourceButton("camBtn");
        return startVideoEl("camera", true);
      })
      .catch(function () { camMessage("Camera access was blocked. Allow it in your browser settings, or open an image instead."); });
  });
  function camMessage(t) { var m = $("#camMsg"); m.textContent = t; m.hidden = false; setTimeout(function () { m.hidden = true; }, 5000); }

  function startVideo(url, mirror) {
    stopLive();
    video.srcObject = null;
    video.src = url;
    return startVideoEl("video", mirror);
  }
  function startVideoEl(kind, mirror) {
    return video.play().then(function () {
      src = { kind: kind, el: video, w: video.videoWidth, h: video.videoHeight, mirror: mirror };
      firstRender = true;
      updateExportHint();
      liveLoop();
      setTimeout(refreshThumbs, 400);
    });
  }
  function stopLive() {
    cancelAnimationFrame(liveRaf);
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (src && src.kind !== "image") { video.pause(); video.removeAttribute("src"); video.srcObject = null; }
    if (recording) finishRecording(false);
  }
  var fpsT = 0, fpsN = 0, fps = 0;
  function liveLoop() {
    liveRaf = requestAnimationFrame(liveLoop);
    if (document.hidden || !live()) return;
    if (!busy) requestRender();
  }

  // ---------------------------------------------------------------- sizing
  function baseWidth() {
    var r = stage.getBoundingClientRect();
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var fitW = Math.min(r.width - 24, (r.height - 24) * src.w / src.h);
    var want = Math.round(Math.max(240, fitW) * dpr);
    return Math.min(src.w, want, live() ? 720 : 1600);
  }
  function workSize() {
    var base = baseWidth();
    var div = settings.mode === "pixel" ? settings.pixel : settings.mode === "ascii" ? 2 : 1;
    var w = Math.max(16, Math.round(base / div));
    return { w: w, h: Math.max(8, Math.round(w * src.h / src.w)), base: base };
  }
  function fitCanvas() {
    if (!out.width) return;
    var r = stage.getBoundingClientRect();
    var pad = innerWidth < 640 ? 24 : 56;
    var s = Math.min((r.width - pad) / out.width, (r.height - pad) / out.height);
    if (innerWidth <= 980) s = (r.width - pad) / out.width; // stacked layout: width decides
    var cw = Math.floor(out.width * s), ch = Math.floor(out.height * s);
    out.style.width = cw + "px"; out.style.height = ch + "px";
  }
  window.addEventListener("resize", function () { fitCanvas(); clearTimeout(fitCanvas.t); fitCanvas.t = setTimeout(requestRender, 200); });

  function drawSource(ctx, w, h) {
    ctx.save();
    if (src.mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(src.el, 0, 0, w, h);
    ctx.restore();
  }

  // ---------------------------------------------------------------- render
  var busy = false, dirty = false, firstRender = true, last = null;
  function requestRender() {
    if (!src) return;
    if (busy) { dirty = true; return; }
    busy = true; dirty = false;
    var sz = workSize();
    grab.width = sz.w; grab.height = sz.h;
    drawSource(grabCtx, sz.w, sz.h);
    var img = grabCtx.getImageData(0, 0, sz.w, sz.h);
    var s = Object.assign({}, settings);
    call({ type: "process", w: sz.w, h: sz.h, buffer: img.data.buffer, settings: s }, [img.data.buffer])
      .then(function (res) {
        last = { res: res, settings: s, base: sz.base };
        draw(out, outCtx, res, s, outScale(res, s));
        // the original, at the same size, for the compare slider
        orig.width = out.width; orig.height = out.height;
        drawSource(origCtx, orig.width, orig.height);
        fitCanvas();
        stats(res, s);
        if (recording) captureFrame();
        if (firstRender) intro();
      })
      .catch(function (err) { toast(err.message); })
      .then(function () { busy = false; if (dirty && !live()) requestRender(); });
  }

  function outScale(res, s) {
    if (s.mode === "pixel") return s.pixel;
    if (s.mode === "ascii") return 2;
    return 1;
  }

  function paletteRgb(s) { return s.palette.map(D.hexToRgb); }

  /** Draw a worker result into any canvas at the given scale. */
  function draw(canvas, ctx, res, s, scale) {
    var W = Math.round(res.w * scale), H = Math.round(res.h * scale);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    var pal = D.makePalette(s.palette);
    if (res.kind === "pixel") {
      tmp.width = res.w; tmp.height = res.h;
      var id = tmpCtx.createImageData(res.w, res.h);
      D.indicesToRgba(res.indices, pal, id.data);
      tmpCtx.putImageData(id, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmp, 0, 0, W, H);
      return;
    }
    var ink = s.palette[0], paper = s.palette[1] || "#ffffff";
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = ink;
    if (res.kind === "halftone") {
      var d = res.ht.dots;
      ctx.beginPath();
      for (var i = 0; i < d.length; i += 3) {
        ctx.moveTo(d[i] * scale + d[i + 2] * scale, d[i + 1] * scale);
        ctx.arc(d[i] * scale, d[i + 1] * scale, d[i + 2] * scale, 0, Math.PI * 2);
      }
      ctx.fill();
      return;
    }
    // ascii: size the font from the row height, then stretch each line to the full width
    var a = res.ascii, lh = H / a.rows;
    ctx.font = "500 " + lh.toFixed(2) + "px 'JetBrains Mono', ui-monospace, monospace";
    ctx.textBaseline = "top";
    var measured = ctx.measureText(a.lines[0]).width || 1;
    ctx.save();
    ctx.scale(W / measured, 1);
    for (var r = 0; r < a.rows; r++) ctx.fillText(a.lines[r], 0, r * lh + lh * 0.05);
    ctx.restore();
  }

  function stats(res, s) {
    var label = s.mode === "pixel" ? algoName(s.algorithm) : s.mode === "halftone" ? "halftone " + s.angle + "°" : "ascii " + res.ascii.cols + " cols";
    var t = res.w + "×" + res.h + " · " + label + " · ";
    if (live()) {
      fpsN++;
      var now = performance.now();
      if (now - fpsT > 1000) { fps = Math.round(fpsN * 1000 / (now - fpsT)); fpsN = 0; fpsT = now; }
      t += fps + " fps";
    } else t += Math.max(1, Math.round(res.ms)) + " ms";
    $("#stats").textContent = t;
  }
  function algoName(a) { var o = $('#algorithm option[value="' + a + '"]'); return o ? o.textContent.toLowerCase() : a; }

  function intro() {
    firstRender = false;
    if (reduce) return;
    frame.classList.remove("intro");
    void frame.offsetWidth;
    frame.classList.add("intro");
    setTimeout(function () { frame.classList.remove("intro"); }, 1200);
  }

  // ---------------------------------------------------------------- presets
  var presetKeys = Object.keys(D.PRESETS);
  var presetBox = $("#presets");
  presetKeys.forEach(function (k) {
    var p = D.PRESETS[k];
    var b = document.createElement("button");
    b.type = "button"; b.className = "preset"; b.setAttribute("role", "radio"); b.setAttribute("data-preset", k);
    b.innerHTML = '<canvas width="120" height="90"></canvas><span>' + p.label + "<i>" +
      p.palette.slice(0, 4).map(function (c) { return '<b style="background:' + c + '"></b>'; }).join("") + "</i></span>";
    b.addEventListener("click", function () { applyPreset(k); });
    presetBox.appendChild(b);
  });

  function applyPreset(k, quiet) {
    var p = D.PRESETS[k];
    settings = Object.assign({}, BASE, TONE, JSON.parse(JSON.stringify(p)), { preset: k });
    syncControls();
    if (!quiet) requestRender();
  }

  // Tiny live previews of every preset on the current source.
  var thumbJob = 0;
  function refreshThumbs() {
    if (!src) return;
    var job = ++thumbJob;
    var W = 120, H = 90;
    var c = document.createElement("canvas"); c.width = W; c.height = H;
    var cx = c.getContext("2d", { willReadFrequently: true });
    // cover-crop the source into 4:3
    var sr = src.w / src.h, tr = W / H, sw = src.w, sh = src.h, sx = 0, sy = 0;
    if (sr > tr) { sw = src.h * tr; sx = (src.w - sw) / 2; } else { sh = src.w / tr; sy = (src.h - sh) / 2; }
    presetKeys.reduce(function (chain, k) {
      return chain.then(function () {
        if (job !== thumbJob) return;
        var p = Object.assign({}, BASE, TONE, D.PRESETS[k]);
        var div = p.mode === "pixel" ? Math.max(1, Math.round(p.pixel / 1.5)) : 1;
        var w = Math.round(W / div), h = Math.round(H / div);
        var p2 = Object.assign({}, p, p.mode === "halftone" ? { cell: 5 } : p.mode === "ascii" ? { cols: 34 } : {});
        cx.save(); cx.clearRect(0, 0, W, H);
        if (src.mirror) { cx.translate(W, 0); cx.scale(-1, 1); }
        cx.drawImage(src.el, sx, sy, sw, sh, 0, 0, W, H); cx.restore();
        var small = document.createElement("canvas"); small.width = w; small.height = h;
        var sctx = small.getContext("2d", { willReadFrequently: true });
        sctx.drawImage(c, 0, 0, w, h);
        var img = sctx.getImageData(0, 0, w, h);
        return call({ type: "process", w: w, h: h, buffer: img.data.buffer, settings: p2 }, [img.data.buffer]).then(function (res) {
          if (job !== thumbJob) return;
          var tc = presetBox.querySelector('[data-preset="' + k + '"] canvas');
          draw(tc, tc.getContext("2d"), res, p2, W / w);
        });
      });
    }, Promise.resolve()).catch(function () {});
  }

  // ---------------------------------------------------------------- controls
  var ids = ["algorithm", "pixel", "color", "cell", "angle", "cols", "ramp", "brightness", "contrast", "gamma", "sharpen", "invert"];
  function fmt(k, v) {
    if (k === "angle") return v + "°";
    if (k === "pixel" || k === "cell" || k === "cols") return String(v);
    return (+v).toFixed(2).replace(/\.?0+$/, "") || "0";
  }
  function setFill(input) {
    var min = +input.min, max = +input.max, v = +input.value;
    input.style.setProperty("--fill", ((v - min) / (max - min)) * 100 + "%");
  }
  ids.forEach(function (k) {
    var el = document.getElementById(k);
    var ev = el.type === "checkbox" || el.tagName === "SELECT" ? "change" : "input";
    el.addEventListener(ev, function () {
      settings[k] = el.type === "checkbox" ? el.checked : el.tagName === "SELECT" ? el.value : +el.value;
      settings.preset = null;
      markPreset();
      var o = document.querySelector('output[data-for="' + k + '"]');
      if (o) o.textContent = fmt(k, el.value);
      if (el.type === "range") setFill(el);
      requestRender();
    });
  });
  $$("#modeSeg button").forEach(function (b) {
    b.addEventListener("click", function () {
      settings.mode = b.getAttribute("data-mode");
      if (settings.mode !== "pixel" && settings.palette.length > 2) settings.palette = [darkest(), lightest()];
      settings.preset = null;
      syncControls();
      requestRender();
    });
  });
  function darkest() { var r = D.makePalette(settings.palette).ramp; return settings.palette[r[0].i]; }
  function lightest() { var r = D.makePalette(settings.palette).ramp; return settings.palette[r[r.length - 1].i]; }

  $("#toneReset").addEventListener("click", function () { Object.assign(settings, TONE); syncControls(); requestRender(); });
  $("#palReverse").addEventListener("click", function () { settings.palette.reverse(); settings.preset = null; syncControls(); requestRender(); });
  $("#palAdd").addEventListener("click", function () {
    if (settings.palette.length >= 16) return;
    // add the midpoint between the two most distant neighbours on the ramp
    var r = D.makePalette(settings.palette).ramp, a = r[0].rgb, b = r[r.length - 1].rgb;
    settings.palette.push(D.rgbToHex([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]));
    settings.preset = null;
    syncControls(); requestRender();
  });

  function markPreset() {
    $$(".preset").forEach(function (b) { b.setAttribute("aria-checked", String(b.getAttribute("data-preset") === settings.preset)); });
  }

  function syncControls() {
    markPreset();
    $$("#modeSeg button").forEach(function (b) { b.setAttribute("aria-checked", String(b.getAttribute("data-mode") === settings.mode)); });
    $$(".fields").forEach(function (f) { f.hidden = f.getAttribute("data-for") !== settings.mode; });
    ids.forEach(function (k) {
      var el = document.getElementById(k), v = settings[k];
      if (el.type === "checkbox") el.checked = !!v;
      else el.value = v;
      var o = document.querySelector('output[data-for="' + k + '"]');
      if (o) o.textContent = fmt(k, el.value);
      if (el.type === "range") setFill(el);
    });
    renderSwatches();
  }

  function renderSwatches() {
    var two = settings.mode !== "pixel";
    $("#palHint").textContent = two ? "First color is the ink, second is the paper." : "Each pixel takes the closest color. Click a swatch to change it.";
    $("#palAdd").disabled = two || settings.palette.length >= 16;
    var ul = $("#swatches");
    ul.innerHTML = "";
    settings.palette.forEach(function (c, i) {
      var li = document.createElement("li");
      li.innerHTML = '<label class="sw" style="background:' + c + '"><input type="color" value="' + c + '" aria-label="Color ' + (i + 1) + '"></label>' +
        (settings.palette.length > 2 ? '<button class="sw-x" type="button" aria-label="Remove color ' + (i + 1) + '">×</button>' : "");
      var input = li.querySelector("input");
      input.addEventListener("input", function () {
        settings.palette[i] = input.value;
        li.querySelector(".sw").style.background = input.value;
        settings.preset = null; markPreset();
        requestRender();
      });
      var x = li.querySelector(".sw-x");
      if (x) x.addEventListener("click", function () { settings.palette.splice(i, 1); settings.preset = null; syncControls(); requestRender(); });
      ul.appendChild(li);
    });
  }

  // ---------------------------------------------------------------- compare
  var split = $("#split"), comparing = false;
  function setCompare(on) {
    comparing = on;
    frame.classList.toggle("comparing", on);
    split.hidden = !on;
    $("#compareBtn").setAttribute("aria-pressed", String(on));
  }
  function setSplit(pct) {
    pct = Math.max(0, Math.min(100, pct));
    frame.style.setProperty("--split", pct + "%");
    split.setAttribute("aria-valuenow", Math.round(pct));
  }
  $("#compareBtn").addEventListener("click", function () { setCompare(!comparing); });
  var dragging = false;
  frame.addEventListener("pointerdown", function (e) {
    if (!comparing) return;
    dragging = true; frame.setPointerCapture(e.pointerId); move(e);
  });
  frame.addEventListener("pointermove", function (e) { if (dragging) move(e); });
  frame.addEventListener("pointerup", function () { dragging = false; });
  function move(e) { var r = out.getBoundingClientRect(); setSplit(((e.clientX - r.left) / r.width) * 100); }
  split.addEventListener("keydown", function (e) {
    var v = +split.getAttribute("aria-valuenow");
    if (e.key === "ArrowLeft") { setSplit(v - 5); e.preventDefault(); }
    if (e.key === "ArrowRight") { setSplit(v + 5); e.preventDefault(); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.target.closest("input, select, textarea") || e.metaKey || e.ctrlKey) return;
    if (e.key === "c" || e.key === "C") setCompare(!comparing);
  });

  // ---------------------------------------------------------------- export
  function download(blob, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function fileBase() { return "dither-" + (settings.preset || settings.mode); }

  $("#pngBtn").addEventListener("click", function () {
    if (!last) return;
    var k = +$("#scale").value;
    var c = document.createElement("canvas");
    draw(c, c.getContext("2d"), last.res, last.settings, outScale(last.res, last.settings) * k);
    c.toBlob(function (b) { download(b, fileBase() + ".png"); toast("PNG saved, " + c.width + "×" + c.height); });
  });

  $("#svgBtn").addEventListener("click", function () {
    if (!last) return;
    var r = last.res, s = last.settings, svg;
    if (r.kind === "pixel") {
      if (r.w * r.h > 900000) { toast("Too many pixels for SVG. Raise the pixel size first."); return; }
      svg = D.svgFromIndices(r.indices, r.w, r.h, D.makePalette(s.palette), s.pixel);
    } else if (r.kind === "halftone") svg = D.svgHalftone(r.ht, r.w, r.h, s.palette[0], s.palette[1]);
    else svg = D.svgAscii(r.ascii, r.w * 2, r.h * 2, s.palette[0], s.palette[1]);
    download(new Blob([svg], { type: "image/svg+xml" }), fileBase() + ".svg");
    toast("SVG saved, " + Math.round(svg.length / 1024) + " KB");
  });

  // GIF: a single frame for still images, 3 seconds when the source is live.
  var recording = null;
  $("#gifBtn").addEventListener("click", function () {
    if (!last) return;
    if (recording) { finishRecording(true); return; }
    if (!live()) { encodeGif([frameIndices()], 0); return; }
    recording = { frames: [], start: performance.now(), size: null };
    $("#gifBtn").classList.add("rec-on");
    $("#gifBtn").textContent = "Stop";
    $("#recBadge").hidden = false;
  });

  /** Palette indices for the current output, small enough for a GIF. */
  function frameIndices() {
    var r = last.res, s = last.settings;
    if (r.kind === "pixel") return { w: r.w, h: r.h, idx: r.indices.slice(), pal: paletteRgb(s) };
    // halftone and ascii: rasterize at up to 640 px wide, then map to the two palette colors
    var scale = Math.min(1, 640 / r.w) * (r.kind === "ascii" ? 2 : 1);
    var c = document.createElement("canvas"), cx = c.getContext("2d", { willReadFrequently: true });
    draw(c, cx, r, s, scale);
    var data = cx.getImageData(0, 0, c.width, c.height).data, pal = paletteRgb(s).slice(0, 2);
    var idx = new Uint8Array(c.width * c.height);
    for (var i = 0, p = 0; i < idx.length; i++, p += 4) {
      var d0 = Math.abs(data[p] - pal[0][0]) + Math.abs(data[p + 1] - pal[0][1]) + Math.abs(data[p + 2] - pal[0][2]);
      var d1 = Math.abs(data[p] - pal[1][0]) + Math.abs(data[p + 1] - pal[1][1]) + Math.abs(data[p + 2] - pal[1][2]);
      idx[i] = d1 < d0 ? 1 : 0;
    }
    return { w: c.width, h: c.height, idx: idx, pal: pal };
  }
  function captureFrame() {
    var f = frameIndices();
    if (!recording.size) recording.size = f.w + "x" + f.h;
    if (recording.size !== f.w + "x" + f.h) return; // skip frames from a resize
    recording.frames.push(f);
    $("#recCount").textContent = recording.frames.length;
    if (performance.now() - recording.start > 3000 || recording.frames.length >= 48) finishRecording(true);
  }
  function finishRecording(save) {
    var rec = recording;
    recording = null;
    $("#gifBtn").classList.remove("rec-on");
    $("#gifBtn").textContent = "GIF";
    $("#recBadge").hidden = true;
    if (save && rec && rec.frames.length) {
      var secs = (performance.now() - rec.start) / 1000;
      encodeGif(rec.frames, Math.round((secs * 1000) / rec.frames.length));
    }
  }
  function encodeGif(frames, delay) {
    toast("Encoding GIF…");
    var f0 = frames[0];
    call({ type: "gif", w: f0.w, h: f0.h, palette: f0.pal, frames: frames.map(function (f) { return f.idx; }), delay: delay || 100 })
      .then(function (m) {
        download(new Blob([m.bytes], { type: "image/gif" }), fileBase() + ".gif");
        toast("GIF saved, " + frames.length + (frames.length > 1 ? " frames, " : " frame, ") + Math.round(m.bytes.length / 1024) + " KB");
      })
      .catch(function (e) { toast("GIF failed: " + e.message); });
  }
  function updateExportHint() {
    $("#expHint").textContent = live()
      ? "GIF records up to 3 seconds of what you see. Press again to stop early."
      : "PNG and SVG keep every pixel sharp. Turn on the camera or open a video to record an animated GIF.";
  }

  // ---------------------------------------------------------------- share link
  function encodeSettings() {
    var keep = {};
    Object.keys(settings).forEach(function (k) { if (settings[k] !== null && settings[k] !== undefined) keep[k] = settings[k]; });
    return btoa(unescape(encodeURIComponent(JSON.stringify(keep)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function decodeSettings(str) {
    try {
      var json = decodeURIComponent(escape(atob(str.replace(/-/g, "+").replace(/_/g, "/"))));
      var o = JSON.parse(json);
      if (!Array.isArray(o.palette) || o.palette.length < 1 || o.palette.length > 16) return null;
      o.palette.forEach(D.hexToRgb); // throws on bad colors
      if (["pixel", "halftone", "ascii"].indexOf(o.mode) < 0) return null;
      if (o.mode === "pixel" && D.ALGORITHMS.indexOf(o.algorithm) < 0) return null;
      return o;
    } catch (e) { return null; }
  }
  $("#shareBtn").addEventListener("click", function () {
    var url = location.origin + location.pathname + "#s=" + encodeSettings();
    history.replaceState(null, "", url);
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
      .then(function () { toast("Link copied. It opens with these exact settings."); })
      .catch(function () { toast("Link is in the address bar."); });
  });

  // ---------------------------------------------------------------- misc
  var toastT;
  function toast(t) {
    var el = $("#toast");
    el.textContent = t; el.classList.add("on");
    clearTimeout(toastT); toastT = setTimeout(function () { el.classList.remove("on"); }, 2600);
  }
  $("#themeBtn").addEventListener("click", function () {
    var d = document.documentElement, next = d.getAttribute("data-theme") === "light" ? "dark" : "light";
    d.setAttribute("data-theme", next);
    try { localStorage.setItem("dither-theme", next); } catch (e) {}
  });
  document.addEventListener("visibilitychange", function () { if (!document.hidden && live()) requestRender(); });

  // ---------------------------------------------------------------- start
  var fromLink = /^#s=/.test(location.hash) && decodeSettings(location.hash.slice(3));
  if (fromLink) { settings = Object.assign({}, BASE, TONE, fromLink); syncControls(); }
  else applyPreset("classic", true);
  loadImage("samples/still-life.webp", "still-life").then(useSource);

  // for tests and the curious
  window.ditherStudio = { settings: function () { return settings; }, applyPreset: applyPreset, last: function () { return last; } };
})();
