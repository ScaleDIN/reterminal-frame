// Wi-Fi and the web page with the core endpoints (status, settings, Wi-Fi, clock, show, firmware update).
// Plugins add their own endpoints under /p/<key>/.
#include "internal.h"
#include <WiFi.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <Update.h>
#include <SD.h>
#include "../webkit.h"
#include "../web_page.h"

namespace core {

static WebServer g_server(80);
WebServer& server() { return g_server; }

static NetState g_net;
const NetState& net() { return g_net; }

static uint32_t g_awakeUntil = 0;
static bool g_sleepNow = false;
bool sleepRequested() { return g_sleepNow; }
void setAwakeUntil(uint32_t ms) { g_awakeUntil = ms; }
uint32_t awakeLeftS() {
  int32_t left = (int32_t)(g_awakeUntil - millis());
  return left > 0 ? left / 1000 : 0;
}
void touch() {
  const uint32_t want = millis() + 5 * 60 * 1000;  // at least 5 more minutes after any page activity
  if ((int32_t)(want - g_awakeUntil) > 0) g_awakeUntil = want;
}

bool authorized() { return webkit::requireAuth(g_server, settings().pass.c_str(), "reTerminal"); }

// ---------------------------------------------------------------- Wi-Fi
static String savedSsid() {
  Preferences p;
  p.begin("net", true);
  String s = p.getString("ssid", "");
  p.end();
  return s;
}

void startNetwork() {
  Preferences p;
  p.begin("net", true);
  String ssid = p.getString("ssid", ""), pass = p.getString("pass", "");
  p.end();

  uint8_t mac[6];
  WiFi.macAddress(mac);
  char ap[24];
  snprintf(ap, sizeof ap, "reTerminal-%02X%02X", mac[4], mac[5]);
  g_net.apName = ap;

  g_net.ssid = ssid;  // the saved network (empty: never set up)
  WiFi.persistent(false);
  WiFi.setHostname(settings().host.c_str());
  if (ssid.length()) {
    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid.c_str(), pass.c_str());
    LOG.printf("[wifi] joining %s", ssid.c_str());
    for (int i = 0; i < 60 && WiFi.status() != WL_CONNECTED; ++i) {
      delay(250);
      LOG.print('.');
    }
    LOG.println();
  }
  if (WiFi.status() == WL_CONNECTED) {
    g_net.sta = true;
    g_net.ip = WiFi.localIP().toString();
    configTime(0, 0, "pool.ntp.org", "time.google.com");
  } else {
    // First setup, or the saved network isn't there: open setup hotspot (scanning needs STA too).
    WiFi.mode(WIFI_AP_STA);
    WiFi.softAP(ap);
    g_net.ap = true;
    g_net.ip = WiFi.softAPIP().toString();
  }
  if (MDNS.begin(settings().host.c_str())) MDNS.addService("http", "tcp", 80);
  LOG.printf("[wifi] %s %s  http://%s.local/\n", g_net.sta ? "joined" : "hotspot", g_net.ip.c_str(),
             settings().host.c_str());
}

// ---------------------------------------------------------------- JSON helpers
static String js(const String& s) { return "\"" + webkit::jsonEscape(s) + "\""; }
static String num(float v, int d = 2) { return isnan(v) ? String("null") : String(v, d); }

static float g_batV = NAN;
static uint32_t g_batAt = 0;
static float cachedBattery() {
  if (!g_batAt || millis() - g_batAt > 30000) {
    g_batV = batteryV();
    g_batAt = millis();
  }
  return g_batV;
}

