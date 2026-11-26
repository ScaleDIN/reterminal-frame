// Firmware updates from the project's releases (the same scheme as the Alpaca hub):
//
//   The list: releases.json on the latest GitHub release (UPDATE_FEED_URL, written by tools/release.py):
//     {"feed":1, "released":"2026-11-26",
//      "firmware":{"board":"reterminal-e1004", "version":"0.2.0", "date":"...", "notes":"- ...",
//                  "file":"reterminal-frame-0.2.0.bin", "url":"https://...", "size":123456, "sha256":"<64 hex>"}}
//
//   When: only while the frame is awake on a Wi-Fi network (never on a quick wake: no Wi-Fi then), a minute after
//   waking if the last look is a day old, then daily, and on "Check now". The request carries nothing but the
//   firmware version (user agent). Updates "Off" sends nothing at all.
//   Install: on "Install", or by itself with "Install automatically" (on USB power, or a battery above 3.7 V).
//   The file is streamed into the spare OTA partition; its size and SHA-256 must match the list, or it is thrown
//   away and the running firmware stays. Only then does the frame restart into it.
//   HTTPS is checked against the Mozilla root certificates in certs/x509_crt_bundle.bin.
#include "internal.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Update.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include "mbedtls/sha256.h"
#include "../webkit.h"
#include "../version.h"

extern const uint8_t ca_bundle_start[] asm("_binary_certs_x509_crt_bundle_bin_start");

#ifndef UPDATE_FEED_URL
#define UPDATE_FEED_URL ""
#endif

namespace core {

static constexpr const char* BOARD = "reterminal-e1004";
static constexpr uint32_t DAY_S = 24 * 3600;
static constexpr uint32_t FIRST_CHECK_MS = 60 * 1000;
static constexpr size_t MAX_FEED = 16 * 1024;
static constexpr size_t MAX_FW = 3 * 1024 * 1024;  // the OTA partition of default_8MB.csv is 3.2 MB

enum class UpdState : uint8_t { Idle, Checking, Downloading, Restarting, Error };
static const char* STATE_NAME[] = {"idle", "checking", "downloading", "restarting", "error"};

struct Available {
  String version, date, notes, url, sha256;
  uint32_t size = 0;
};

static volatile UpdState g_state = UpdState::Idle;
static volatile int g_progress = -1;  // % while downloading
static String g_msg;
static Available g_avail;             // newest listed (may be the running one)
static uint32_t g_checkedUtc = 0;     // last successful look (0 = never / clock unknown)
static uint32_t g_checkedMs = 0;      // same, this boot
static bool g_triedThisBoot = false;

// ---------------------------------------------------------------- versions
static bool parseVersion(const String& v, int out[3]) {
  int n = sscanf(v.c_str(), "%d.%d.%d", &out[0], &out[1], &out[2]);
  if (n < 2) return false;
  if (n == 2) out[2] = 0;
  return true;
}
static bool newer(const String& a, const String& b) {  // a > b
  int x[3], y[3];
  if (!parseVersion(a, x) || !parseVersion(b, y)) return false;
  for (int i = 0; i < 3; ++i)
    if (x[i] != y[i]) return x[i] > y[i];
  return false;
}
bool updateAvailable() { return g_avail.version.length() && newer(g_avail.version, FW_VERSION); }

// ---------------------------------------------------------------- HTTPS
static bool httpGet(HTTPClient& h, WiFiClientSecure& c, const String& url) {
  c.setCACertBundle(ca_bundle_start);
  c.setTimeout(15);
  h.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);  // GitHub sends release files from another host
  h.setUserAgent("reTerminal-frame/" FW_VERSION_STR);  // a literal: tools/release.py finds the version by it
  h.setTimeout(15000);
  if (!url.startsWith("https://") || !h.begin(c, url)) {
    g_msg = "Not an https address";
    return false;
  }
  const int code = h.GET();
  if (code != 200) {
    g_msg = code < 0 ? "No connection (" + HTTPClient::errorToString(code) + ")" : "The server said HTTP " + String(code);
    h.end();
    return false;
  }
  return true;
}

