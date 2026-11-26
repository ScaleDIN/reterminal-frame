// Battery and deep sleep.
#include "internal.h"
#include "esp_sleep.h"
#include "driver/rtc_io.h"
#include <Wire.h>

namespace core {

float batteryV() {
  pinMode(PIN_BAT_EN, OUTPUT);
  digitalWrite(PIN_BAT_EN, HIGH);
  delay(10);
  uint32_t mv = 0;
  for (int i = 0; i < 8; ++i) mv += analogReadMilliVolts(PIN_BAT_ADC);
  digitalWrite(PIN_BAT_EN, LOW);
  float v = (mv / 8) * 2 / 1000.0f;  // 1:2 divider
  return v > 2.5f ? v : NAN;           // ~0 without a battery
}

int batteryPct(float v) {
  if (isnan(v)) return -1;
  // Rough Li-ion curve under light load.
  static const float V[] = {3.30f, 3.60f, 3.70f, 3.75f, 3.80f, 3.90f, 4.00f, 4.10f, 4.20f};
  static const int P[] = {0, 10, 25, 40, 50, 65, 80, 92, 100};
  if (v <= V[0]) return 0;
  for (int i = 1; i < 9; ++i)
    if (v < V[i]) return P[i - 1] + (int)((v - V[i - 1]) / (V[i] - V[i - 1]) * (P[i] - P[i - 1]));
  return 100;
}

// SY6974B charger on I2C0 (schematic: SDA GPIO19, SCL GPIO20, /INT GPIO47). Register layout as the BQ25601
// family it follows: REG08 status, bit 2 PG_STAT (input power good), bits 4:3 CHRG_STAT.
// Not yet checked on hardware: if the chip doesn't answer, everything reports "unknown" and Auto means "sleep".
static constexpr uint8_t CHG_ADDR = 0x6B;
static int readChargerStatus() {
  static bool begun = false;
  if (!begun) {
    Wire.begin(19, 20, 100000);
    begun = true;
  }
  Wire.beginTransmission(CHG_ADDR);
  Wire.write(0x08);
  if (Wire.endTransmission(false) != 0) return -1;
  if (Wire.requestFrom(CHG_ADDR, (uint8_t)1) != 1) return -1;
  return Wire.read();
}

int usbPower() {
  const int r = readChargerStatus();
  return r < 0 ? -1 : (r & 0x04) ? 1 : 0;
}

int chargeState() {
  const int r = readChargerStatus();
  return r < 0 ? -1 : (r >> 3) & 3;
}

bool stayAwake() {
  const uint8_t m = settings().always_on;
  if (m != 2) return m == 1;
  static int usb = -1;
  static uint32_t at = 0;
  if (!at || millis() - at > 10000) {
    usb = usbPower();
    at = millis() | 1;
  }
  return usb == 1;
}

void waitButtonsReleased() {
  uint32_t t0 = millis();
  while (millis() - t0 < 5000 &&
         (!digitalRead(PIN_KEY_NEXT) || !digitalRead(PIN_KEY_PREV) || !digitalRead(PIN_KEY_RANDOM)))
    delay(20);
}

void sleepFor(uint32_t seconds) {
  unmountSd();
  digitalWrite(PIN_LED, HIGH);
  waitButtonsReleased();

  const uint64_t mask = (1ULL << PIN_KEY_NEXT) | (1ULL << PIN_KEY_PREV) | (1ULL << PIN_KEY_RANDOM);
  for (int p : {PIN_KEY_NEXT, PIN_KEY_PREV, PIN_KEY_RANDOM}) {
    rtc_gpio_pullup_en((gpio_num_t)p);
    rtc_gpio_pulldown_dis((gpio_num_t)p);
  }
  esp_sleep_pd_config(ESP_PD_DOMAIN_RTC_PERIPH, ESP_PD_OPTION_ON);  // keep the pull-ups alive
  esp_sleep_enable_ext1_wakeup(mask, ESP_EXT1_WAKEUP_ANY_LOW);
  if (seconds < 30) seconds = 30;
  esp_sleep_enable_timer_wakeup((uint64_t)seconds * 1000000ULL);
  LOG.printf("[sys] sleeping %lu s\n", (unsigned long)seconds);
  LOG.flush();
  esp_deep_sleep_start();
  for (;;) {}
}

}  // namespace core