static void handleStatus() {
  const Settings& s = settings();
  const ShowState& sh = shown();
  const float v = cachedBattery();
  const int pct = batteryPct(v);
  String j;
  j.reserve(1200);
  j += "{\"fw\":" + js(FW_VERSION) + ",\"build\":" + js(FW_BUILD) + ",\"uptime\":" + String(millis() / 1000);
  j += ",\"utc\":" + (timeKnown() ? String(nowUtc()) : String("null"));
  j += ",\"name\":" + js(s.host);
  const bool up = stayAwake();
  const int usb = usbPower(), chg = chargeState();
  static const char* CHG[] = {"not charging", "pre-charge", "charging", "full"};
  j += ",\"always_on\":" + String(up ? "true" : "false");
  j += ",\"awake_left\":" + (up ? String("null") : String(awakeLeftS()));
  j += ",\"usb\":" + (usb < 0 ? String("null") : String(usb ? "true" : "false"));
  j += ",\"charge\":" + (chg < 0 ? String("null") : js(CHG[chg]));
  j += ",\"net\":{\"sta\":" + String(g_net.sta ? "true" : "false") + ",\"ap\":" + String(g_net.ap ? "true" : "false") +
       ",\"ssid\":" + js(g_net.ssid) + ",\"ip\":" + js(g_net.ip) + ",\"ap_name\":" + js(g_net.apName) +
       ",\"rssi\":" + (g_net.sta ? String(WiFi.RSSI()) : String("null")) + "}";
  j += ",\"bat\":{\"v\":" + num(v) + ",\"pct\":" + (pct < 0 ? String("null") : String(pct)) + "}";
  if (sdReady()) {
    // SD sizes are cached: the bus is busy for the whole of a panel refresh, and status must answer at once.
    static uint32_t total = 0, used = 0, at = 0;
    if (!refreshing() && (!at || millis() - at > 20000)) {
      BusLock l;
      total = SD.totalBytes() >> 20;
      used = SD.usedBytes() >> 20;
      at = millis();
    }
    j += ",\"sd\":{\"ok\":true,\"total_mb\":" + String(total) + ",\"used_mb\":" + String(used) + "}";
  } else {
    j += ",\"sd\":{\"ok\":false}";
  }
  j += ",\"shown\":{\"plugin\":" + js(sh.plugin) + ",\"what\":" + js(sh.what) +
       ",\"ago\":" + (sh.at_ms ? String((millis() - sh.at_ms) / 1000) : String("null")) +
       ",\"refresh_ms\":" + (sh.refresh_ms ? String(sh.refresh_ms) : String("null")) + "}";
  j += ",\"refreshing\":" + String(refreshing() ? "true" : "false");
  j += ",\"next_change\":" + String(nextChangeS());
  j += ",\"settings\":{\"interval_min\":" + String(s.interval_min) + ",\"awake_min\":" + String(s.awake_min) +
       ",\"always_on\":" + String(s.always_on) + ",\"rotation\":" + String(s.rotation) +
       ",\"source\":" + js(s.source) + ",\"host\":" + js(s.host) +
       ",\"has_pass\":" + String(s.pass.length() ? "true" : "false") + "}";
  j += ",\"upd\":" + updatesJson();
  j += ",\"plugins\":[";
  for (size_t i = 0; i < pluginCount(); ++i) {
    Plugin* p = plugin(i);
    String extra = p->statusJson();
    j += String(i ? "," : "") + "{\"key\":" + js(p->key()) + ",\"title\":" + js(p->title()) +
         ",\"count\":" + String(p->itemCount()) + (extra.length() ? "," + extra : "") + "}";
  }
  j += "]}";
  g_server.send(200, "application/json", j);
}

static void handleSettings() {
  if (!authorized()) return;
  Settings& s = settings();
  WebServer& w = g_server;
  String msg;
  auto clampArg = [&](const char* k, uint32_t lo, uint32_t hi, uint32_t& dst) {
    if (!w.hasArg(k)) return;
    long v = w.arg(k).toInt();
    dst = (uint32_t)constrain(v, (long)lo, (long)hi);
  };
  clampArg("interval_min", 1, 7 * 24 * 60, s.interval_min);
  clampArg("awake_min", 1, 24 * 60, s.awake_min);
  if (w.hasArg("always_on")) s.always_on = (uint8_t)constrain(w.arg("always_on").toInt(), 0L, 2L);
  if (w.hasArg("rotation")) s.rotation = (uint8_t)(w.arg("rotation").toInt() & 3);
  if (w.hasArg("source") && findPlugin(w.arg("source"))) s.source = w.arg("source");
  if (w.hasArg("host")) {
    String h = w.arg("host");
    h.toLowerCase();
    bool ok = h.length() > 0 && h.length() <= 24;
    for (char c : h) ok = ok && (isalnum((unsigned char)c) || c == '-');
    if (ok) s.host = h;
    else msg = "Name: letters, digits and '-', up to 24. ";
  }
  if (w.hasArg("newpass")) s.pass = w.arg("newpass");  // empty = no login
  if (w.hasArg("updates")) s.updates = (uint8_t)constrain(w.arg("updates").toInt(), 0L, 2L);
  saveSettings();
  w.send(200, "application/json", "{\"ok\":true,\"msg\":" + js(msg + "Saved.") + "}");
}

