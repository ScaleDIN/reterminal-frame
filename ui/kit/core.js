/* device-web-ui kit v5: core helpers shared by every device page (window.K).
   Conventions from the EBC-A20 bridge and PocketCW firmware. */
(function () {
  const K = {};
  const $ = (K.$ = (id) => document.getElementById(id));
  K.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Number for display: '—' when missing. f(12.345,2,' V') -> '12.35 V'
  K.f = (v, d = 1, u = '') => (v == null || !isFinite(v) ? '—' : (+v).toFixed(d) + u);
  K.css = (v) => getComputedStyle(document.body).getPropertyValue(v).trim();
  K.NL = '\n';

  // Per-browser preferences (view, night mode, open cards). Never device state.
  let prefix = 'dev-';
  K.store = {
    get(k, d) { try { const v = localStorage.getItem(prefix + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(prefix + k, JSON.stringify(v)); } catch (e) {} },
  };

  // Time formatting (local time).
  const p2 = (K.p2 = (n) => String(n).padStart(2, '0'));
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  K.hm = (t) => { const d = new Date(t * 1000); return p2(d.getHours()) + ':' + p2(d.getMinutes()); };
  K.hms = (t) => { const d = new Date(t * 1000); return K.hm(t) + ':' + p2(d.getSeconds()); };
  K.dm = (t) => { const d = new Date(t * 1000); return d.getDate() + ' ' + MON[d.getMonth()]; };
  K.stampT = (t) => { const d = new Date(t * 1000); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()); };
  K.fileStamp = () => K.stampT(Date.now() / 1000).replace(/[: ]/g, '-');
  // Elapsed seconds as h:mm:ss / m:ss
  K.clock = (t, sec) => { t = Math.round(t); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
    return h ? h + ':' + p2(m) + (sec ? ':' + p2(s) : '') : m + ':' + p2(s); };

  K.save = (name, blob) => { const a = document.createElement('a'); a.download = name; a.href = URL.createObjectURL(blob);
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); };

  // Reading tile. v and s are HTML: build them with K.f / K.esc. The detail line is also its tooltip (v2): it gets cut off
  // on narrow screens.
  K.tile = (k, v, s, cls) => `<div class="tile"><div class="k">${K.esc(k)}</div><div class="v ${cls || ''}">${v}</div><div class="s" title="${String(s || '').replace(/<[^>]*>/g, '').replace(/"/g, '&quot;')}">${s || ''}</div></div>`;
  K.pill = (id, text, cls) => { const e = $(id); if (!e) return; e.textContent = text; e.className = 'pill' + (cls ? ' ' + cls : ''); };
  K.badge = (id, text, cls) => { const e = $(id); if (!e) return; e.textContent = text; e.className = 'badge' + (cls ? ' ' + cls : ''); };

  K.getJSON = async (url, timeoutMs = 8000) => {
    const o = window.AbortSignal && AbortSignal.timeout ? { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' } : { cache: 'no-store' };
    const r = await fetch(url, o);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  };
  K.post = (url, data) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(data).toString() });

  // ------------------------------------------------------------ page setup
  K.init = function (opts) {
    prefix = (opts && opts.storePrefix) || prefix;
    // Red night mode
    if (K.store.get('night', false)) document.documentElement.setAttribute('data-night', '');
    if ($('night')) $('night').onclick = () => K.setNight(!document.documentElement.hasAttribute('data-night'));
    // Collapsible cards remember open/closed
    const open = new Set(K.store.get('open', []));
    document.querySelectorAll('details.card').forEach((d) => {
      if (open.has(d.id)) d.open = true;
      d.addEventListener('toggle', () => { d.open ? open.add(d.id) : open.delete(d.id); K.store.set('open', [...open]); });
    });
    // Pinned bar as soon as the tiles start to scroll off the top (v8: was "entirely off screen", which a one-row tile
    // strip on a wide screen rarely is). Only the top edge counts: tiles running off the bottom of a short window don't.
    const tiles = $('tiles'), pw = $('pinwrap');
    if (tiles && pw) {
      // a direct check on scroll, not an IntersectionObserver: with display scaling a "fully visible" ratio of 1 may
      // never be reported, which left the bar showing back at the top. One rect read per event; no frame wait.
      const check = () => { const on = tiles.getBoundingClientRect().top < -0.5; if (pw.classList.contains('show') !== on) pw.classList.toggle('show', on); };
      addEventListener('scroll', check, { passive: true });
      addEventListener('resize', check);
      check();
    }
    // v3: a readings card that shrinks to a sticky mini bar instead (K.miniCard)
    if (opts && opts.mini) K.miniCard(opts.mini);
  };

  // v3: readings card (class "rd") that stays at the top and shrinks to its .mm values once the page scrolls
  // (on below `on` px, off above `off` px: the gap stops it flipping). It shrinks by ~140 px; without a spacer
  // everything below would move up by that much: a jump on iOS (no scroll anchoring), and elsewhere the anchoring
  // pulls the page back above the threshold and the card flips back and forth. So a bottom margin keeps its slot
  // the full height while it is small.
  K.miniCard = function (id, on = 140, off = 40) {
    const r = $(id); if (!r) return;
    const mb = parseFloat(getComputedStyle(r).marginBottom) || 0;
    let full = 0;
    const slot = () => { if (!r.classList.contains('mini')) { full = r.offsetHeight; r.style.marginBottom = ''; return; }
      r.style.marginBottom = (mb + Math.max(0, full - r.offsetHeight)) + 'px'; };
    addEventListener('scroll', () => { const y = scrollY, m = r.classList.contains('mini');
      if (y > on && !m) { full = r.offsetHeight; r.classList.add('mini'); slot(); } else if (y < off && m) { r.classList.remove('mini'); slot(); } }, { passive: true });
    if (window.ResizeObserver) new ResizeObserver(slot).observe(r);
  };
  // v5: control forms. K.edits(form, onChange) marks a field data-edited when the user changes it (accent border in a
  // .ctl form) and returns {fill(vals), dirty(), clear()}. fill never overwrites a field being typed in or edited, so
  // polling can refresh the form. Fields inside .pref (per-browser preferences) are not tracked.
  K.edits = function (form, onChange) {
    const fields = () => [...form.querySelectorAll('input,select,textarea')].filter((el) => !el.closest('.pref'));
    const dirty = () => fields().some((el) => el.dataset.edited);
    const tell = () => onChange && onChange(dirty());
    fields().forEach((el) => el.addEventListener('input', () => { el.dataset.edited = '1'; tell(); }));
    form.querySelectorAll('.nu>input[type=number]').forEach(K.stepper);
    return {
      fill(vals) {
        for (const [k, v] of Object.entries(vals)) {
          const el = form.elements[k];
          if (el && !el.dataset.edited && document.activeElement !== el) el.value = v == null ? '' : String(v);
        }
      },
      dirty,
      clear() { fields().forEach((el) => delete el.dataset.edited); tell(); },
    };
  };
  // v6: our own up/down arrows for a number in a .nu box (K.edits adds them). The browser's spinner can't be given a
  // dependable gap from the number (Chrome on Windows ignores its margin), so it is hidden and these sit after the
  // input with a fixed gap. A click steps by the input's step and fires 'input', like typing; holding repeats.
  // Always shown, so nothing moves on hover; inert while the input is disabled.
  K.stepper = function (inp) {
    if (inp.nextElementSibling && inp.nextElementSibling.classList.contains('st')) return;
    const st = document.createElement('span');
    st.className = 'st';
    st.innerHTML = '<button type="button" tabindex="-1" aria-label="Up" data-d="1"></button>'
      + '<button type="button" tabindex="-1" aria-label="Down" data-d="-1"></button>';
    inp.after(st);
    let t = null;
    const stop = () => { clearTimeout(t); clearInterval(t); t = null; };
    const step = (d) => {
      if (inp.disabled || inp.readOnly) return;
      try { d > 0 ? inp.stepUp() : inp.stepDown(); } catch (e) { return; }
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    };
    st.querySelectorAll('button').forEach((b) => {
      const d = +b.dataset.d;
      b.addEventListener('pointerdown', (e) => {
        if (e.button) return;
        e.preventDefault(); stop(); step(d);
        t = setTimeout(() => { t = setInterval(() => step(d), 70); }, 450);
      });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, stop));
      b.addEventListener('click', (e) => { if (e.detail === 0) step(d); });  // keyboard / assistive "click"
    });
  };
  // v5: "Ask before switching off": binds a checkbox to a per-browser preference (on by default) and returns
  // ask(what, note) -> true to go ahead. Switching off can cut a running session, so it says what loses power.
  K.askOff = function (box, key = 'askOff') {
    box.checked = K.store.get(key, true);
    box.onchange = () => K.store.set(key, box.checked);
    return (what, note) => !box.checked || confirm(`Switch ${what} off?` + (note ? '\n\n' + note : ''));
  };
  K.onNight = [];
  K.setNight = (on) => {
    on ? document.documentElement.setAttribute('data-night', '') : document.documentElement.removeAttribute('data-night');
    K.store.set('night', on);
    K.onNight.forEach((fn) => fn(on));
  };

  // "New version: reload" pill when the device runs a different build than the page came from.
  let BUILD = '';
  K.versionWatch = (build, pillId = 'upd') => { if (!build) return; if (!BUILD) BUILD = build; else if (build != BUILD && $(pillId)) $(pillId).style.display = ''; };

  // Devices without a clock: send the browser's time (at most once a minute) until they have one.
  let clockPushAt = 0;
  K.pushClock = (hasClock, url = '/time') => {
    if (hasClock || Date.now() - clockPushAt < 60000) return;
    clockPushAt = Date.now();
    K.post(url, { t: (Date.now() / 1000).toFixed(3) }).catch(() => {});
  };

  // ------------------------------------------------------------ WiFi card (standard ids: scanb scanst nets wf)
  // Device: GET /wifi/scan?start=1 starts an async scan; GET /wifi/scan -> {running, list:[{ssid,rssi,ch,open}], current}
  const bars = (r) => (r > -55 ? '▂▄▆█' : r > -67 ? '▂▄▆_' : r > -78 ? '▂▄__' : '▂___');
  // v3 options: other: true adds "Other / hidden network…" (shows #ssbox, which holds the SSID field);
  // submit(form): send it yourself (e.g. a JSON post) instead of the form post; say(msg): instead of alert().
  K.wifiCard = function (opts = {}) {
    const url = opts.url || '/wifi/scan', say = opts.say || alert;
    const OTHER = '<option value="__other">Other / hidden network…</option>';
    const other = () => { if (!opts.other) return; const o = $('nets').value == '__other'; if ($('ssbox')) $('ssbox').style.display = o ? '' : 'none'; if (o) $('wf').ssid.value = ''; };
    const fail = () => { $('scanb').disabled = false; $('scanst').textContent = 'Scan failed, try again'; };
    const poll = (k) => K.getJSON(url).then((d) => {
      if (d.running && k < 25) return setTimeout(() => poll(k + 1), 800);
      $('scanb').disabled = false;
      if (!d.list) return fail();
      $('scanst').textContent = d.list.length + ' networks found';
      $('nets').innerHTML = '<option value="">(pick a network)</option>' + d.list.map((x) =>
        `<option value="${K.esc(x.ssid)}">${K.esc(x.ssid)}  ${bars(x.rssi)} ${x.rssi} dBm · ch ${x.ch}${x.open ? ' · open' : ''}${x.ssid == d.current ? ' · saved' : ''}</option>`).join('') + (opts.other ? OTHER : '');
      other();
    }).catch(fail);
    $('scanb').onclick = () => { $('scanb').disabled = true; $('scanst').textContent = 'Scanning…'; fetch(url + '?start=1').then(() => setTimeout(() => poll(0), 1500)).catch(fail); };
    $('nets').onchange = (e) => { other(); if (e.target.value && e.target.value != '__other') { $('wf').ssid.value = e.target.value; $('wf').pass.focus(); } };
    $('wf').onsubmit = () => {
      const F = $('wf'), p = F.pass.value;
      if (!F.ssid.value.trim()) { say('Choose a network first.'); return false; }
      if (p && (p.length < 8 || p.length > 63)) { say('WiFi password: 8–63 characters, or empty for an open network.'); return false; }
      if (!confirm(`Join "${F.ssid.value}" and restart?` + (opts.fallback ? ' ' + opts.fallback : ''))) return false;
      if (!opts.submit) return true;
      opts.submit(F);
      return false;
    };
  };

  // ------------------------------------------------------------ console card (ids: cmd cmdb cmdout)
  K.consoleCard = function (url = '/cmd', after) {
    const send = async () => {
      const c = $('cmd').value.trim();
      if (!c) return;
      try { const r = await K.post(url, { cmd: c }); $('cmdout').textContent = (r.ok ? '' : 'HTTP ' + r.status + ': ') + (await r.text()); }
      catch (e) { $('cmdout').textContent = 'Request failed'; }
      if (after) after();
    };
    $('cmdb').onclick = send;
    $('cmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  };

  // ------------------------------------------------------------ report (v3)
  // One self-contained HTML file: the page's CSS, o.css, o.body and, with o.chart, a working copy of the chart.
  // o.chart = {cfg, records, zoom, keys}: cfg is a function returning the K.chart options that uses nothing but K
  // (it is copied into the file as source), records the chart's records, zoom its zoom, keys the series to show
  // (chips). The body needs the chart elements (canvas#ch in .cw, #tip, and #lg / #zr as wanted). The kit's own
  // script is copied from the page (<script id="kitjs">, template.html).
  const BS = String.fromCharCode(92), scriptSafe = (t) => t.replace(/<\/(script)/gi, '<' + BS + '/$1'), jsonSafe = (v) => JSON.stringify(v).replace(/</g, BS + 'u003c');
  K.report = function (o) {
    const css = [...document.querySelectorAll('style')].map((e) => e.textContent).join(K.NL);
    let js = '';
    if (o.chart) {
      const c = o.chart, cfg = Object.assign({ persist: false }, c.keys ? { chips: c.keys } : {});
      js = '<script>' + scriptSafe(($('kitjs') || { textContent: '' }).textContent) + '<\/script><script>(function(){var C=K.chart(Object.assign((' +
        scriptSafe(c.cfg.toString()) + ')(),' + jsonSafe(cfg) + '));C.set(' + jsonSafe(c.records) + ');' +
        (c.zoom ? 'C.zoom(' + JSON.stringify(c.zoom) + ');' : '') + '})()<\/script>';
    }
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
      K.esc(o.title) + '</title><style>' + css + (o.css || '') + '</style></head><body>' + o.body + js + '</body></html>';
  };

  window.K = K;
})();
