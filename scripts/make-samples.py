#!/usr/bin/env python3
"""
Renders the three sample images in docs/samples/ from scratch, so the repo
ships no third-party photos. Needs numpy and Pillow:

    python scripts/make-samples.py
"""
import math
import os

import numpy as np
from PIL import Image, ImageFilter

OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "samples")
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(7)


def norm(v):
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


def save(arr, name):
    img = Image.fromarray(np.clip(arr * 255, 0, 255).astype(np.uint8))
    img.save(os.path.join(OUT, name), quality=88, method=6)
    print("wrote", name, img.size)


# ---------------------------------------------------------------- still life
def still_life(W=1200, H=900):
    """A tiny ray tracer: spheres on a table, soft shadows, a warm key light."""
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    aspect = W / H
    px = (xs / W - 0.5) * 2 * aspect * 0.62
    py = -(ys / H - 0.5) * 2 * 0.62
    cam = np.array([0.0, 1.05, -4.2], np.float32)
    d = norm(np.stack([px, py - 0.12, np.ones_like(px)], -1))

    spheres = [  # center, radius, albedo, shine
        ((-1.25, 0.62, 0.3), 0.62, (0.92, 0.9, 0.86), 0.15),
        ((0.35, 0.95, 1.0), 0.95, (0.85, 0.42, 0.28), 0.55),
        ((1.55, 0.38, -0.25), 0.38, (0.2, 0.22, 0.26), 0.9),
        ((-0.25, 0.26, -0.95), 0.26, (0.95, 0.8, 0.35), 0.4),
    ]
    light = norm(np.array([-0.55, 0.8, -0.35], np.float32))

    t_best = np.full((H, W), np.inf, np.float32)
    hit_id = np.full((H, W), -1, np.int32)
    for k, (c, r, _, _) in enumerate(spheres):
        oc = cam - np.array(c, np.float32)
        b = (d * oc).sum(-1)
        cc = (oc * oc).sum() - r * r
        disc = b * b - cc
        t = -b - np.sqrt(np.maximum(disc, 0))
        m = (disc > 0) & (t > 0) & (t < t_best)
        t_best[m] = t[m]
        hit_id[m] = k
    # back wall z = 4.5
    tw = (4.5 - cam[2]) / np.where(np.abs(d[..., 2]) < 1e-6, 1e-6, d[..., 2])
    wall_hit = (tw > 0) & (tw < t_best)
    t_best[wall_hit] = tw[wall_hit]
    hit_id[wall_hit] = 98
    # table plane y = 0
    tp = -cam[1] / np.where(np.abs(d[..., 1]) < 1e-6, -1e-6, d[..., 1])
    plane = (tp > 0) & (tp < t_best)
    t_best[plane] = tp[plane]
    hit_id[plane] = 99

    img = np.zeros((H, W, 3), np.float32)
    # backdrop: warm wall gradient with vignette
    wall = 0.82 - 0.35 * (ys / H)
    img[:] = np.stack([wall * 1.0, wall * 0.93, wall * 0.84], -1)

    P = cam + d * np.where(np.isfinite(t_best), t_best, 0)[..., None]

    def shadow(points, soft=12):
        # soft shadow: jitter the light direction a little and average occlusion
        occ = np.zeros(points.shape[:2], np.float32)
        for s in range(soft):
            j = norm(light + rng.normal(0, 0.06, 3).astype(np.float32))
            blocked = np.zeros(points.shape[:2], bool)
            for c, r, _, _ in spheres:
                oc = points + j * 1e-3 - np.array(c, np.float32)
                b = (oc * j).sum(-1)
                cc = (oc * oc).sum(-1) - r * r
                disc = b * b - cc
                t = -b - np.sqrt(np.maximum(disc, 0))
                blocked |= (disc > 0) & (t > 0)
            occ += blocked
        return 1 - occ / soft

    # wall: lit by the key light, darker near the table corner
    m = hit_id == 98
    if m.any():
        pts = P[m]
        sh = shadow(pts[None, ...], 6)[0]
        k = 0.55 + 0.25 * np.clip(pts[:, 1] / 3, 0, 1) - 0.1 * np.abs(pts[:, 0]) / 4
        img[m] = np.array([0.86, 0.8, 0.72]) * (k * (0.6 + 0.4 * sh))[:, None]
    # table
    m = hit_id == 99
    if m.any():
        pts = P[m]
        sh = shadow(pts[None, ...])[0]
        grain = 0.012 * np.sin(pts[:, 0] * 9 + np.sin(pts[:, 2] * 2) * 2)
        base = np.array([0.55, 0.42, 0.32], np.float32) + grain[:, None]
        fall = np.maximum(0.72, np.exp(-np.maximum(pts[:, 2] - 0.5, 0) * 0.05))[:, None]
        lit = base * (0.32 + 0.68 * sh[:, None] * light[1]) * fall
        img[m] = lit
    for k, (c, r, alb, shine) in enumerate(spheres):
        m = hit_id == k
        if not m.any():
            continue
        pts = P[m]
        n = norm(pts - np.array(c, np.float32))
        diff = np.clip((n * light).sum(-1), 0, 1)
        sh = shadow(pts[None, ...], 8)[0]
        view = norm(cam - pts)
        h = norm(light + view)
        spec = np.clip((n * h).sum(-1), 0, 1) ** (20 + 120 * shine) * shine
        rim = (1 - np.clip((n * view).sum(-1), 0, 1)) ** 3 * 0.25
        bounce = np.clip(-n[:, 1], 0, 1) * 0.18  # warm light bouncing off the table
        col = np.array(alb, np.float32)[None, :] * (0.12 + 0.88 * diff * sh)[:, None]
        col += np.array([0.6, 0.45, 0.32]) * bounce[:, None] * np.array(alb)
        col += spec[:, None] * sh[:, None] + rim[:, None] * 0.6
        img[m] = col
    # gentle vignette and grain
    vx = (xs / W - 0.5) * 2
    vy = (ys / H - 0.5) * 2
    img *= (1 - 0.28 * (vx * vx + vy * vy))[..., None]
    img += rng.normal(0, 0.012, img.shape).astype(np.float32)
    save(np.clip(img, 0, 1) ** (1 / 1.08), "still-life.webp")


