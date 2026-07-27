#!/usr/bin/env python3
"""Generate the app icons for desktop packaging from the archived source logo.

design/logo.png is the full wordmark (quill glyph + "gitEssay" text on white),
kept only as the regeneration source — the BUILD consumes the committed
artifacts in backend/assets/, so this script runs only when the logo changes.

App icons use the QUILL GLYPH ONLY: crop it out (content bounding box of the
upper part of the image, above the wordmark), pad to a square, and make the
white background transparent.

White removal is a proper UN-BLEND, not a hard threshold — edge pixels are
mixes of glyph color and white, and simply making bright pixels transparent
leaves a visible white halo on dark backgrounds. Here, per pixel:

  alpha  = (T_BG - L) / (T_BG - T_FG)   clamped to [0, 1]   (L = luminance)
  color  = (pixel - (1 - alpha) * white) / alpha            (decontaminate)

so partially-covered edge pixels keep the glyph's hue at fractional alpha
instead of a whitish tint. T_FG sits just below the lightest solid glyph
tone (the teal ~L=123), so solid areas stay fully opaque.

Output (backend/assets/):
  icon.png      512x512  Linux AppImage / .DirIcon source
  icon-256.png  256x256  hicolor icon theme entry
  icon.ico      16..256  Windows exe + Inno Setup installer
  icon.icns     16..512  macOS .app bundle

Run from the repo root:  backend/.venv/bin/python scripts/make_icons.py
"""
from __future__ import annotations

import os

import numpy as np
from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGO = os.path.join(REPO, "design", "logo.png")
OUT = os.path.join(REPO, "backend", "assets")

# The wordmark text occupies roughly the bottom third; the quill glyph sits
# above it. Only scan the top part for the glyph's bounding box.
GLYPH_SCAN_FRACTION = 0.68
# Padding around the glyph bbox (fraction of the bbox's longest side).
PAD_FRACTION = 0.08
# Luminance at/above which a pixel is surely white background.
T_BG = 245.0
# Luminance at/below which a pixel is surely solid glyph (the teal strokes
# measure ~123; keep a margin so they stay fully opaque).
T_FG = 110.0


def load_glyph() -> Image.Image:
    img = Image.open(LOGO).convert("RGBA")
    w, h = img.size
    scan = np.asarray(img.crop((0, 0, w, int(h * GLYPH_SCAN_FRACTION))), dtype=np.float64)

    rgb = scan[..., :3]
    lum = rgb @ np.array([0.299, 0.587, 0.114])

    # Bbox of non-white content within the scan region.
    cols = np.any(lum < T_BG, axis=0)
    rows = np.any(lum < T_BG, axis=1)
    if not rows.any():
        raise SystemExit("no glyph content found — check design/logo.png")
    y0, y1 = np.argmax(rows), len(rows) - np.argmax(rows[::-1])
    x0, x1 = np.argmax(cols), len(cols) - np.argmax(cols[::-1])

    rgb = rgb[y0:y1, x0:x1]
    lum = lum[y0:y1, x0:x1]

    # Fractional alpha from luminance, then un-blend the white out of the
    # color channels: pixel = a*fg + (1-a)*255  ⇒  fg = (pixel - (1-a)*255)/a
    alpha = np.clip((T_BG - lum) / (T_BG - T_FG), 0.0, 1.0)
    a = alpha[..., None]
    fg = np.where(a > 0, (rgb - (1.0 - a) * 255.0) / np.maximum(a, 1e-6), 0.0)
    fg = np.clip(fg, 0.0, 255.0)

    rgba = np.dstack([fg, alpha * 255.0]).astype(np.uint8)
    glyph = Image.fromarray(rgba, "RGBA")

    # Pad to a square canvas, glyph centered.
    side = int(max(glyph.size) * (1 + 2 * PAD_FRACTION))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(glyph, ((side - glyph.width) // 2, (side - glyph.height) // 2), glyph)
    return canvas


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    icon = load_glyph()

    p512 = os.path.join(OUT, "icon.png")
    icon.resize((512, 512), Image.LANCZOS).save(p512)

    p256 = os.path.join(OUT, "icon-256.png")
    icon.resize((256, 256), Image.LANCZOS).save(p256)

    pico = os.path.join(OUT, "icon.ico")
    icon.save(pico, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    picns = os.path.join(OUT, "icon.icns")
    icon.resize((1024, 1024), Image.LANCZOS).save(picns)

    for p in (p512, p256, pico, picns):
        print(f"{os.path.relpath(p, REPO)}  {os.path.getsize(p) // 1024} KB")


if __name__ == "__main__":
    main()
