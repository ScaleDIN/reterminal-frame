// Plugin interface: a plugin is a content source (photos, a dashboard, a calendar, ...).
//
// The core owns Wi-Fi, the web page, the SD card, the panel, the schedule and sleep. A plugin only answers
// "what should the screen show now?" by drawing into the canvas, plus optional web endpoints and a tab on the page.
//
// To add one:
//   1. src/plugins/<key>/<key>.cpp: a class deriving from Plugin, then REGISTER_PLUGIN(ClassName).
//   2. src/plugins/<key>/ui/body.html: <section class="tab" data-tab="<key>" data-title="Title"> ... </section>
//      src/plugins/<key>/ui/plugin.js:  App.plugin({key:'<key>', init(app){...}, status(st){...}})
//   3. python tools/build_ui.py  (rebuilds src/web_page.h with every plugin's tab)
#pragma once
#include <Arduino.h>
#include <WebServer.h>
#include "TFT_eSPI.h"

namespace core {
enum class Step : uint8_t { Next, Prev, Random, Same };
}

class Plugin {
 public:
  virtual ~Plugin() = default;
  virtual const char* key() const = 0;    // short id, also the URL prefix /p/<key>/ and the tab id
  virtual const char* title() const = 0;  // shown on the page

  // Called once after the SD card and settings are ready (also on quick timer wakes: keep it cheap).
  virtual void begin() {}

  // Web endpoints, called only when the web server runs. Use paths under /p/<key>/.
  // Anything that changes state must check core::authorized() first.
  virtual void routes(WebServer&) {}

  // Number of items it can show (photos), or -1 when it isn't a list (a dashboard).
  virtual int itemCount() { return -1; }

  // Draw the next screen into `canvas` (1200 x 1600, panel colour codes: TFT_WHITE, TFT_BLACK, TFT_RED,
  // TFT_YELLOW, TFT_BLUE, TFT_GREEN), or push a ready 4bpp frame with canvas.pushImage(0, 0, 1200, 1600, buf).
  // The panel has no hardware rotation: honour core::rotation() yourself (0 = portrait, 1 = landscape,
  // 2 = portrait flipped, 3 = landscape flipped). Hold core::BusLock while reading the SD card.
  // `what` = short description of what is shown (for the page). Return false if there is nothing to show.
  virtual bool render(TFT_eSprite& canvas, core::Step step, String& what) = 0;

  // Extra JSON fields for /status.json (inside this plugin's object), e.g. "\"count\":12". Without braces.
  virtual String statusJson() { return String(); }
};

namespace core {
void registerPlugin(Plugin* p);
size_t pluginCount();
Plugin* plugin(size_t i);
Plugin* findPlugin(const String& key);
}  // namespace core

#define REGISTER_PLUGIN(cls)                         \
  static cls _plugin_instance_##cls;                 \
  static const bool _plugin_registered_##cls =       \
      (core::registerPlugin(&_plugin_instance_##cls), true);
