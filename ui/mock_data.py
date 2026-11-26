"""Simulated frame for tools/build_ui.py --serve. Uploads land in build/mock_sd/photos/ (real files), so the
packing can be checked with tools/e6_to_png.py."""
import json
import os
import random
import time
from email.parser import BytesParser
from email.policy import default as email_policy

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SD = os.path.join(ROOT, "build", "mock_sd", "photos")
os.makedirs(SD, exist_ok=True)
T0 = time.time()
FRAME = 960000

S = {
    "settings": {"interval_min": 60, "awake_min": 15, "always_on": 2, "rotation": 0, "source": "photos",
                 "host": "frame", "pass": "", },
    "awake_until": time.time() + 15 * 60,
    "refresh_until": 0,
    "shown": {"plugin": "photos", "what": "", "at": None, "refresh_ms": None},
    "cur": "",
    "net": {"sta": True, "ap": False, "ssid": "HomeNet", "ip": "192.168.1.57", "ap_name": "reTerminal-3F2A"},
    "battery": 3.92,   # None = no battery (USB only)
    "sd": True,
    "usb": False,
    "fw": "0.2.0",
    "upd": {"mode": 1, "state": "idle", "msg": "", "checked": None, "progress": None, "available": None, "t": 0, "job": ""},
}
FEED = {"version": "0.3.0", "date": "2026-12-01", "size": 1214000,
        "notes": "- Dashboards plugin: weather and calendar.\n- Photos: shuffle order."}


def upd_tick():
    u = S["upd"]
    if u["state"] == "checking" and time.time() - u["t"] > 2:
        u.update(state="idle", checked=int(time.time()), available=FEED, msg="Version 0.3.0 is available.")
    elif u["state"] == "downloading":
        u["progress"] = min(100, int((time.time() - u["t"]) * 12))
        if u["progress"] >= 100:
            u.update(state="restarting", msg="Installed 0.3.0. Restarting…", t=time.time())
    elif u["state"] == "restarting" and time.time() - u["t"] > 3:
        u.update(state="idle", progress=None, available=None, msg="")
        S["fw"] = "0.3.0"


def names():
    if not S["sd"]:
        return []
    return sorted(f[:-3] for f in os.listdir(SD) if f.endswith(".e6") and os.path.getsize(os.path.join(SD, f)) == FRAME)


def j(obj, code=200):
    return code, "application/json", json.dumps(obj)


def refreshing():
    return time.time() < S["refresh_until"]


def show(name, refresh_s=6):
    S["refresh_until"] = time.time() + refresh_s
    S["cur"] = name
    S["shown"].update(what=name, at=time.time() + refresh_s, refresh_ms=refresh_s * 1000)


def pct(v):
    pts = [(3.30, 0), (3.60, 10), (3.70, 25), (3.75, 40), (3.80, 50), (3.90, 65), (4.00, 80), (4.10, 92), (4.20, 100)]
    if v <= pts[0][0]:
        return 0
    for (v0, p0), (v1, p1) in zip(pts, pts[1:]):
        if v < v1:
            return int(p0 + (v - v0) / (v1 - v0) * (p1 - p0))
    return 100


def status():
    s, n = S["settings"], names()
    up = s["always_on"] == 1 or (s["always_on"] == 2 and S["usb"])
    now = time.time()
    bat = S["battery"]
    last = S["shown"]["at"]
    nxt = max(0, int((last or T0) + s["interval_min"] * 60 - now))
    return {
        "fw": S["fw"], "build": "mock", "uptime": int(now - T0), "utc": None, "name": s["host"],
        "always_on": up, "awake_left": None if up else max(0, int(S["awake_until"] - now)),
        "usb": S["usb"], "charge": ("charging" if bat and bat < 4.15 else "full") if S["usb"] else "not charging",
        "net": dict(S["net"], rssi=-58 if S["net"]["sta"] else None),
        "bat": {"v": bat, "pct": pct(bat) if bat else None},
        "sd": {"ok": True, "total_mb": 15193, "used_mb": 412 + len(n)} if S["sd"] else {"ok": False},
        "shown": {"plugin": S["shown"]["plugin"], "what": S["shown"]["what"],
                  "ago": None if last is None or last > now else int(now - last), "refresh_ms": S["shown"]["refresh_ms"]},
        "refreshing": refreshing(), "next_change": nxt,
        "settings": {k: v for k, v in s.items() if k != "pass"} | {"has_pass": bool(s["pass"])},
        "upd": {k: v for k, v in S["upd"].items() if k not in ("t", "job")} | {"feed": True},
        "plugins": [{"key": "photos", "title": "Photos", "count": len(n), "cur": S["cur"]}],
    }


