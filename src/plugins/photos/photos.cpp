// Photos plugin: shows ready-made frames from /photos on the SD card.
//
// The page dithers each photo in the browser and uploads two files per photo:
//   /photos/<name>.e6   960,000 bytes, the panel's 4bpp format (also what tools/convert.py writes)
//   /photos/<name>.jpg  small preview for the page's gallery (optional)
//
// Endpoints (under /p/photos/):
//   GET  list.json            {"items":[{"n":name,"t":has_thumb}],"cur":name}
//   GET  thumb?n=name         the preview JPEG
//   POST upload               multipart: files <name>.e6 and <name>.jpg      (login)
//   POST delete  n=name                                                       (login)
//   POST show    n=name       show this one now                               (login)
#include "../../core/core.h"
#include "../../webkit.h"
#include <SD.h>
#include <Preferences.h>
#include <vector>
#include <algorithm>

namespace {

constexpr const char* DIR = "/photos";

String safeName(String n) {
  int dot = n.lastIndexOf('.');
  if (dot > 0) n = n.substring(0, dot);
  String o;
  for (char c : n) {
    if (isalnum((unsigned char)c) || c == '-' || c == '_') o += c;
    else if (c == ' ' || c == '.') o += '_';
    if (o.length() >= 40) break;
  }
  return o;
}

class Photos : public Plugin {
 public:
  const char* key() const override { return "photos"; }
  const char* title() const override { return "Photos"; }

  void begin() override {
    Preferences p;
    p.begin("photos", true);
    cur_ = p.getString("cur", "");
    p.end();
    rescan();
  }

  int itemCount() override { return (int)names_.size(); }

  String statusJson() override {
    return "\"cur\":\"" + cur_ + "\"";  // names are already safe (safeName)
  }

  bool render(TFT_eSprite& canvas, core::Step step, String& what) override {
    if (names_.empty()) rescan();
    if (names_.empty()) return false;
    const int n = (int)names_.size();
    int idx = indexOf(cur_);
    if (pending_.length() && indexOf(pending_) >= 0) {
      idx = indexOf(pending_);
    } else if (step == core::Step::Random) {
      int r = (int)(esp_random() % n);
      if (n > 1 && r == idx) r = (r + 1) % n;
      idx = r;
    } else if (step == core::Step::Prev) {
      idx = (idx <= 0 ? n : idx) - 1;
    } else if (step == core::Step::Next || idx < 0) {
      idx = (idx + 1) % n;
    }
    pending_ = "";

    uint8_t* buf = core::scratch();
    if (!buf) return false;
    const String path = String(DIR) + "/" + names_[idx] + ".e6";
    {
      core::BusLock l;
      File f = SD.open(path, FILE_READ);
      if (!f) return false;
      const size_t got = f.read(buf, core::FRAME_BYTES);
      f.close();
      if (got != core::FRAME_BYTES) return false;
    }
    canvas.pushImage(0, 0, core::W, core::H, (uint16_t*)buf);

    cur_ = names_[idx];
    Preferences p;
    p.begin("photos", false);
    p.putString("cur", cur_);
    p.end();
    what = cur_;
    return true;
  }

  void routes(WebServer& s) override {
    s.on("/p/photos/list.json", HTTP_GET, [this, &s] { list(s); });
    s.on("/p/photos/thumb", HTTP_GET, [this, &s] { thumb(s); });
    s.on("/p/photos/delete", HTTP_POST, [this, &s] { remove(s); });
    s.on("/p/photos/show", HTTP_POST, [this, &s] {
      if (!core::authorized()) return;
      core::touch();
      String n = safeName(s.arg("n"));
      if (indexOf(n) < 0) return s.send(404, "application/json", "{\"ok\":false,\"msg\":\"No such photo.\"}");
      if (core::refreshing()) return s.send(409, "application/json", "{\"ok\":false,\"msg\":\"The screen is still refreshing.\"}");
      pending_ = n;
      core::requestShow(key(), core::Step::Same);
      s.send(200, "application/json", "{\"ok\":true}");
    });
    s.on("/p/photos/upload", HTTP_POST, [this, &s] { uploadDone(s); }, [this, &s] { uploadChunk(s); });
  }

 private:
  std::vector<String> names_, thumbs_;
  String cur_, pending_;
  // upload state
  File up_;
  String upTmp_, upFinal_, upErr_;
  size_t upBytes_ = 0;
  bool upAuth_ = false, upBegun_ = false;
  std::vector<String> upSaved_;

  int indexOf(const String& n) const {
    for (size_t i = 0; i < names_.size(); ++i)
      if (names_[i] == n) return (int)i;
    return -1;
  }

