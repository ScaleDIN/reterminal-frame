#!/usr/bin/env python3
"""Builds the frame's web page from the core UI and every plugin's UI, and embeds it in the firmware.

    python tools/build_ui.py            # -> src/web_page.h (+ build/ui/index.html to look at)
    python tools/build_ui.py --serve    # mock device at http://localhost:8765/, rebuilt on every reload

Sources:
    ui/body.html, ui/device.js, ui/device.css      the core page (Overview, Wi-Fi, settings, ...)
    ui/kit/                                        vendored device-web-ui kit
    src/plugins/<key>/ui/body.html                 the plugin's tab: <section class="tab" data-tab=... data-title=...>
    src/plugins/<key>/ui/plugin.js, plugin.css     optional
    ui/mock_data.py                                the simulated device for --serve
The plugin tabs go where ui/body.html says @@PLUGIN_TABS@@; their scripts run after the core's.
"""
import argparse
import importlib.util
import os
import shutil
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI = os.path.join(ROOT, "ui")
PLUGINS = os.path.join(ROOT, "src", "plugins")
STAGE = os.path.join(ROOT, "build", "ui_stage")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import embed_ui  # noqa: E402  (vendored copy from the device-web-ui skill)


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def plugin_dirs():
    if not os.path.isdir(PLUGINS):
        return []
    return [os.path.join(PLUGINS, d, "ui") for d in sorted(os.listdir(PLUGINS))
            if os.path.isfile(os.path.join(PLUGINS, d, "ui", "body.html"))]


def stage():
    """Assemble core + plugins into build/ui_stage/ (the layout embed_ui expects)."""
    os.makedirs(STAGE, exist_ok=True)
    body, js, css = read(os.path.join(UI, "body.html")), [read(os.path.join(UI, "device.js"))], []
    if os.path.isfile(os.path.join(UI, "device.css")):
        css.append(read(os.path.join(UI, "device.css")))
    tabs = []
    for d in plugin_dirs():
        tabs.append(read(os.path.join(d, "body.html")))
        for name, out in (("plugin.js", js), ("plugin.css", css)):
            if os.path.isfile(os.path.join(d, name)):
                out.append(read(os.path.join(d, name)))
    js.append("App.start();")
    if "@@PLUGIN_TABS@@" not in body:
        sys.exit("ui/body.html has no @@PLUGIN_TABS@@ marker")
    body = body.replace("@@PLUGIN_TABS@@", "\n".join(tabs))
    for name, text in (("body.html", body), ("device.js", "\n".join(js)), ("device.css", "\n".join(css))):
        with open(os.path.join(STAGE, name), "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
    kit = os.path.join(STAGE, "kit")
    shutil.rmtree(kit, ignore_errors=True)
    shutil.copytree(os.path.join(UI, "kit"), kit)
    return STAGE


def serve(port):
    spec = importlib.util.spec_from_file_location("mock_data", os.path.join(UI, "mock_data.py"))
    mock = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mock)

    class H(BaseHTTPRequestHandler):
        def send(self, code, ctype, body, headers=()):
            b = body.encode() if isinstance(body, str) else body
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(b)))
            self.send_header("Cache-Control", "no-store")
            for k, v in headers:
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(b)

        def do_GET(self):
            u = urlparse(self.path)
            if u.path == "/":
                html, _ = embed_ui.build_html(stage())
                return self.send(200, "text/html; charset=utf-8", html)
            r = mock.get(u.path, parse_qs(u.query, keep_blank_values=True))
            self.send(*(r or (404, "text/plain", "not found")))

        def do_POST(self):
            n = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(n)
            ctype = self.headers.get("Content-Type", "")
            u = urlparse(self.path)
            if ctype.startswith("multipart/form-data"):  # uploads: the mock gets the raw body
                r = mock.post_raw(u.path, raw, ctype)
            else:
                r = mock.post(u.path, parse_qs(raw.decode(), keep_blank_values=True))
            self.send(*(r or (404, "text/plain", "not found")))

        def log_message(self, *args):
            pass

    print(f"http://localhost:{port}/")
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--serve", action="store_true")
    ap.add_argument("--port", type=int, default=8765)
    a = ap.parse_args()
    if a.serve:
        return serve(a.port)
    html, version = embed_ui.build_html(stage())
    out = os.path.join(ROOT, "src", "web_page.h")
    n = embed_ui.write_header(html, version, out)
    os.makedirs(os.path.join(ROOT, "build", "ui"), exist_ok=True)
    with open(os.path.join(ROOT, "build", "ui", "index.html"), "w", encoding="utf-8", newline="\n") as f:
        f.write(html)
    print(f"src/web_page.h: {len(html)} bytes -> {n} gzipped (kit v{version}, {len(plugin_dirs())} plugin(s))")


if __name__ == "__main__":
    main()