def get(path, q):
    if path == "/status.json":
        upd_tick()
        return j(status())
    if path == "/p/photos/list.json":
        thumbs = set(f[:-4] for f in os.listdir(SD) if f.endswith(".jpg")) if S["sd"] else set()
        return j({"items": [{"n": n, "t": n in thumbs} for n in names()], "cur": S["cur"], "sd": S["sd"]})
    if path == "/p/photos/thumb":
        p = os.path.join(SD, os.path.basename(q.get("n", [""])[0]) + ".jpg")
        if os.path.isfile(p):
            with open(p, "rb") as f:
                return 200, "image/jpeg", f.read()
        return 404, "text/plain", "no preview"
    if path == "/wifi/scan":
        if "start" in q:
            return j({"running": True})
        return j({"running": False, "current": S["net"]["ssid"], "list": [
            {"ssid": "HomeNet", "rssi": -58, "ch": 6, "open": False},
            {"ssid": "Neighbour 5G", "rssi": -81, "ch": 11, "open": False},
            {"ssid": "Café guest", "rssi": -73, "ch": 1, "open": True}]})
    return None


def post(path, form):
    f = {k: v[0] for k, v in form.items()}
    S["awake_until"] = max(S["awake_until"], time.time() + 300)
    if path == "/settings":
        s = S["settings"]
        for k in ("interval_min", "awake_min", "always_on", "rotation"):
            if k in f:
                s[k] = int(f[k])
        for k in ("source", "host"):
            if k in f:
                s[k] = f[k]
        if "newpass" in f:
            s["pass"] = f["newpass"]
        if "updates" in f:
            S["upd"]["mode"] = int(f["updates"])
        return j({"ok": True, "msg": "Saved."})
    if path == "/show":
        if refreshing():
            return j({"ok": False, "msg": "The screen is still refreshing."}, 409)
        n = names()
        if not n:
            return j({"ok": False, "msg": "No photos to show."}, 404)
        i = n.index(S["cur"]) if S["cur"] in n else -1
        step = f.get("step", "next")
        i = random.randrange(len(n)) if step == "random" else (i - 1) % len(n) if step == "prev" else (i + 1) % len(n)
        show(n[i])
        return j({"ok": True})
    if path == "/p/photos/show":
        if refreshing():
            return j({"ok": False, "msg": "The screen is still refreshing."}, 409)
        if f.get("n") not in names():
            return j({"ok": False, "msg": "No such photo."}, 404)
        show(f["n"])
        return j({"ok": True})
    if path == "/p/photos/delete":
        for ext in (".e6", ".jpg"):
            p = os.path.join(SD, os.path.basename(f.get("n", "")) + ext)
            if os.path.isfile(p):
                os.remove(p)
        return j({"ok": True})
    if path == "/updates/check":
        if S["upd"]["state"] in ("checking", "downloading", "restarting"):
            return j({"ok": False, "msg": "Already busy."}, 409)
        S["upd"].update(state="checking", t=time.time(), job="check")
        return j({"ok": True, "msg": "Looking…"})
    if path == "/updates/install":
        if not S["upd"]["available"]:
            return j({"ok": False, "msg": "No newer version known: check first."}, 409)
        S["upd"].update(state="downloading", progress=0, t=time.time())
        return j({"ok": True, "msg": "Downloading…"})
    if path == "/sleep":
        S["awake_until"] = time.time()
        return j({"ok": True})
    if path == "/time":
        return 204, "text/plain", ""
    if path == "/wifi":
        return 200, "text/html", "Joining and restarting (mock)."
    return None


def post_raw(path, raw, ctype):
    msg = BytesParser(policy=email_policy).parsebytes(b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + raw)
    if path == "/update":
        return 200, "text/plain", "Updated, restarting. (mock)"
    if path != "/p/photos/upload":
        return None
    if not S["sd"]:
        return j({"ok": False, "msg": "No SD card"}, 400)
    saved = 0
    for part in msg.iter_parts():
        fn, data = part.get_filename() or "", part.get_payload(decode=True)
        base = os.path.basename(fn)
        if base.endswith(".e6") and len(data) != FRAME:
            return j({"ok": False, "msg": f"Frame has {len(data)} bytes, expected 960000"}, 400)
        if base.endswith((".e6", ".jpg")):
            with open(os.path.join(SD, base), "wb") as o:
                o.write(data)
            saved += 1
    time.sleep(0.5)  # a little like a real upload over Wi-Fi
    return j({"ok": True, "saved": saved})
