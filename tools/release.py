#!/usr/bin/env python3
"""Prepare a release: the firmware file and the version list (releases.json) the frame's update check reads.

    python tools/release.py                 # build (pio run), then write dist/release/
    python tools/release.py --no-build      # use the firmware.bin already built
    python tools/release.py --publish       # also create the GitHub release v<version> with gh (asks first)

Reads the version from src/version.h and its notes from CHANGES.md ("## <version>" section; required). Writes
dist/release/:
    reterminal-frame-<version>.bin   the firmware (what /update and the online update install)
    releases.json                    {"feed":1, "released":..., "firmware":{"board","version","date","notes","file",
                                      "url","size","sha256"}}
    NOTES.md                         the release page's text

The frame reads https://github.com/<repo>/releases/latest/download/releases.json, so every release carries its own
releases.json, and the newest release is the one marked "latest". <repo> is custom_update_repo in platformio.ini;
the repository must be public. Publishing is a separate, explicit step (--publish, or upload the three files by
hand to a release named v<version>).
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = "reterminal_e1004"
BOARD = "reterminal-e1004"
FEED = 1


def read(p):
    with open(os.path.join(ROOT, p), encoding="utf-8") as f:
        return f.read()


def version():
    m = re.search(r'#define\s+FW_VERSION_STR\s+"(\d+\.\d+\.\d+)"', read("src/version.h"))
    if not m:
        sys.exit("src/version.h: no FW_VERSION_STR \"x.y.z\"")
    return m.group(1)


def repo():
    m = re.search(r"^custom_update_repo\s*=\s*(\S+)", read("platformio.ini"), re.M)
    if not m or not re.fullmatch(r"[\w.-]+/[\w.-]+", m.group(1)):
        sys.exit("platformio.ini: no custom_update_repo = owner/name")
    return m.group(1)


def notes(v):
    """(date, bullets) of the '## <v> (date)' section of CHANGES.md."""
    text = read("CHANGES.md")
    m = re.search(r"^## +" + re.escape(v) + r"\b([^\n]*)\n(.*?)(?=^## |\Z)", text, re.M | re.S)
    if not m:
        sys.exit(f"CHANGES.md has no '## {v}' section: write what changed first")
    d = re.search(r"\d{4}-\d{2}-\d{2}", m.group(1))
    lines = []
    for ln in m.group(2).strip().splitlines():  # a bullet wrapped onto indented lines becomes one line
        if lines and ln[:1] in (" ", "\t") and ln.strip():
            lines[-1] = lines[-1].rstrip() + " " + ln.strip()
        elif ln.strip():
            lines.append(ln.rstrip())
    return (d.group(0) if d else datetime.date.today().isoformat()), "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-build", action="store_true")
    ap.add_argument("--publish", action="store_true")
    a = ap.parse_args()

    v, r = version(), repo()
    date, text = notes(v)
    if not a.no_build:
        pio = shutil.which("pio") or os.path.expanduser(r"~/.platformio/penv/Scripts/pio.exe")
        subprocess.run([sys.executable, os.path.join(ROOT, "tools", "build_ui.py")], check=True, cwd=ROOT)
        subprocess.run([pio, "run", "-e", ENV], check=True, cwd=ROOT)
    src = os.path.join(ROOT, ".pio", "build", ENV, "firmware.bin")
    if not os.path.isfile(src):
        sys.exit(f"{src} not found: build first")
    data = open(src, "rb").read()
    if f"reTerminal-frame/{v}".encode() not in data:
        sys.exit(f"firmware.bin isn't version {v} (rebuild after changing src/version.h)")

    out = os.path.join(ROOT, "dist", "release")
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    name = f"reterminal-frame-{v}.bin"
    with open(os.path.join(out, name), "wb") as f:
        f.write(data)
    feed = {"feed": FEED, "released": date, "firmware": {
        "board": BOARD, "version": v, "date": date, "notes": text, "file": name,
        "url": f"https://github.com/{r}/releases/download/v{v}/{name}",
        "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}}
    with open(os.path.join(out, "releases.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(feed, f, indent=1, ensure_ascii=False)
        f.write("\n")
    with open(os.path.join(out, "NOTES.md"), "w", encoding="utf-8", newline="\n") as f:
        f.write(f"reTerminal E1004 frame firmware {v}.\n\n{text}\n\n"
                f"Frames with online updates switched on find it by themselves (Setup › Firmware). To install by hand: "
                f"Setup › Firmware › upload `{name}`, or `pio run -t upload` from the source.\n")
    print(f"dist/release/: {name} ({len(data)} bytes, sha256 {feed['firmware']['sha256'][:12]}...), releases.json, NOTES.md")

    if a.publish:
        tag = f"v{v}"
        if input(f"Create the public GitHub release {tag} on {r} with these files? [y/N] ").strip().lower() != "y":
            return print("Not published.")
        subprocess.run(["gh", "release", "create", tag, "--repo", r, "--title", f"Frame firmware {v}",
                        "--notes-file", os.path.join(out, "NOTES.md"), "--latest",
                        os.path.join(out, name), os.path.join(out, "releases.json")], check=True, cwd=ROOT)


if __name__ == "__main__":
    main()
