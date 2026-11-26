// Seeed_GFX board selection (picked up via __has_include("driver.h") in the Arduino IDE;
// PlatformIO also passes -DBOARD_SCREEN_COMBO=523 in platformio.ini).
#pragma once
#ifndef BOARD_SCREEN_COMBO
#define BOARD_SCREEN_COMBO 523  // reTerminal E1004 (T133A01, 1200x1600, 6-colour)
#endif
