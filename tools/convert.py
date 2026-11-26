#!/usr/bin/env python3
"""
Convert photos into ready-to-show frames for the reTerminal E1004
(13.3" Spectra 6 colour ePaper, 1200 x 1600).

Each photo becomes one 960,000-byte .e6 file: the panel's native 4-bit-per-pixel
format, already dithered, so the device only copies it to the screen.

    python tools/convert.py photos/ out/
    python tools/convert.py photos/ E:/photos --landscape       # frame hung sideways
    python tools/convert.py photos/ out/ --fit contain --saturation 1.4

The frame's web page does all of this in the browser (Photos tab); this script is for doing it in bulk
or offline. Copy the .e6 files into /photos on the SD card. A preview PNG of exactly what the
panel will show (using approximate real ink colours) is written next to each one
into a _preview folder, so you can judge results before touching the device.
"""
import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageEnhance, ImageOps

PANEL_W, PANEL_H = 1200, 1600

# (name, raw panel code, colour the ink really looks like)
# The "looks like" colours are what we dither against: Spectra 6 inks are much
# duller than pure RGB, so dithering against pure #FF0000 etc. gives washed-out,
# wrong results. These are typical measured values; tweak them if your panel's
# preview vs. reality differs.
INKS = [
    ("black",  0xF, (0x19, 0x1E, 0x21)),
    ("white",  0x0, (0xE8, 0xE8, 0xE8)),
    ("yellow", 0xB, (0xEF, 0xDE, 0x44)),
    ("red",    0x6, (0xB2, 0x13, 0x18)),
    ("blue",   0xD, (0x21, 0x57, 0xBA)),
    ("green",  0x2, (0x12, 0x5F, 0x20)),
]
CODES = np.array([code for _, code, _ in INKS], dtype=np.uint8)

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff", ".heic"}


def palette_image() -> Image.Image:
    pal = Image.new("P", (1, 1))
    flat = [c for _, _, rgb in INKS for c in rgb]
    pal.putpalette(flat + flat[:3] * (256 - len(INKS)))  # pad with black
    return pal


def compose(img: Image.Image, canvas_w: int, canvas_h: int, fit: str) -> Image.Image:
    if fit == "cover":
        return ImageOps.fit(img, (canvas_w, canvas_h), Image.LANCZOS, centering=(0.5, 0.5))
    # contain: whole photo visible, white bars
    inner = ImageOps.contain(img, (canvas_w, canvas_h), Image.LANCZOS)
    canvas = Image.new("RGB", (canvas_w, canvas_h), (255, 255, 255))
    canvas.paste(inner, ((canvas_w - inner.width) // 2, (canvas_h - inner.height) // 2))
    return canvas


def convert(src: Path, args) -> tuple[bytes, Image.Image]:
    img = Image.open(src)
    img = ImageOps.exif_transpose(img).convert("RGB")

    cw, ch = (PANEL_H, PANEL_W) if args.landscape else (PANEL_W, PANEL_H)
    img = compose(img, cw, ch, args.fit)

    if args.brightness != 1.0:
        img = ImageEnhance.Brightness(img).enhance(args.brightness)
    if args.contrast != 1.0:
        img = ImageEnhance.Contrast(img).enhance(args.contrast)
    if args.saturation != 1.0:
        img = ImageEnhance.Color(img).enhance(args.saturation)

    view = img  # what the viewer sees (before rotating into panel orientation)
    if args.landscape:
        img = img.rotate(90 if not args.flip else -90, expand=True)
    elif args.flip:
        img = img.rotate(180)

    q = img.quantize(palette=palette_image(),
                     dither=Image.Dither.FLOYDSTEINBERG if args.dither else Image.Dither.NONE)
    idx = np.asarray(q, dtype=np.uint8)
    assert idx.shape == (PANEL_H, PANEL_W), idx.shape
    if idx.max() >= len(INKS):
        raise RuntimeError("quantizer produced an index outside the palette")

    codes = CODES[idx]
    packed = (codes[:, 0::2] << 4) | codes[:, 1::2]  # 2 px per byte, left pixel in high nibble
    data = packed.tobytes()
    assert len(data) == PANEL_W * PANEL_H // 2

    # Preview, in viewing orientation, using the real-ink colours.
    lut = np.array([rgb for _, _, rgb in INKS], dtype=np.uint8)
    preview = Image.fromarray(lut[idx], "RGB")
    if args.landscape:
        preview = preview.rotate(-90 if not args.flip else 90, expand=True)
    elif args.flip:
        preview = preview.rotate(180)
    assert preview.size == view.size
    return data, preview


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", type=Path, help="photo file or folder of photos")
    ap.add_argument("out", type=Path, help="output folder (e.g. the SD card's /photos folder)")
    ap.add_argument("--landscape", action="store_true", help="frame is hung sideways (1600 wide x 1200 tall)")
    ap.add_argument("--flip", action="store_true", help="rotate 180 degrees (if it shows upside down)")
    ap.add_argument("--fit", choices=["cover", "contain"], default="cover",
                    help="cover = fill screen, crop edges (default); contain = show whole photo with white bars")
    ap.add_argument("--saturation", type=float, default=1.25, help="colour boost (default 1.25; ePaper is dull)")
    ap.add_argument("--contrast", type=float, default=1.1, help="default 1.1")
    ap.add_argument("--brightness", type=float, default=1.05, help="default 1.05")
    ap.add_argument("--no-dither", dest="dither", action="store_false", help="flat colours, no dithering (posters/graphics)")
    ap.add_argument("--start", type=int, default=1, help="first output number (default 1)")
    args = ap.parse_args()

    if args.src.is_dir():
        files = sorted(p for p in args.src.iterdir() if p.suffix.lower() in IMAGE_EXTS)
    else:
        files = [args.src]
    if not files:
        print(f"No images found in {args.src}", file=sys.stderr)
        return 1

    args.out.mkdir(parents=True, exist_ok=True)
    prev_dir = args.out / "_preview"
    prev_dir.mkdir(exist_ok=True)

    n = args.start
    for f in files:
        try:
            data, preview = convert(f, args)
        except Exception as e:  # keep going on one bad file
            print(f"  skip {f.name}: {e}", file=sys.stderr)
            continue
        name = f"{n:04d}"
        (args.out / f"{name}.e6").write_bytes(data)
        preview.save(prev_dir / f"{name}_{f.stem}.png", optimize=True)
        print(f"  {f.name} -> {name}.e6")
        n += 1
    print(f"Done: {n - args.start} frame(s) in {args.out}  (previews in {prev_dir})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