  void rescan() {
    names_.clear();
    thumbs_.clear();
    if (!core::sdReady()) return;
    core::BusLock l;
    if (!SD.exists(DIR)) SD.mkdir(DIR);
    File d = SD.open(DIR);
    if (!d) return;
    for (File e = d.openNextFile(); e; e = d.openNextFile()) {
      String n = e.name();
      int slash = n.lastIndexOf('/');
      if (slash >= 0) n = n.substring(slash + 1);
      if (!e.isDirectory() && n.endsWith(".e6") && e.size() == core::FRAME_BYTES) names_.push_back(n.substring(0, n.length() - 3));
      else if (!e.isDirectory() && n.endsWith(".jpg")) thumbs_.push_back(n.substring(0, n.length() - 4));
      e.close();
    }
    d.close();
    std::sort(names_.begin(), names_.end());
  }

  // No SD access here (the list is kept by rescan), so it answers during a panel refresh too.
  void list(WebServer& s) {
    String j = "{\"items\":[";
    for (size_t i = 0; i < names_.size(); ++i) {
      const bool t = std::find(thumbs_.begin(), thumbs_.end(), names_[i]) != thumbs_.end();
      j += String(i ? "," : "") + "{\"n\":\"" + names_[i] + "\",\"t\":" + (t ? "true" : "false") + "}";
    }
    j += "],\"cur\":\"" + cur_ + "\",\"sd\":" + String(core::sdReady() ? "true" : "false") + "}";
    s.send(200, "application/json", j);
  }

  void thumb(WebServer& s) {
    const String n = safeName(s.arg("n"));
    core::BusLock l;
    File f = SD.open(String(DIR) + "/" + n + ".jpg", FILE_READ);
    if (!f) return s.send(404, "text/plain", "no preview");
    s.sendHeader("Cache-Control", "max-age=86400");
    s.streamFile(f, "image/jpeg");
    f.close();
  }

  void remove(WebServer& s) {
    if (!core::authorized()) return;
    const String n = safeName(s.arg("n"));
    {
      core::BusLock l;
      SD.remove(String(DIR) + "/" + n + ".e6");
      SD.remove(String(DIR) + "/" + n + ".jpg");
    }
    rescan();
    s.send(200, "application/json", "{\"ok\":true}");
  }

  // Multipart upload, streamed to SD one chunk at a time (a frame is far bigger than internal RAM allows).
  void uploadChunk(WebServer& s) {
    HTTPUpload& u = s.upload();
    if (u.status == UPLOAD_FILE_START) {
      if (!upBegun_) {  // first file of this request
        upBegun_ = true;
        upAuth_ = core::authorized();
      }
      if (!upAuth_) return;
      core::touch();
      String fn = u.filename;
      const bool frame = fn.endsWith(".e6"), jpg = fn.endsWith(".jpg");
      const String base = safeName(fn);
      if ((!frame && !jpg) || base.isEmpty()) { upErr_ = "Unexpected file " + fn; return; }
      if (!core::sdReady()) { upErr_ = "No SD card"; return; }
      upFinal_ = String(DIR) + "/" + base + (frame ? ".e6" : ".jpg");
      upTmp_ = String(DIR) + "/.part" + (frame ? ".e6" : ".jpg");
      upBytes_ = 0;
      core::BusLock l;
      if (!SD.exists(DIR)) SD.mkdir(DIR);
      up_ = SD.open(upTmp_, FILE_WRITE);
      if (!up_) upErr_ = "Can't write to the SD card";
    } else if (!upAuth_ || !up_) {
      return;
    } else if (u.status == UPLOAD_FILE_WRITE) {
      core::BusLock l;
      if (up_.write(u.buf, u.currentSize) != u.currentSize) upErr_ = "SD card full or failing";
      upBytes_ += u.currentSize;
    } else if (u.status == UPLOAD_FILE_END || u.status == UPLOAD_FILE_ABORTED) {
      core::BusLock l;
      up_.close();
      const bool frame = upFinal_.endsWith(".e6");
      if (u.status == UPLOAD_FILE_ABORTED) upErr_ = "Upload interrupted";
      else if (frame && upBytes_ != core::FRAME_BYTES) upErr_ = "Frame has " + String(upBytes_) + " bytes, expected 960000";
      if (upErr_.length()) {
        SD.remove(upTmp_);
      } else {
        SD.remove(upFinal_);
        SD.rename(upTmp_, upFinal_);
        upSaved_.push_back(upFinal_);
      }
    }
  }

  void uploadDone(WebServer& s) {
    upBegun_ = false;
    if (!upAuth_) {  // the 401 went out at the start
      upSaved_.clear();
      upErr_ = "";
      return;
    }
    rescan();
    if (upErr_.length()) s.send(400, "application/json", "{\"ok\":false,\"msg\":\"" + webkit::jsonEscape(upErr_) + "\"}");
    else s.send(200, "application/json", "{\"ok\":true,\"saved\":" + String(upSaved_.size()) + "}");
    upSaved_.clear();
    upErr_ = "";
    upAuth_ = false;
  }
};

}  // namespace

REGISTER_PLUGIN(Photos)