static bool check() {
  WiFiClientSecure c;
  HTTPClient h;
  if (!httpGet(h, c, UPDATE_FEED_URL)) return false;
  const int len = h.getSize();
  if (len > (int)MAX_FEED) {
    h.end();
    g_msg = "The version list is too big";
    return false;
  }
  String body = h.getString();
  h.end();
  JsonDocument doc;
  if (deserializeJson(doc, body) || (doc["feed"] | 0) != 1) {
    g_msg = "Not a version list this firmware reads";
    return false;
  }
  JsonObject fw = doc["firmware"];
  Available a;
  a.version = fw["version"] | "";
  a.date = fw["date"] | "";
  a.notes = String(fw["notes"] | "").substring(0, 2000);
  a.url = fw["url"] | "";
  a.sha256 = fw["sha256"] | "";
  a.size = fw["size"] | 0;
  int v[3];
  bool ok = String(fw["board"] | "") == BOARD && parseVersion(a.version, v) && a.url.startsWith("https://") &&
            a.sha256.length() == 64 && a.size > 0 && a.size <= MAX_FW;
  for (char ch : a.sha256) ok = ok && isxdigit((unsigned char)ch) && !isupper((unsigned char)ch);
  if (!ok) {
    g_msg = "The version list has no usable firmware entry";
    return false;
  }
  g_avail = a;
  g_checkedMs = millis() | 1;
  g_checkedUtc = nowUtc();
  Preferences p;
  p.begin("upd", false);
  p.putUInt("checked", g_checkedUtc);
  p.end();
  g_msg = updateAvailable() ? "Version " + a.version + " is available." : "This is the newest version.";
  LOG.printf("[upd] list: %s (running %s)\n", a.version.c_str(), FW_VERSION);
  return true;
}

static bool install() {
  const Available a = g_avail;
  WiFiClientSecure c;
  HTTPClient h;
  if (!httpGet(h, c, a.url)) return false;
  const int len = h.getSize();
  if (len >= 0 && (uint32_t)len != a.size) {
    h.end();
    g_msg = "The file's size doesn't match the list: not installed";
    return false;
  }
  if (!Update.begin(a.size)) {
    h.end();
    g_msg = "Can't start the update (" + String(Update.errorString()) + ")";
    return false;
  }
  mbedtls_sha256_context sha;
  mbedtls_sha256_init(&sha);
  mbedtls_sha256_starts_ret(&sha, 0);
  WiFiClient* s = h.getStreamPtr();
  static uint8_t buf[4096];
  uint32_t got = 0, lastData = millis();
  bool ok = true;
  while (got < a.size) {
    touch();  // stay awake while downloading
    const size_t n = s->available() ? s->readBytes(buf, std::min<size_t>(sizeof buf, a.size - got)) : 0;
    if (!n) {
      if (!s->connected() || millis() - lastData > 20000) { ok = false; g_msg = "The download stopped"; break; }
      delay(5);
      continue;
    }
    lastData = millis();
    mbedtls_sha256_update_ret(&sha, buf, n);
    if (Update.write(buf, n) != n) { ok = false; g_msg = "Writing failed (" + String(Update.errorString()) + ")"; break; }
    got += n;
    g_progress = (int)((uint64_t)got * 100 / a.size);
  }
  h.end();
  uint8_t digest[32];
  mbedtls_sha256_finish_ret(&sha, digest);
  mbedtls_sha256_free(&sha);
  if (ok) {
    char hex[65];
    for (int i = 0; i < 32; ++i) sprintf(hex + 2 * i, "%02x", digest[i]);
    if (a.sha256 != hex) { ok = false; g_msg = "The checksum doesn't match the list: not installed"; }
  }
  if (!ok) {
    Update.abort();
    return false;
  }
  if (!Update.end(true)) {
    g_msg = "Installing failed (" + String(Update.errorString()) + ")";
    return false;
  }
  g_msg = "Installed " + a.version + ". Restarting…";
  LOG.printf("[upd] installed %s, restarting\n", a.version.c_str());
  return true;
}

// ---------------------------------------------------------------- worker task (TLS blocks for seconds)
enum class Job : uint8_t { Check, Install, CheckThenMaybeInstall };

