// Services the core gives plugins (and main.cpp).
#pragma once
#include <Arduino.h>
#include <WebServer.h>
#include "plugin.h"

#define LOG Serial1

namespace core {

constexpr int W = 1200, H = 1600;
constexpr size_t FRAME_BYTES = (size_t)W * H / 2;  // 4 bits per pixel

// Pins (Seeed wiki + Seeed_GFX Setup523).
constexpr int PIN_SD_SCK = 7, PIN_SD_MISO = 8, PIN_SD_MOSI = 9;  // shared with the panel
constexpr int PIN_SD_CS = 14, PIN_SD_EN = 16, PIN_SD_DET = 15;
constexpr int PIN_KEY_NEXT = 3, PIN_KEY_PREV = 4, PIN_KEY_RANDOM = 5;  // right, left, refresh (verify on hardware)
constexpr int PIN_BAT_ADC = 1, PIN_BAT_EN = 21;
constexpr int PIN_LED = 48;  // active-low
constexpr int PIN_LOG_RX = 44, PIN_LOG_TX = 43;

// The SD card and the panel share one SPI bus. Hold this (RAII) around SD access or panel transfers.
// Recursive: nesting in one task is fine.
struct BusLock {
  BusLock();
  ~BusLock();
};

// A 960 KB PSRAM scratch buffer (allocated once). Only for use inside Plugin::render().
uint8_t* scratch();

bool sdReady();

// Settings (NVS). Changing them goes through the page's /settings.
struct Settings {
  uint32_t interval_min = 60;  // change the picture every ...
  uint32_t awake_min = 15;     // stay on Wi-Fi this long after power-on or a long button press
  uint8_t always_on = 2;       // 0 sleep on schedule, 1 never sleep, 2 never sleep while on USB power
  uint8_t rotation = 0;        // 0 portrait, 1 landscape, 2 portrait flipped, 3 landscape flipped
  String source = "photos";    // plugin key the schedule shows
  String host = "frame";       // mDNS name: http://frame.local/
  String pass;                 // admin password for changes; empty = open
  uint8_t updates = 1;         // 0 off (sends nothing), 1 look daily and tell, 2 also install by itself
};
Settings& settings();
void saveSettings();
inline uint8_t rotation() { return settings().rotation; }

// Web helpers for plugin routes.
WebServer& server();
bool authorized();       // sends the 401 itself when it returns false
void touch();            // web activity: keeps the device awake a little longer
bool timeKnown();
uint32_t nowUtc();

// Ask for a new screen (runs in the display task; returns at once). key empty = the scheduled source.
void requestShow(const String& key, Step step);
bool refreshing();

}  // namespace core
