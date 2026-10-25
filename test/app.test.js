"use strict";
/*
 * End-to-end tests in a real browser. Chromium's fake camera stands in for a
 * webcam, so the GIF recorder can be tested without hardware.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..", "docs");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".woff2": "font/woff2" };
let server, base, browser;

before(async () => {
  server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(req.url.split("?")[0].split("#")[0]).replace(/\/$/, "/index.html"));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
});
after(async () => { await browser.close(); server.close(); });

async function open(url = base, opts = {}) {
  const ctx = await browser.newContext({ acceptDownloads: true, permissions: ["camera"], ...opts });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.ditherStudio && window.ditherStudio.last());
  return page;
}
const rendered = (page) => page.evaluate(() => window.ditherStudio.last().res);
/** Run an action, then wait until the picture on screen matches the new settings. */
async function waitNext(page, fn) {
  await fn();
  await page.waitForFunction(() => {
    const l = window.ditherStudio.last();
    return l && JSON.stringify(l.settings) === JSON.stringify(window.ditherStudio.settings());
  });
}
async function saved(page, click) {
  const [dl] = await Promise.all([page.waitForEvent("download"), click()]);
  const file = await dl.path();
  return { name: dl.suggestedFilename(), bytes: fs.readFileSync(file) };
}

test("first render: sample image, a pixel result, and no errors", async () => {
  const page = await open();
  const r = await rendered(page);
  assert.equal(r.kind, "pixel");
  assert.ok(r.w > 100 && r.h > 80);
  assert.match(await page.textContent("#stats"), /\d+×\d+ · atkinson · \d+ ms/);
  // the output canvas really has two colors in it
  const colors = await page.$eval("#out", (c) => {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data, set = new Set();
    for (let i = 0; i < d.length; i += 400) set.add(d[i] + "," + d[i + 1] + "," + d[i + 2]);
    return set.size;
  });
  assert.equal(colors, 2);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("every preset renders, and preset thumbnails are drawn", async () => {
  const page = await open();
  const keys = await page.$$eval(".preset", (b) => b.map((x) => x.dataset.preset));
  assert.equal(keys.length, 7);
  for (const k of keys) {
    await waitNext(page, () => page.click(`[data-preset="${k}"]`));
    const r = await rendered(page);
    const mode = await page.evaluate(() => window.ditherStudio.settings().mode);
    assert.equal(r.kind, mode, k);
    assert.equal(await page.$eval(`[data-preset="${k}"]`, (b) => b.getAttribute("aria-checked")), "true");
  }
  const thumbsDrawn = await page.$$eval(".preset canvas", (cs) => cs.every((c) => {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    return d.some((v, i) => i % 4 === 3 && v > 0);
  }));
  assert.ok(thumbsDrawn);
  await page.context().close();
});

test("controls: mode, algorithm, pixel size, palette edits", async () => {
  const page = await open();
  await waitNext(page, () => page.click('#modeSeg [data-mode="halftone"]'));
  assert.equal((await rendered(page)).kind, "halftone");
  assert.equal(await page.isVisible("#cell"), true);
  await waitNext(page, () => page.click('#modeSeg [data-mode="pixel"]'));
  await waitNext(page, () => page.selectOption("#algorithm", "bayer-4"));
  assert.match(await page.textContent("#stats"), /bayer 4×4/);
  const w1 = (await rendered(page)).w;
  await waitNext(page, () => page.$eval("#pixel", (el) => { el.value = 4; el.dispatchEvent(new Event("input")); }));
  assert.ok((await rendered(page)).w < w1);
  await waitNext(page, () => page.click("#palAdd"));
  assert.equal((await page.evaluate(() => window.ditherStudio.settings().palette)).length, 3);
  assert.equal(await page.$$eval("#swatches li", (l) => l.length), 3);
  await page.close();
});

test("compare slider shows the original and responds to the keyboard", async () => {
  const page = await open();
  await page.keyboard.press("c");
  assert.equal(await page.$eval("#split", (el) => el.hidden), false);
  assert.equal(await page.$eval("#orig", (c) => getComputedStyle(c).visibility), "visible");
  await page.focus("#split");
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.$eval("#split", (s) => s.getAttribute("aria-valuenow")), "55");
  await page.click("#compareBtn");
  assert.equal(await page.$eval("#split", (el) => el.hidden), true);
  await page.close();
});

test("exports: PNG at 2x, SVG, and a single-frame GIF", async () => {
  const page = await open();
  const r = await rendered(page);
  const png = await saved(page, () => page.click("#pngBtn"));
  assert.equal(png.name, "dither-classic.png");
  assert.equal(png.bytes.readUInt32BE(16), r.w * 2 * 2); // pixel size 2, scale 2
  const svg = await saved(page, () => page.click("#svgBtn"));
  const text = svg.bytes.toString();
  assert.ok(text.startsWith("<svg") && text.includes('shape-rendering="crispEdges"'));
  const gif = await saved(page, () => page.click("#gifBtn"));
  assert.equal(gif.bytes.toString("latin1", 0, 6), "GIF89a");
  assert.equal(gif.bytes.readUInt16LE(6), r.w);
  await page.close();
});

test("share link restores the same settings", async () => {
  const page = await open();
  await waitNext(page, () => page.click('[data-preset="risograph"]'));
  await waitNext(page, () => page.$eval("#contrast", (el) => { el.value = 0.42; el.dispatchEvent(new Event("input")); }));
  await page.click("#shareBtn");
  const url = page.url();
  assert.match(url, /#s=/);
  const page2 = await open(url);
  const s = await page2.evaluate(() => window.ditherStudio.settings());
  assert.equal(s.contrast, 0.42);
  assert.deepEqual(s.palette, ["#24307a", "#ff4f8b", "#f6efe4"]);
  // a broken link falls back to the default preset instead of failing
  const page3 = await open(base + "#s=not-json");
  assert.equal(await page3.evaluate(() => window.ditherStudio.settings().preset), "classic");
  await page.close(); await page2.close(); await page3.close();
});

test("camera: live frames, then an animated GIF recording", async () => {
  const page = await open();
  await page.click("#camBtn");
  await page.waitForFunction(() => /fps/.test(document.querySelector("#stats").textContent), null, { timeout: 15000 });
  assert.equal(await page.$eval("#camBtn", (b) => b.getAttribute("aria-pressed")), "true");
  const [dl] = await Promise.all([
    page.waitForEvent("download", { timeout: 20000 }),
    page.click("#gifBtn")
  ]);
  const bytes = fs.readFileSync(await dl.path());
  assert.equal(bytes.toString("latin1", 0, 6), "GIF89a");
  assert.ok(bytes.includes(Buffer.from("NETSCAPE2.0")), "animated GIF has a loop block");
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("mobile: no sideways scrolling", async () => {
  const page = await open(base, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.context().close();
});

test("docs copies match src", () => {
  for (const f of ["dither.js", "gif.js"]) {
    assert.equal(fs.readFileSync(path.join(ROOT, f), "utf8"), fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8"), f);
  }
});
