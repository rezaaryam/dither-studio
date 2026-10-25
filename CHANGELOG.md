# Changelog

## 1.0.0 (2026-10-26)

- First release.
- Eleven algorithms: Floyd-Steinberg, Atkinson, Jarvis-Judice-Ninke, Stucki, Burkes, Sierra Lite, Bayer 2/4/8, noise, threshold. Serpentine scanning for error diffusion.
- Three modes: pixels (any palette of 2 to 16 colors, brightness ramp or full color), halftone (rotated dot screen), ASCII (four character sets).
- Seven presets with live thumbnails of the current image.
- Sources: sample images, any image or video file (open, drop, or paste), and the camera.
- Before and after slider, tone controls (brightness, contrast, gamma, sharpen, invert), shareable settings links.
- Exports: PNG at 1x, 2x, 4x; SVG (merged pixel runs, circles, or text); GIF written by a built-in encoder, including 3-second recordings from the camera or a video.
- All processing in a Web Worker. 36 tests, including a GIF round trip and camera recording in a real browser.
