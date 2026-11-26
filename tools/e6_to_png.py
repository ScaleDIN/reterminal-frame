#!/usr/bin/env python3
"""Decode a .e6 panel frame (1200 x 1600, 4 bpp) back into a PNG, as the panel would show it (portrait, panel
orientation, approximate ink colours). For checking what the page or convert.py produced.

    python tools/e6_to_png.py photo.e6 [out.png]
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

INK = {0xF: (0x19, 0x1E, 0x21), 0x0: (0xE8, 0xE8, 0xE8), 0xB: (0xEF, 0xDE, 0x44),
       0x6: (0xB2, 0x13, 0x18), 0xD: (0x21, 0x57, 0xBA), 0x2: (0x12, 0x5F, 0x20)}

src = Path(sys.argv[1])
out = Path(sys.argv[2]) if len(sys.argv) > 2 else src.with_suffix(".png")
b = np.fromfile(src, np.uint8)
assert b.size == 960000, f"{b.size} bytes, expected 960000"
codes = np.empty((1600, 1200), np.uint8)
codes[:, 0::2] = (b >> 4).reshape(1600, 600)
codes[:, 1::2] = (b & 15).reshape(1600, 600)
bad = set(np.unique(codes).tolist()) - set(INK)
assert not bad, f"codes that are not inks: {bad}"
lut = np.zeros((16, 3), np.uint8)
for c, rgb in INK.items():
    lut[c] = rgb
Image.fromarray(lut[codes], "RGB").save(out)
print(out)
