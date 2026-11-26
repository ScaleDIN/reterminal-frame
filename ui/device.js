// reTerminal frame: core page logic. Plugins add themselves with App.plugin({...}) (src/plugins/*/ui/plugin.js);
// tools/build_ui.py appends their scripts after this one, then App.start().
const App = (() => {
  const $ = K.$;
  const plugins = [];
  let st = null;          // last /status.json
  const listeners = [];   // fn(status) after every poll

  // ---------------------------------------------------------------- tabs (built from <section class="tab">)
  const tabs = () => [...document.querySelectorAll('section.tab')];
  function showTab(id) {
    if (!tabs().some((t) => t.dataset.tab === id)) id = 'overview';
    tabs().forEach((t) => { t.hidden = t.dataset.tab !== id; });
    $('tabs').querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === id));
    if (location.hash.slice(1) !== id) history.replaceState(null, '', '#' + id);
    plugins.forEach((p) => p.key === id && p.shown && p.shown());
  }
  function buildTabs() {
    $('tabs').innerHTML = tabs().map((t) => `<button type="button" role="tab" data-tab="${K.esc(t.dataset.tab)}">${K.esc(t.dataset.title)}<span class="tc" id="tc-${K.esc(t.dataset.tab)}"></span></button>`).join('');
    $('tabs').querySelectorAll('button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
    addEventListener('hashchange', () => showTab(location.hash.slice(1)));
    showTab(location.hash.slice(1) || 'overview');
  }

  // ---------------------------------------------------------------- helpers for plugins
  // POST that expects {"ok":..,"msg":..}; says the result in el (a .msg line). Returns the parsed reply or null.
  async function act(url, data, el, okText) {
    if (el) el.textContent = 'Sending…';
    try {
      const r = await K.post(url, data || {});
      let j = {};
      try { j = await r.json(); } catch (e) {}
      if (!r.ok || j.ok === false) { if (el) el.textContent = j.msg || (r.status === 401 ? 'Login needed (user admin).' : 'HTTP ' + r.status); return null; }
      if (el) el.textContent = j.msg || okText || 'Done.';
      poll();
      return j;
    } catch (e) { if (el) el.textContent = 'The frame did not answer (asleep?)'; return null; }
  }
  const dur = (s) => (s == null ? '—' : s >= 3600 ? Math.floor(s / 3600) + ' h ' + K.p2(Math.floor(s / 60) % 60) + ' min' : s >= 60 ? Math.floor(s / 60) + ' min' : s + ' s');
  const ROT = ['Portrait', 'Landscape', 'Portrait, upside down', 'Landscape, upside down'];

  // ---------------------------------------------------------------- status
  function render(s) {
    $('name').textContent = s.name ? s.name.charAt(0).toUpperCase() + s.name.slice(1) : 'Frame';
    document.title = $('name').textContent;
    $('sub').textContent = `fw ${s.fw} · up ${dur(s.uptime)} · ${s.net.ip || ''}${s.name ? ' · ' + s.name + '.local' : ''}`;
    K.versionWatch(s.build);
    K.pushClock(s.utc != null);

    K.pill('link', s.net.sta ? `Wi-Fi ${s.net.rssi} dBm` : s.net.ap ? 'Hotspot ' + s.net.ap_name : 'No Wi-Fi', s.net.sta ? (s.net.rssi > -75 ? 'ok' : 'warn') : 'warn');
    K.pill('pBat', s.bat.v == null ? 'No battery' : `Battery ${s.bat.pct} %`, s.bat.v == null ? '' : s.bat.pct < 15 ? 'bad' : s.bat.pct < 35 ? 'warn' : 'ok');
    K.pill('pAwake', s.always_on ? (s.usb ? 'On USB power' : 'Always on') : 'Awake ' + dur(s.awake_left), s.always_on ? 'ok' : s.awake_left < 120 ? 'warn' : '');

    const src = s.plugins.find((p) => p.key === s.settings.source);
    const shownBy = s.plugins.find((p) => p.key === s.shown.plugin);
    $('tiles').innerHTML =
      K.tile('Showing', K.esc(s.shown.what || '—'), s.refreshing ? 'refreshing now…' : (shownBy ? K.esc(shownBy.title) + ' · ' : '') + (s.shown.ago == null ? 'since start' : dur(s.shown.ago) + ' ago')) +
      K.tile('Next change', s.refreshing ? '…' : dur(s.next_change), 'every ' + dur(s.settings.interval_min * 60) + (src ? ' · ' + K.esc(src.title) : '')) +
      K.tile('Battery', s.bat.v == null ? '—' : s.bat.pct + ' %', s.bat.v == null ? 'none found' : K.f(s.bat.v, 2, ' V') + (s.charge ? ' · ' + K.esc(s.charge) : s.usb ? ' · on USB' : ''), s.bat.v != null && s.bat.pct < 15 ? 'bad' : '') +
      K.tile('Wi-Fi', s.net.sta ? s.net.rssi + ' dBm' : s.net.ap ? 'Hotspot' : '—', s.net.sta ? K.esc(s.net.ssid) : s.net.ap ? K.esc(s.net.ap_name) + ' · set up below' : '') +
      K.tile('SD card', s.sd.ok ? K.f((s.sd.total_mb - s.sd.used_mb) / 1024, 1, ' GB') : 'MISSING', s.sd.ok ? 'free of ' + K.f(s.sd.total_mb / 1024, 1, ' GB') : 'insert a FAT32 card', s.sd.ok ? '' : 'bad') +
      K.tile('Last refresh', s.shown.refresh_ms == null ? '—' : K.f(s.shown.refresh_ms / 1000, 0, ' s'), 'how long the panel took');

    $('pRef').style.visibility = s.refreshing ? 'visible' : 'hidden';
    ['bPrev', 'bNext', 'bRand'].forEach((id) => { $(id).disabled = s.refreshing; });

    // Source select: one option per plugin.
    const opts = s.plugins.map((p) => `<option value="${K.esc(p.key)}">${K.esc(p.title)}${p.count >= 0 ? ' (' + p.count + ')' : ''}</option>`).join('');
    if ($('srcSel').dataset.o !== opts) { $('srcSel').innerHTML = opts; $('srcSel').dataset.o = opts; }
    schedEd.fill(s.settings);
    sfEd.fill({ host: s.settings.host });
    $('noPass').disabled = !s.settings.has_pass;

    s.plugins.forEach((p) => { const e = $('tc-' + p.key); if (e) e.textContent = p.count >= 0 ? ' ' + p.count : ''; });
    $('wifiNow').innerHTML = s.net.sta ? `Joined <b>${K.esc(s.net.ssid)}</b> (${s.net.rssi} dBm), ${K.esc(s.net.ip)}`
      : `Hotspot <b>${K.esc(s.net.ap_name)}</b> at ${K.esc(s.net.ip)}` + (s.net.ssid ? ` (could not join <b>${K.esc(s.net.ssid)}</b>)` : ': pick your network');
    $('diag').textContent = JSON.stringify(s, null, 1);
  }

  let pollT = null, fails = 0;
  async function poll() {
    clearTimeout(pollT);
    try {
      st = await K.getJSON('/status.json', 5000);
      fails = 0;
      render(st);
      listeners.forEach((fn) => fn(st));
    } catch (e) {
      if (++fails >= 2) { K.pill('link', 'Asleep / offline', 'bad'); K.pill('pAwake', 'Asleep?', 'warn'); }
    }
    pollT = setTimeout(poll, st && st.refreshing ? 2000 : 4000);
  }

  // ---------------------------------------------------------------- forms
  let schedEd, sfEd;
  function forms() {
    schedEd = K.edits($('sched'), (d) => { $('schedApply').disabled = !d; $('schedUndo').style.visibility = d ? 'visible' : 'hidden'; });
    $('sched').onsubmit = async (e) => {
      e.preventDefault();
      const F = $('sched'), was = st && st.settings.rotation;
      const data = { source: F.source.value, interval_min: F.interval_min.value, awake_min: F.awake_min.value, always_on: F.always_on.value, rotation: F.rotation.value };
      if (await act('/settings', data, $('schedMsg'))) {
        schedEd.clear();
        if (was != null && +data.rotation !== was) $('schedMsg').textContent = `Saved. New photos are made for “${ROT[data.rotation]}”; photos already on the frame keep their orientation.`;
      }
    };
    $('schedUndo').onclick = () => { schedEd.clear(); $('sched').querySelectorAll('[data-edited]').forEach((el) => delete el.dataset.edited); if (st) { schedEd.fill(st.settings); } };
    $('bSleep').onclick = () => { if (confirm('Sleep now? The page stops answering until a button is held for 2 s or the frame is restarted.')) act('/sleep', {}, $('schedMsg'), 'Going to sleep.'); };

    sfEd = K.edits($('sf'));
    $('sf').onsubmit = async (e) => {
      e.preventDefault();
      const F = $('sf'), data = { host: F.host.value.trim().toLowerCase() };
      if (!/^[a-z0-9-]{1,24}$/.test(data.host)) { $('sfMsg').textContent = 'Name: letters, digits and -, up to 24.'; return; }
      if ($('noPass').checked) { if (!confirm('Remove the password? Anyone on the network can then change the frame.')) return; data.newpass = ''; }
      else if (F.newpass.value) data.newpass = F.newpass.value;
      if (await act('/settings', data, $('sfMsg'), 'Saved. A new name takes effect after a restart.')) { sfEd.clear(); F.newpass.value = ''; $('noPass').checked = false; }
    };

    ['bPrev', 'bNext', 'bRand'].forEach((id, i) => {
      $(id).onclick = () => act('/show', { step: ['prev', 'next', 'random'][i] }, $('showMsg'), 'Changing the screen: about 15–45 s.');
    });

    K.wifiCard({ other: false });

    $('fwFile').onchange = () => { $('fwGo').disabled = !$('fwFile').files.length; };
    $('fwGo').onclick = () => {
      const f = $('fwFile').files[0];
      if (!f || !confirm(`Install ${f.name} (${Math.round(f.size / 1024)} kB) and restart?`)) return;
      const fd = new FormData(); fd.append('firmware', f, f.name);
      const x = new XMLHttpRequest();
      x.upload.onprogress = (e) => { $('fwMsg').textContent = `Uploading ${Math.round((e.loaded / e.total) * 100)} %`; };
      x.onload = () => { $('fwMsg').textContent = x.status === 200 ? 'Installed. Restarting: reload in a moment.' : x.status === 401 ? 'Login needed (user admin).' : 'Failed: ' + x.responseText; };
      x.onerror = () => { $('fwMsg').textContent = 'Upload failed.'; };
      x.open('POST', '/update'); x.send(fd); $('fwGo').disabled = true;
    };
  }

  return {
    // Plugins: App.plugin({key, init(app), status(st), shown()})
    plugin(p) { plugins.push(p); },
    get status() { return st; },
    onStatus(fn) { listeners.push(fn); },
    act, dur, poll,
    start() {
      K.init({ storePrefix: 'frame-' });
      buildTabs();
      forms();
      plugins.forEach((p) => p.init && p.init(App));
      plugins.forEach((p) => p.status && listeners.push(p.status));
      poll();
      document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    },
  };
})();
