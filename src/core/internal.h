// Core internals shared by main.cpp, core.cpp, power.cpp and web.cpp (not for plugins).
#pragma once
#include "core.h"
#include <SPI.h>

namespace core {

struct ShowState {
  String plugin, what;
  uint32_t at_ms = 0, at_utc = 0, refresh_ms = 0;
  bool ever = false;
};
const ShowState& shown();

void loadSettings();
void setUtc(double t);

SPIClass& beginPanel();
bool mountSd(SPIClass& spi);
void unmountSd();

bool showNow(const String& key, Step step);  // synchronous
void showMessage(const String& title, const String& body);
void startDisplayTask();
void requestMessage(const String& title, const String& body);

// power.cpp
float batteryV();          // NAN if no battery seems connected
int batteryPct(float v);   // rough, -1 if unknown
void waitButtonsReleased();
int usbPower();            // 1 on USB power, 0 not, -1 unknown (charger not answering)
int chargeState();         // 0 not charging, 1 pre-charge, 2 charging, 3 full, -1 unknown
bool stayAwake();          // the "always on" setting, with Auto resolved (USB power checked every 10 s)
[[noreturn]] void sleepFor(uint32_t seconds);

// web.cpp
struct NetState {
  bool sta = false, ap = false;
  String ssid, ip, apName;
};
const NetState& net();
void startNetwork();
void startWeb();
void handleWeb();
uint32_t awakeLeftS();
bool sleepRequested();
void setAwakeUntil(uint32_t ms);
uint32_t nextChangeS();
extern const char* FW_VERSION;
extern const char* FW_BUILD;

}  // namespace core
