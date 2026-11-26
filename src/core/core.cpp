// Core services: plugin registry, shared SPI bus, settings, the panel and its display task.
#include "core.h"
#include "internal.h"
#include <Preferences.h>
#include <SD.h>
#include <vector>
#include <time.h>
#include <sys/time.h>

namespace core {

// ---------------------------------------------------------------- plugins
static std::vector<Plugin*>& registry() {
  static std::vector<Plugin*> r;  // function-local: safe from static-init order
  return r;
}
void registerPlugin(Plugin* p) { registry().push_back(p); }
size_t pluginCount() { return registry().size(); }
Plugin* plugin(size_t i) { return i < registry().size() ? registry()[i] : nullptr; }
Plugin* findPlugin(const String& key) {
  for (Plugin* p : registry())
    if (key == p->key()) return p;
  return nullptr;
}

// ---------------------------------------------------------------- bus lock, scratch
static SemaphoreHandle_t busMutex() {
  static SemaphoreHandle_t m = xSemaphoreCreateRecursiveMutex();
  return m;
}
BusLock::BusLock() { xSemaphoreTakeRecursive(busMutex(), portMAX_DELAY); }
BusLock::~BusLock() { xSemaphoreGiveRecursive(busMutex()); }

uint8_t* scratch() {
  static uint8_t* buf = (uint8_t*)ps_malloc(FRAME_BYTES);
  return buf;
}

// ---------------------------------------------------------------- settings
static Settings g_settings;
Settings& settings() { return g_settings; }

void loadSettings() {
  Preferences p;
  p.begin("core", true);
  Settings& s = g_settings;
  s.interval_min = p.getUInt("interval", s.interval_min);
  s.awake_min = p.getUInt("awake", s.awake_min);
  s.always_on = p.getUChar("always", s.always_on) % 3;
  s.rotation = p.getUChar("rot", s.rotation) & 3;
  s.source = p.getString("source", s.source);
  s.host = p.getString("host", s.host);
  s.pass = p.getString("pass", s.pass);
  s.updates = p.getUChar("upd", s.updates) % 3;
  p.end();
}

void saveSettings() {
  Preferences p;
  p.begin("core", false);
  const Settings& s = g_settings;
  p.putUInt("interval", s.interval_min);
  p.putUInt("awake", s.awake_min);
  p.putUChar("always", s.always_on);
  p.putUChar("rot", s.rotation);
  p.putString("source", s.source);
  p.putString("host", s.host);
  p.putString("pass", s.pass);
  p.putUChar("upd", s.updates);
  p.end();
}

// ---------------------------------------------------------------- time
bool timeKnown() { return time(nullptr) > 1700000000; }  // the RTC timer keeps it across deep sleep
uint32_t nowUtc() { return timeKnown() ? (uint32_t)time(nullptr) : 0; }
void setUtc(double t) {
  timeval tv{(time_t)t, (suseconds_t)((t - (time_t)t) * 1e6)};
  settimeofday(&tv, nullptr);
}

// ---------------------------------------------------------------- SD
static bool g_sd = false;
bool sdReady() { return g_sd; }

bool mountSd(SPIClass& spi) {
  BusLock l;
  pinMode(PIN_SD_EN, OUTPUT);
  digitalWrite(PIN_SD_EN, HIGH);
  pinMode(PIN_SD_DET, INPUT_PULLUP);
  delay(50);
  if (digitalRead(PIN_SD_DET) == HIGH) {
    LOG.println("[sd] no card");
    return g_sd = false;
  }
  g_sd = SD.begin(PIN_SD_CS, spi, 20000000);
  LOG.printf("[sd] %s\n", g_sd ? "mounted" : "mount failed");
  return g_sd;
}

void unmountSd() {
  BusLock l;
  if (g_sd) SD.end();
  g_sd = false;
  digitalWrite(PIN_SD_EN, LOW);
}

// ---------------------------------------------------------------- panel
static EPaper epaper;
static volatile bool g_busy = false;
static ShowState g_shown;
const ShowState& shown() { return g_shown; }
bool refreshing() { return g_busy; }

SPIClass& beginPanel() {
  BusLock l;
  epaper.begin();
  SPIClass& spi = epaper.getSPIinstance();
  spi.end();
  spi.begin(PIN_SD_SCK, PIN_SD_MISO, PIN_SD_MOSI, -1);
  return spi;
}

static void pushToPanel() {
  uint32_t t0 = millis();
  {
    BusLock l;
    epaper.update();  // full refresh (~15-45 s); puts the panel to sleep afterwards
  }
  g_shown.refresh_ms = millis() - t0;
  LOG.printf("[epd] refresh %lu ms\n", (unsigned long)g_shown.refresh_ms);
}

bool showNow(const String& key, Step step) {
  Plugin* p = findPlugin(key.length() ? key : settings().source);
  if (!p) p = plugin(0);
  if (!p) return false;
  g_busy = true;
  epaper.setRotation(0);
  String what;
  bool ok = p->render(epaper, step, what);
  epaper.setRotation(0);
  if (ok) {
    pushToPanel();
    g_shown.plugin = p->key();
    g_shown.what = what;
    g_shown.at_ms = millis();
    g_shown.at_utc = nowUtc();
    g_shown.ever = true;
  } else {
    LOG.printf("[show] %s has nothing to show\n", p->key());
  }
  g_busy = false;
  return ok;
}

void showMessage(const String& title, const String& body) {
  g_busy = true;
  epaper.setRotation(settings().rotation);  // sprite-level rotation for drawing
  epaper.fillScreen(TFT_WHITE);
  epaper.setTextColor(TFT_BLACK, TFT_WHITE);
  epaper.setTextDatum(TL_DATUM);
  epaper.setFreeFont(&FreeSansBold24pt7b);
  epaper.setTextSize(1);
  int y = epaper.height() / 2 - 120;
  epaper.drawString(title, 60, y);
  epaper.setFreeFont(&FreeSans18pt7b);
  y += 90;
  int start = 0;
  while (start <= (int)body.length()) {  // one line per '\n'
    int nl = body.indexOf('\n', start);
    if (nl < 0) nl = body.length();
    epaper.drawString(body.substring(start, nl), 60, y);
    y += 56;
    start = nl + 1;
  }
  epaper.setRotation(0);
  pushToPanel();
  g_shown.plugin = "";
  g_shown.what = title;
  g_shown.at_ms = millis();
  g_shown.at_utc = nowUtc();
  g_busy = false;
}

// ---------------------------------------------------------------- display task (web mode)
struct Req {
  char key[24];
  Step step;
  bool message;
};
static QueueHandle_t g_queue = nullptr;
static String g_msgTitle, g_msgBody;

static void displayTask(void*) {
  Req r;
  for (;;) {
    if (xQueueReceive(g_queue, &r, portMAX_DELAY) != pdTRUE) continue;
    if (r.message) showMessage(g_msgTitle, g_msgBody);
    else showNow(String(r.key), r.step);
  }
}

void startDisplayTask() {
  if (g_queue) return;
  g_queue = xQueueCreate(4, sizeof(Req));
  xTaskCreatePinnedToCore(displayTask, "display", 8192, nullptr, 1, nullptr, 0);
}

void requestShow(const String& key, Step step) {
  if (!g_queue) {  // no task (quick wake): do it here
    showNow(key, step);
    return;
  }
  Req r{};
  strlcpy(r.key, key.c_str(), sizeof(r.key));
  r.step = step;
  g_busy = true;  // the page sees "refreshing" at once
  xQueueSend(g_queue, &r, 0);
}

void requestMessage(const String& title, const String& body) {
  g_msgTitle = title;
  g_msgBody = body;
  if (!g_queue) return showMessage(title, body);
  Req r{};
  r.message = true;
  g_busy = true;
  xQueueSend(g_queue, &r, 0);
}

}  // namespace core
