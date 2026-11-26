/*
 * reTerminal E1004 frame: core service + plugins (see src/core/plugin.h).
 *
 * Two ways it runs:
 *   Quick wake  (timer, or a short button press): show the next screen, deep-sleep again. No Wi-Fi.
 *   Awake       (power-on/reset, a button held ~2 s, or "always on"): Wi-Fi + web page for awake_min minutes
 *               (page activity extends it), changing screens on schedule and on the buttons, then deep sleep.
 *
 *   Right button = next, left = previous, refresh = random.
 *
 * Logs: UART1 (GPIO43 TX / GPIO44 RX) at 115200 via the board's USB-serial bridge.
 */
#include <Arduino.h>
#include "core/internal.h"
#include "version.h"
#include "esp_sleep.h"
#include "driver/rtc_io.h"

namespace core {
const char* FW_VERSION = FW_VERSION_STR;
const char* FW_BUILD = __DATE__ " " __TIME__;

static uint32_t g_lastChangeMs = 0;
uint32_t nextChangeS() {
  const uint32_t period = settings().interval_min * 60000UL;
  const uint32_t since = millis() - g_lastChangeMs;
  return since >= period ? 0 : (period - since) / 1000;
}
}  // namespace core

using namespace core;

static constexpr uint32_t LONG_PRESS_MS = 2000;
static constexpr float LOW_BATTERY_V = 3.35f;

static bool anyButtonDown() {
  return !digitalRead(PIN_KEY_NEXT) || !digitalRead(PIN_KEY_PREV) || !digitalRead(PIN_KEY_RANDOM);
}

// Button presses while awake: one step per press, on release-to-press edges.
static void pollButtons() {
  static uint8_t last = 0;
  static uint32_t lastMs = 0;
  const uint8_t now = (!digitalRead(PIN_KEY_NEXT) << 0) | (!digitalRead(PIN_KEY_PREV) << 1) | (!digitalRead(PIN_KEY_RANDOM) << 2);
  const uint8_t pressed = now & ~last;
  last = now;
  if (!pressed || millis() - lastMs < 300 || refreshing()) return;
  lastMs = millis();
  touch();
  const Step st = (pressed & 2) ? Step::Prev : (pressed & 4) ? Step::Random : Step::Next;
  requestShow("", st);
  g_lastChangeMs = millis();
}

void setup() {
  LOG.begin(115200, SERIAL_8N1, PIN_LOG_RX, PIN_LOG_TX);
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LOW);  // on while awake
  for (int p : {PIN_KEY_NEXT, PIN_KEY_PREV, PIN_KEY_RANDOM}) {
    rtc_gpio_deinit((gpio_num_t)p);
    pinMode(p, INPUT_PULLUP);
  }
  loadSettings();

  const esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
  const bool coldBoot = cause != ESP_SLEEP_WAKEUP_EXT1 && cause != ESP_SLEEP_WAKEUP_TIMER;
  Step step = Step::Next;
  bool longPress = false;
  if (cause == ESP_SLEEP_WAKEUP_EXT1) {
    const uint64_t s = esp_sleep_get_ext1_wakeup_status();
    if (s & (1ULL << PIN_KEY_PREV)) step = Step::Prev;
    else if (s & (1ULL << PIN_KEY_RANDOM)) step = Step::Random;
    const uint32_t t0 = millis();
    while (anyButtonDown() && millis() - t0 < LONG_PRESS_MS) delay(10);
    longPress = millis() - t0 >= LONG_PRESS_MS;
  }
  LOG.printf("\n[sys] fw %s, wake %d, step %d%s, PSRAM %u kB\n", FW_VERSION, (int)cause, (int)step,
             longPress ? ", long press" : "", (unsigned)(ESP.getPsramSize() / 1024));

  const float vbat = batteryV();
  const bool awake = coldBoot || longPress || stayAwake();
  if (!awake && !isnan(vbat) && vbat < LOW_BATTERY_V) {
    LOG.printf("[bat] %.2f V low: no refresh\n", vbat);
    sleepFor(24 * 3600);
  }

  SPIClass& spi = beginPanel();
  mountSd(spi);
  for (size_t i = 0; i < pluginCount(); ++i) plugin(i)->begin();

  if (!awake) {  // quick wake
    showNow("", step);
    sleepFor(settings().interval_min * 60);
  }

  // Awake: Wi-Fi and the page.
  startNetwork();
  startWeb();
  startDisplayTask();
  setAwakeUntil(millis() + settings().awake_min * 60000UL);

  if (net().ap && net().ssid.isEmpty()) {  // never set up: put the instructions on the screen
    requestMessage("Set up Wi-Fi",
                   "Join the Wi-Fi network " + net().apName + "\nthen open http://" + net().ip + "/\n\n"
                   "Hold a button for 2 s to wake the frame later.");
  } else if (coldBoot || longPress) {
    requestShow("", longPress ? Step::Same : Step::Next);  // long press: keep the picture, just wake up
  } else {
    requestShow("", step);  // always on, woken by timer or button
  }
  g_lastChangeMs = millis();
}

void loop() {
  handleWeb();
  pollButtons();
  updatesLoop();

  if (!refreshing() && nextChangeS() == 0) {
    requestShow("", Step::Next);
    g_lastChangeMs = millis();
  }

  const bool stayUp = stayAwake() && !sleepRequested();
  if (!stayUp && awakeLeftS() == 0 && !refreshing()) {
    LOG.println("[sys] awake time over");
    sleepFor(max<uint32_t>(nextChangeS(), 30));
  }
  delay(2);
}