static void handleShow() {
  if (!authorized()) return;
  touch();
  String st = g_server.arg("step");
  Step step = st == "prev" ? Step::Prev : st == "random" ? Step::Random : st == "same" ? Step::Same : Step::Next;
  if (refreshing()) return g_server.send(409, "application/json", "{\"ok\":false,\"msg\":\"The screen is still refreshing.\"}");
  requestShow(g_server.arg("key"), step);
  g_server.send(200, "application/json", "{\"ok\":true}");
}

static void handleWifi() {
  // Joining from a client of the device's own setup hotspot needs no login (first setup); otherwise it does.
  const bool fromHotspot = g_net.ap && g_server.client().localIP() == WiFi.softAPIP();
  if (!fromHotspot && !authorized()) return;
  String ssid = g_server.arg("ssid"), pass = g_server.arg("pass");
  if (!ssid.length()) return g_server.send(400, "text/plain", "No network name");
  Preferences p;
  p.begin("net", false);
  p.putString("ssid", ssid);
  p.putString("pass", pass);
  p.end();
  webkit::backHome(g_server, "Joining " + ssid + " and restarting. If it can't join, the hotspot " + g_net.apName + " comes back.", 15);
  delay(500);
  ESP.restart();
}

static bool g_updAuth = false;
static void handleUpdateDone() {
  if (!g_updAuth) return;  // 401 already sent
  const bool ok = !Update.hasError();
  g_server.send(ok ? 200 : 500, "text/plain", ok ? "Updated, restarting." : "Update failed.");
  if (ok) {
    delay(500);
    ESP.restart();
  }
}
static void handleUpdateChunk() {
  HTTPUpload& u = g_server.upload();
  if (u.status == UPLOAD_FILE_START) {
    g_updAuth = authorized();
    if (g_updAuth) Update.begin(UPDATE_SIZE_UNKNOWN);
  } else if (!g_updAuth) {
    return;
  } else if (u.status == UPLOAD_FILE_WRITE) {
    Update.write(u.buf, u.currentSize);
  } else if (u.status == UPLOAD_FILE_END) {
    Update.end(true);
  } else if (u.status == UPLOAD_FILE_ABORTED) {
    Update.abort();
  }
}

void startWeb() {
  WebServer& w = g_server;
  w.on("/", HTTP_GET, [] {
    touch();
    webkit::sendPage(g_server, WEB_PAGE_GZ, WEB_PAGE_GZ_LEN);
  });
  w.on("/status.json", HTTP_GET, handleStatus);
  w.on("/settings", HTTP_POST, handleSettings);
  w.on("/show", HTTP_POST, handleShow);
  w.on("/time", HTTP_POST, [] {
    if (!timeKnown()) setUtc(g_server.arg("t").toDouble());
    g_server.send(204);
  });
  w.on("/wifi/scan", HTTP_GET, [] { webkit::wifiScan(g_server, savedSsid()); });
  w.on("/wifi", HTTP_POST, handleWifi);
  w.on("/update", HTTP_POST, handleUpdateDone, handleUpdateChunk);
  w.on("/sleep", HTTP_POST, [] {  // "Sleep now" on the page
    if (!authorized()) return;
    g_server.send(200, "application/json", "{\"ok\":true}");
    g_awakeUntil = millis();
    g_sleepNow = true;  // also when "always on"
  });
  updatesRoutes(w);
  for (size_t i = 0; i < pluginCount(); ++i) plugin(i)->routes(w);
  w.onNotFound([] { g_server.send(404, "text/plain", "Not found"); });
  w.begin();
}

void handleWeb() { g_server.handleClient(); }

}  // namespace core