static void worker(void* arg) {
  const Job job = (Job)(uintptr_t)arg;
  bool ok = true;
  if (job != Job::Install) {
    g_state = UpdState::Checking;
    ok = check();
  }
  const bool autoInstall = job == Job::CheckThenMaybeInstall && settings().updates == 2 && updateAvailable() &&
                           (usbPower() == 1 || batteryV() > 3.7f);
  if (ok && (job == Job::Install || autoInstall)) {
    g_state = UpdState::Downloading;
    g_progress = 0;
    ok = install();
    if (ok) {
      g_state = UpdState::Restarting;
      while (refreshing()) delay(200);  // never restart in the middle of a panel refresh
      delay(1500);                      // let the page see "restarting"
      ESP.restart();
    }
  }
  g_progress = -1;
  g_state = ok ? UpdState::Idle : UpdState::Error;
  vTaskDelete(nullptr);
}

static bool startJob(Job j) {
  if (g_state == UpdState::Checking || g_state == UpdState::Downloading || g_state == UpdState::Restarting) return false;
  g_triedThisBoot = true;
  return xTaskCreatePinnedToCore(worker, "update", 12288, (void*)(uintptr_t)j, 1, nullptr, 0) == pdPASS;
}

// ---------------------------------------------------------------- schedule, endpoints, status
void updatesLoop() {
  if (!settings().updates || !strlen(UPDATE_FEED_URL) || !net().sta) return;
  if (millis() < FIRST_CHECK_MS) return;
  bool due;
  if (g_checkedMs) {
    due = millis() - g_checkedMs > DAY_S * 1000UL;
  } else if (!g_triedThisBoot) {
    Preferences p;
    p.begin("upd", true);
    const uint32_t last = p.getUInt("checked", 0);
    p.end();
    due = !timeKnown() || !last || nowUtc() - last > DAY_S;
  } else {
    due = false;  // a failed try waits for "Check now" or the next wake
  }
  if (due) startJob(Job::CheckThenMaybeInstall);
}

String updatesJson() {
  String j = "{\"mode\":" + String(settings().updates) + ",\"feed\":" + String(strlen(UPDATE_FEED_URL) ? "true" : "false") +
             ",\"state\":\"" + STATE_NAME[(int)g_state] + "\",\"msg\":\"" + webkit::jsonEscape(g_msg) + "\"";
  Preferences p;
  p.begin("upd", true);
  const uint32_t last = g_checkedUtc ? g_checkedUtc : p.getUInt("checked", 0);
  p.end();
  j += ",\"checked\":" + (last ? String(last) : String("null"));
  j += ",\"progress\":" + (g_progress < 0 ? String("null") : String(g_progress));
  if (updateAvailable()) {
    j += ",\"available\":{\"version\":\"" + webkit::jsonEscape(g_avail.version) + "\",\"date\":\"" + webkit::jsonEscape(g_avail.date) +
         "\",\"size\":" + String(g_avail.size) + ",\"notes\":\"" + webkit::jsonEscape(g_avail.notes) + "\"}";
  } else {
    j += ",\"available\":null";
  }
  return j + "}";
}

void updatesRoutes(WebServer& s) {
  s.on("/updates/check", HTTP_POST, [&s] {
    if (!authorized()) return;
    touch();
    if (!strlen(UPDATE_FEED_URL)) return s.send(400, "application/json", "{\"ok\":false,\"msg\":\"This build has no update address.\"}");
    if (!net().sta) return s.send(409, "application/json", "{\"ok\":false,\"msg\":\"Needs a Wi-Fi network with internet (not the hotspot).\"}");
    if (!startJob(Job::Check)) return s.send(409, "application/json", "{\"ok\":false,\"msg\":\"Already busy.\"}");
    s.send(200, "application/json", "{\"ok\":true,\"msg\":\"Looking…\"}");
  });
  s.on("/updates/install", HTTP_POST, [&s] {
    if (!authorized()) return;
    touch();
    if (!updateAvailable()) return s.send(409, "application/json", "{\"ok\":false,\"msg\":\"No newer version known: check first.\"}");
    if (!startJob(Job::Install)) return s.send(409, "application/json", "{\"ok\":false,\"msg\":\"Already busy.\"}");
    s.send(200, "application/json", "{\"ok\":true,\"msg\":\"Downloading…\"}");
  });
}

}  // namespace core
