/* dither-studio worker: heavy pixel work happens here so the UI never stutters. */
/* global DitherCore, GifEncoder */
importScripts("dither.js", "gif.js");

self.onmessage = function (e) {
  var m = e.data;
  try {
    if (m.type === "process") {
      var t0 = performance.now();
      var data = new Uint8ClampedArray(m.buffer);
      var res = DitherCore.process(data, m.w, m.h, m.settings);
      res.ms = performance.now() - t0;
      res.id = m.id;
      res.tag = m.tag;
      var transfer = res.indices ? [res.indices.buffer] : [];
      self.postMessage(res, transfer);
    } else if (m.type === "gif") {
      var bytes = GifEncoder.encode({ width: m.w, height: m.h, palette: m.palette, frames: m.frames, delay: m.delay });
      self.postMessage({ id: m.id, type: "gif", bytes: bytes }, [bytes.buffer]);
    }
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err && err.message || err) });
  }
};
