# Changes

Each release has a `## <version>` section; `tools/release.py` copies it into the version list the frame reads,
and the frame's page shows it next to *Install*. Bullets only; keep them short and about what changes for the user.

## 0.2.0 (2026-11-26)
- Online updates: the frame looks for a new firmware once a day while it's awake on Wi-Fi, shows it under
  Setup › Firmware, and installs it on request (or by itself, if set). Size and SHA-256 are checked first.
- Stay awake: *Auto* keeps the frame on Wi-Fi while it's on USB power (read from its charger chip).

## 0.1.0 (2026-11-26)
- First version: core service with plugins, Photos plugin with dithering in the browser, schedule, buttons,
  deep sleep, Wi-Fi setup hotspot, firmware upload.
