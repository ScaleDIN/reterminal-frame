# reTerminal E1004 frame

Custom firmware for the Seeed reTerminal E1004 (ESP32-S3, 13.3" Spectra 6 colour ePaper, 1200×1600):
a **core service** (Wi-Fi, web page, SD card, panel, schedule, sleep) with **plugins** that decide what the
screen shows. The first plugin is **Photos**; dashboards and others plug in the same way.

## Using it

1. Flash it (below) and power it on. With no Wi-Fi set up, the screen says to join the hotspot
   `reTerminal-XXXX` and open `http://192.168.4.1/`. Pick your network in **Setup**.
2. Open `http://frame.local/` (or its IP). Tabs: **Overview** (what's shown, next/previous/random, schedule and
   power), **Photos**, **Setup** (Wi-Fi, name, password, firmware update).
3. **Photos:** choose or drop photos. The browser fits them (drag to choose the crop), adjusts colour and
   dithers them to the 6 inks (Floyd–Steinberg against the inks' real colours), shows exactly what the panel will
   show, and uploads the ready frame. Nothing is decoded or dithered on the device.

### Power

- **Awake** (Wi-Fi + page): after power-on, after holding any button 2 s, and while on USB power if
  *Stay awake* is *Auto* (the default). Page activity keeps it awake; then it sleeps.
- **Asleep**: wakes on the schedule (*Change every*) or a short button press, shows the next screen in one
  refresh, sleeps again. No Wi-Fi, so it lasts months on the battery.
- Buttons: right = next, left = previous, refresh = random.

## Building

```
python tools/build_ui.py          # page -> src/web_page.h (commit it)
pio run -t upload
pio device monitor                # logs on the USB serial bridge, 115200
```

Work on the page without hardware: `python tools/build_ui.py --serve` → http://localhost:8765/ (a simulated
frame; uploads land in `build/mock_sd/photos/`, and `python tools/e6_to_png.py <file>.e6` shows one as the
panel will).

Offline / bulk conversion: `python tools/convert.py <photos> <SD card>/photos` (same output as the page).

## Updates and releases

The frame updates itself from this repository's GitHub releases, the same scheme as the Alpaca hub:

- While awake on a Wi-Fi network (never on a quick battery wake) it reads `releases.json` from the latest release
  (`custom_update_repo` in `platformio.ini`), a minute after waking if the last look is a day old, then daily, and
  on **Check now** (Setup › Firmware and updates). The request carries only the firmware version.
- **Online updates:** *Look daily, tell me* (default: a header pill and an **Install** button with the notes),
  *Install by itself* (on USB power or a battery above 3.7 V), or *Off* (sends nothing).
- Installing streams the file into the spare OTA partition and checks its size and SHA-256 against the list
  before switching; anything that doesn't match is thrown away and the running firmware stays. HTTPS is checked
  against the Mozilla root certificates in `certs/x509_crt_bundle.bin`.
- The repository has to be **public** for frames to read its releases.

To release:

1. Bump `FW_VERSION_STR` in `src/version.h` and add a `## <version> (date)` section to `CHANGES.md`.
2. `python tools/release.py` builds and writes `dist/release/` (the `.bin`, `releases.json`, `NOTES.md`).
3. `python tools/release.py --no-build --publish` creates the GitHub release `v<version>` with `gh` (it asks
   first), or upload the `.bin` and `releases.json` by hand to a release marked *latest*.

## Layout

| Path | What |
|---|---|
| `src/main.cpp` | Wake reasons, awake/asleep modes, schedule, buttons |
| `src/core/` | Plugin interface (`plugin.h`), services for plugins (`core.h`), panel + display task, Wi-Fi + web endpoints, power |
| `src/plugins/<key>/` | One plugin: `<key>.cpp` plus `ui/body.html`, `ui/plugin.js`, `ui/plugin.css` (its tab) |
| `ui/` | Core page (`body.html`, `device.js`, `device.css`), vendored device-web-ui kit (v16), `mock_data.py` |
| `src/core/update.cpp`, `src/version.h`, `CHANGES.md` | Online updates, the version, release notes |
| `certs/` | Root certificates for HTTPS (made with the Arduino core's `gen_crt_bundle.py`) |
| `tools/` | `build_ui.py`, `release.py`, `convert.py`, `e6_to_png.py`, `embed_ui.py` (vendored) |

### Writing a plugin

See the header of `src/core/plugin.h`. A plugin draws into the 1200×1600 canvas with the panel colours
(`TFT_WHITE/BLACK/RED/YELLOW/BLUE/GREEN`, Seeed_GFX drawing calls) or pushes a ready 4bpp frame, adds endpoints
under `/p/<key>/`, and a tab. Rebuild the page with `tools/build_ui.py`.

## Not yet checked on hardware

- Everything runs only in the compiler and the simulated page so far.
- USB-power detection reads the SY6974B charger (I2C 0x6B, status register 0x08, BQ25601 layout). If that's
  wrong, *Auto* behaves like *sleep*; use *Always* meanwhile.
- Which physical button is KEY0/1/2 (GPIO 3/4/5 per the schematic).
- `POWER_EN` (GPIO46) appears in the schematic's power-switch circuit; the firmware doesn't drive it, like
  Seeed's examples.
- Ink colours in the dithering palette (`INKS` in `plugin.js` and `convert.py`): tune if the panel differs.
