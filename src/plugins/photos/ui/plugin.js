// Photos plugin: prepares photos in the browser (fit, colour, Floyd–Steinberg dithering to the 6 inks), uploads
// the ready 4bpp panel frame plus a small preview, and lists what's on the frame.
App.plugin((() => {
  const $ = K.$;
  const PW = 1200, PH = 1600;
  // [panel code, the colour the ink really looks like]. Spectra 6 inks are much duller than pure RGB, so dithering
  // against these gives truer results. Same table as tools/convert.py (INKS).
  const INKS = [[0xF, 0x19, 0x1E, 0x21], [0x0, 0xE8, 0xE8, 0xE8], [0xB, 0xEF, 0xDE, 0x44],
                [0x6, 0xB2, 0x13, 0x18], [0xD, 0x21, 0x57, 0xBA], [0x2, 0x12, 0x5F, 0x20]];
  const DEF = { fit: 'cover', sat: 1.25, con: 1.1, bri: 1.05, dith: '1' };

  let app, queue = [], cur = null, items = [], curName = '', rot = 0, busy = false;
  let opts = Object.assign({}, DEF);
  let result = null;  // {idx, vw, vh, rot}

  // ---------------------------------------------------------------- image pipeline
  const viewSize = (r) => (r & 1 ? [PH, PW] : [PW, PH]);

  function compose(bm, vw, vh, o, pan) {
    const c = document.createElement('canvas'); c.width = vw; c.height = vh;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.fillStyle = '#fff'; x.fillRect(0, 0, vw, vh);
    x.imageSmoothingQuality = 'high';
    const s = o.fit === 'cover' ? Math.max(vw / bm.width, vh / bm.height) : Math.min(vw / bm.width, vh / bm.height);
    const dw = bm.width * s, dh = bm.height * s;
    const px = o.fit === 'cover' ? pan.x : 0.5, py = o.fit === 'cover' ? pan.y : 0.5;
    x.drawImage(bm, (vw - dw) * px, (vh - dh) * py, dw, dh);
    return x.getImageData(0, 0, vw, vh);
  }

  // Colour adjustments like PIL's ImageEnhance (brightness, contrast around the mean grey, saturation), then
  // nearest-ink quantisation with serpentine Floyd–Steinberg error diffusion. Returns ink indexes (0..5).
  function dither(img, o) {
    const { width: w, height: h, data } = img, n = w * h;
    const b = new Float32Array(n * 3);
    let sumL = 0;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const r = data[j] * o.bri, g = data[j + 1] * o.bri, bl = data[j + 2] * o.bri;
      b[i * 3] = r; b[i * 3 + 1] = g; b[i * 3 + 2] = bl;
      sumL += 0.299 * r + 0.587 * g + 0.114 * bl;
    }
    const m = sumL / n;
    for (let i = 0; i < n * 3; i += 3) {
      let r = m + (b[i] - m) * o.con, g = m + (b[i + 1] - m) * o.con, bl = m + (b[i + 2] - m) * o.con;
      const L = 0.299 * r + 0.587 * g + 0.114 * bl;
      b[i] = L + (r - L) * o.sat; b[i + 1] = L + (g - L) * o.sat; b[i + 2] = L + (bl - L) * o.sat;
    }
    const idx = new Uint8Array(n), dith = o.dith === '1';
    const add = (x, y, er, eg, eb, f) => {
      if (x < 0 || x >= w || y >= h) return;
      const k = (y * w + x) * 3; b[k] += er * f; b[k + 1] += eg * f; b[k + 2] += eb * f;
    };
    for (let y = 0; y < h; y++) {
      const dir = y & 1 ? -1 : 1;
      for (let s = 0; s < w; s++) {
        const x = dir > 0 ? s : w - 1 - s, i = y * w + x, k = i * 3;
        const r = Math.min(255, Math.max(0, b[k])), g = Math.min(255, Math.max(0, b[k + 1])), bl = Math.min(255, Math.max(0, b[k + 2]));
        let best = 0, bd = 1e9;
        for (let p = 0; p < 6; p++) {
          const dr = r - INKS[p][1], dg = g - INKS[p][2], db = bl - INKS[p][3];
          const d = dr * dr + dg * dg + db * db;
          if (d < bd) { bd = d; best = p; }
        }
        idx[i] = best;
        if (!dith) continue;
        const er = r - INKS[best][1], eg = g - INKS[best][2], eb = bl - INKS[best][3];
        add(x + dir, y, er, eg, eb, 7 / 16);
        add(x - dir, y + 1, er, eg, eb, 3 / 16);
        add(x, y + 1, er, eg, eb, 5 / 16);
        add(x + dir, y + 1, er, eg, eb, 1 / 16);
      }
    }
    return idx;
  }

  function drawPreview(idx, vw, vh) {
    const c = $('phCv'); c.width = vw; c.height = vh;
    const x = c.getContext('2d'), im = x.createImageData(vw, vh), d = im.data;
    for (let i = 0, j = 0; i < idx.length; i++, j += 4) {
      const p = INKS[idx[i]]; d[j] = p[1]; d[j + 1] = p[2]; d[j + 2] = p[3]; d[j + 3] = 255;
    }
    x.putImageData(im, 0, 0);
  }

  // View (how the frame hangs) -> panel (1200 x 1600, its own orientation), 2 pixels per byte, left one high.
  // Same turns as tools/convert.py: landscape = a quarter turn anticlockwise, upside down = the other way.
  function pack(idx, vw, vh, r) {
    const out = new Uint8Array(PW * PH / 2), code = INKS.map((p) => p[0]);
    for (let py = 0; py < PH; py++) {
      for (let px = 0; px < PW; px++) {
        let vx, vy;
        if (r === 0) { vx = px; vy = py; }
        else if (r === 2) { vx = PW - 1 - px; vy = PH - 1 - py; }
        else if (r === 1) { vx = vw - 1 - py; vy = px; }
        else { vx = py; vy = vh - 1 - px; }
        const c = code[idx[vy * vw + vx]], o = py * (PW / 2) + (px >> 1);
        out[o] |= px & 1 ? c : c << 4;
      }
    }
    return out;
  }

  const thumbBlob = () => new Promise((res) => {
    const src = $('phCv'), s = 300 / Math.max(src.width, src.height) * (4 / 3);
    const c = document.createElement('canvas'); c.width = Math.round(src.width * s); c.height = Math.round(src.height * s);
    const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, c.width, c.height);
    c.toBlob(res, 'image/jpeg', 0.8);
  });

  // ---------------------------------------------------------------- editor
  const say = (t) => { $('phMsg').textContent = t; };
  let runT = null;
  function schedule(delay = 200) { clearTimeout(runT); runT = setTimeout(run, delay); }
  function run() {
    if (!cur) return;
    const r = rot, [vw, vh] = viewSize(r);
    $('phBusy').style.visibility = 'visible';
    setTimeout(() => {  // let "Dithering…" paint first
      const t0 = performance.now();
      const img = compose(cur.bm, vw, vh, opts, cur.pan);
      const idx = dither(img, opts);
      drawPreview(idx, vw, vh);
      result = { idx, vw, vh, rot: r };
      $('phBusy').style.visibility = 'hidden';
      if (!busy) say(`Ready (${Math.round(performance.now() - t0)} ms). ${queue.length ? queue.length + ' more waiting.' : ''}`);
    }, 20);
  }

  // Quick undithered draw while dragging, the full pipeline on release.
  function quick() {
    if (!cur) return;
    const [vw, vh] = viewSize(rot), c = $('phCv'); c.width = vw; c.height = vh;
    c.getContext('2d').putImageData(compose(cur.bm, vw, vh, opts, cur.pan), 0, 0);
  }

  function drag() {
    const c = $('phCv');
    let st = null;
    c.addEventListener('pointerdown', (e) => {
      if (!cur || opts.fit !== 'cover') return;
      c.setPointerCapture(e.pointerId);
      st = { x: e.clientX, y: e.clientY, pan: Object.assign({}, cur.pan) };
      c.style.cursor = 'grabbing';
    });
    c.addEventListener('pointermove', (e) => {
      if (!st) return;
      const [vw, vh] = viewSize(rot), r = c.getBoundingClientRect();
      const s = Math.max(vw / cur.bm.width, vh / cur.bm.height);
      const spareX = cur.bm.width * s - vw, spareY = cur.bm.height * s - vh;  // in view pixels
      const k = vw / r.width;  // screen px -> view px
      if (spareX > 1) cur.pan.x = Math.min(1, Math.max(0, st.pan.x - ((e.clientX - st.x) * k) / spareX));
      if (spareY > 1) cur.pan.y = Math.min(1, Math.max(0, st.pan.y - ((e.clientY - st.y) * k) / spareY));
      quick();
    });
    const end = () => { if (!st) return; st = null; c.style.cursor = ''; schedule(0); };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
  }

  async function next() {
    cur = null; result = null;
    while (queue.length) {
      const f = queue.shift();
      try {
        const bm = await createImageBitmap(f, { imageOrientation: 'from-image' });
        cur = { bm, name: f.name, pan: { x: 0.5, y: 0.5 } };
        break;
      } catch (e) { say(`Can't read ${f.name} in this browser (HEIC? save it as JPEG first). Skipped.`); }
    }
    $('phEdit').hidden = !cur;
    if (!cur) return false;
    $('phName').textContent = cur.name + ` · ${cur.bm.width} × ${cur.bm.height}`;
    $('phAll').style.visibility = queue.length ? 'visible' : 'hidden';
    run();
    return true;
  }

  function addFiles(list) {
    const imgs = [...list].filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|heic)$/i.test(f.name));
    if (!imgs.length) return;
    queue.push(...imgs);
    if (!cur) next(); else { $('phAll').style.visibility = 'visible'; say(queue.length + ' more waiting.'); }
  }

  // ---------------------------------------------------------------- upload
  const safe = (n) => n.replace(/\.[^.]*$/, '').replace(/[ .]/g, '_').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'photo';
  function uniqueName(n) {
    const have = new Set(items.map((i) => i.n));
    if (!have.has(n)) return n;
    for (let k = 2; ; k++) { const m = n.slice(0, 36) + '-' + k; if (!have.has(m)) return m; }
  }

  function send(frame, thumb, name) {
    return new Promise((res) => {
      const fd = new FormData();
      fd.append('frame', new Blob([frame], { type: 'application/octet-stream' }), name + '.e6');
      if (thumb) fd.append('thumb', thumb, name + '.jpg');
      const x = new XMLHttpRequest();
      x.upload.onprogress = (e) => say(`Uploading ${name}: ${Math.round((e.loaded / e.total) * 100)} %` +
        (app.status && app.status.refreshing ? ' (waits while the screen refreshes)' : ''));
      x.onload = () => {
        let j = {}; try { j = JSON.parse(x.responseText); } catch (e) {}
        res(x.status === 200 ? { ok: true } : { ok: false, msg: x.status === 401 ? 'Login needed (user admin).' : j.msg || 'HTTP ' + x.status });
      };
      x.onerror = () => res({ ok: false, msg: 'The frame did not answer (asleep?)' });
      x.open('POST', '/p/photos/upload'); x.send(fd);
    });
  }

  async function uploadCurrent() {
    if (!cur) return false;
    if (!result || result.rot !== rot) run();
    await new Promise((r) => { const w = () => (result && result.rot === rot && $('phBusy').style.visibility === 'hidden' ? r() : setTimeout(w, 50)); w(); });
    busy = true;
    const name = uniqueName(safe(cur.name));
    const r = await send(pack(result.idx, result.vw, result.vh, result.rot), await thumbBlob(), name);
    busy = false;
    if (!r.ok) { say('Not uploaded: ' + r.msg); return false; }
    items.push({ n: name, t: true });
    say(`Uploaded ${name}.`);
    loadList();
    return true;
  }

  async function uploadAll() {
    $('phAll').disabled = $('phUp').disabled = true;
    do { if (!(await uploadCurrent())) break; } while (await next());
    $('phAll').disabled = $('phUp').disabled = false;
  }

  // ---------------------------------------------------------------- gallery
  async function loadList() {
    try {
      const d = await K.getJSON('/p/photos/list.json');
      items = d.items; curName = d.cur;
      drawList(d.sd);
    } catch (e) { $('phGMsg').textContent = 'Could not load the list (asleep?)'; }
  }
  function drawList(sd) {
    $('phCount').textContent = items.length + (items.length === 1 ? ' photo' : ' photos');
    $('phGrid').innerHTML = items.length ? items.map((i) => `<div class="ph-it${i.n === curName ? ' cur' : ''}" data-n="${K.esc(i.n)}">
<div class="im">${i.t ? `<img loading="lazy" alt="" src="/p/photos/thumb?n=${encodeURIComponent(i.n)}">` : '<span class="mut">no preview</span>'}</div>
<div class="n" title="${K.esc(i.n)}">${K.esc(i.n)}</div><div class="b"><button type="button" data-a="show"${i.n === curName ? ' disabled' : ''}>Show</button><button type="button" class="d" data-a="del">Delete</button></div></div>`).join('')
      : `<p class="mut" style="margin:0">${sd === false ? 'No SD card in the frame.' : 'No photos yet: add some above.'}</p>`;
  }

  return {
    key: 'photos',
    init(a) {
      app = a;
      opts = Object.assign({}, DEF, K.store.get('ph-opts', {}));
      const F = $('phForm'), ed = K.edits(F, () => {
        opts = { fit: F.fit.value, sat: +F.sat.value || 1, con: +F.con.value || 1, bri: +F.bri.value || 1, dith: F.dith.value };
        K.store.set('ph-opts', opts);
        schedule();
      });
      ed.fill(opts);
      F.querySelectorAll('[data-edited]').forEach((e) => delete e.dataset.edited);
      $('phPick').onclick = () => $('phFiles').click();
      $('phFiles').onchange = () => { addFiles($('phFiles').files); $('phFiles').value = ''; };
      const dz = $('phDrop');
      ['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('over'); }));
      ['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
      dz.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
      $('phUp').onclick = async () => { $('phUp').disabled = true; if (await uploadCurrent()) await next(); $('phUp').disabled = false; };
      $('phAll').onclick = uploadAll;
      $('phSkip').onclick = () => next();
      drag();
      $('phGrid').onclick = async (e) => {
        const b = e.target.closest('button'); if (!b) return;
        const n = b.closest('.ph-it').dataset.n;
        if (b.dataset.a === 'del') {
          if (!confirm(`Delete ${n} from the frame's SD card?`)) return;
          if (await app.act('/p/photos/delete', { n }, $('phGMsg'), 'Deleted.')) loadList();
        } else {
          if (await app.act('/p/photos/show', { n }, $('phGMsg'), `Showing ${n}: the screen changes in about 15–45 s.`)) { curName = n; drawList(); }
        }
      };
      loadList();
    },
    status(s) {
      const p = s.plugins.find((x) => x.key === 'photos');
      if (rot !== s.settings.rotation) { rot = s.settings.rotation; $('phRot').textContent = ['portrait', 'landscape', 'portrait, upside down', 'landscape, upside down'][rot]; schedule(0); }
      if (p && (p.count !== items.length || p.cur !== curName) && !busy) loadList();
    },
    shown() { loadList(); },
  };
})());