# ---------------------------------------------------------------- landscape
def fbm(x, octaves=5, seed=0):
    r = np.random.default_rng(seed)
    out = np.zeros_like(x)
    amp, freq = 1.0, 1.0
    for _ in range(octaves):
        ph = r.uniform(0, 100)
        out += amp * np.sin(x * freq + ph) * np.cos(x * freq * 0.53 + ph * 1.7)
        amp *= 0.5
        freq *= 2.1
    return out


def landscape(W=1200, H=800):
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    u, v = xs / W, ys / H
    sky_top = np.array([0.20, 0.27, 0.45]); sky_bot = np.array([0.98, 0.78, 0.58])
    t = np.clip(v / 0.62, 0, 1)[..., None]
    img = sky_top * (1 - t) + sky_bot * t
    # sun with glow
    sx, sy = 0.68, 0.43
    dist = np.sqrt(((u - sx) * W / H) ** 2 + (v - sy) ** 2)
    img += (np.exp(-dist * 9) * 0.55)[..., None] * np.array([1.0, 0.75, 0.45])
    img[dist < 0.055] = np.array([1.0, 0.95, 0.82])
    # layered ridges, far to near, with aerial perspective
    x = u * 3.2
    layers = [(0.50, 0.07, 1, 0.70), (0.58, 0.09, 2, 0.52), (0.66, 0.10, 3, 0.36), (0.76, 0.12, 4, 0.20), (0.88, 0.10, 5, 0.08)]
    for base, amp, seed, light in layers:
        ridge = base + amp * fbm(x * (1 + seed * 0.35), 4, seed) * 0.55
        m = v > ridge
        haze = np.array([0.98, 0.78, 0.6]) * light + np.array([0.12, 0.13, 0.2]) * (1 - light)
        shade = (1 - np.clip((v - ridge) * 3, 0, 0.5))[..., None]
        img = np.where(m[..., None], haze * shade, img)
    # lake reflection on the lowest band
    lake = v > 0.9
    refl = img[np.clip((2 * 0.9 * H - ys).astype(int), 0, H - 1), xs.astype(int)]
    ripple = 0.06 * np.sin(ys * 1.3 + np.sin(xs * 0.05) * 3)[..., None]
    img = np.where(lake[..., None], refl * 0.75 + ripple + 0.05, img)
    img += rng.normal(0, 0.01, img.shape)
    save(np.clip(img, 0, 1), "mountains.webp")


# ---------------------------------------------------------------- moon
def moon(W=1000, H=1000):
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    cx, cy, R = W * 0.5, H * 0.52, W * 0.36
    dx, dy = (xs - cx) / R, (ys - cy) / R
    r2 = dx * dx + dy * dy
    inside = r2 < 1
    nz = np.sqrt(np.clip(1 - r2, 0, 1))
    n = np.stack([dx, -dy, nz], -1)
    # craters: bumps on the normal and albedo
    alb = np.full((H, W), 0.78, np.float32)
    for _ in range(140):
        ccx, ccy = rng.uniform(-0.95, 0.95, 2)
        if ccx * ccx + ccy * ccy > 0.95:
            continue
        cr = rng.uniform(0.015, 0.11) * (1 if rng.random() > 0.15 else 1.8)
        d = np.sqrt((dx - ccx) ** 2 + (dy - ccy) ** 2) / cr
        bowl = np.exp(-(d ** 4)) * 0.9 - np.exp(-((d - 1) ** 2) * 22) * 0.5
        alb -= 0.06 * np.exp(-(d ** 2) * 1.5)
        n[..., 0] += (dx - ccx) / cr * bowl * 0.06
        n[..., 1] -= (dy - ccy) / cr * bowl * 0.06
    # dark maria
    for _ in range(6):
        mx, my = rng.uniform(-0.6, 0.6, 2)
        mr = rng.uniform(0.18, 0.35)
        alb -= 0.16 * np.exp(-((dx - mx) ** 2 + (dy - my) ** 2) / (mr * mr))
    n = norm(n)
    L = norm(np.array([0.75, 0.25, 0.6], np.float32))
    lit = np.clip((n * L).sum(-1), 0, 1) ** 0.9
    val = np.where(inside, alb * (0.04 + 0.96 * lit), 0)
    img = np.stack([val * 0.98, val * 0.96, val * 0.92], -1)
    # starfield and faint glow
    stars = (rng.random((H, W)) > 0.9985) & ~inside
    img[stars] = rng.uniform(0.4, 1.0, (stars.sum(), 1))
    glow = np.exp(-np.clip(np.sqrt(r2) - 1, 0, None) * 6) * 0.08 * ~inside
    img += glow[..., None] * np.array([0.7, 0.75, 0.9])
    img = Image.fromarray(np.clip(img * 255, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6))
    arr = np.asarray(img).astype(np.float32) / 255 + rng.normal(0, 0.008, (H, W, 3))
    save(np.clip(arr, 0, 1), "moon.webp")


if __name__ == "__main__":
    still_life()
    landscape()
    moon()
