/* device-web-ui kit v16 (chart API v4): the chart (K.chart). One engine for every device, generalised from the PocketCW chart
   (one y-axis per unit, panels, ranges, clock time) and the EBC-A20 chart (trace chips, elapsed time).

   Data: an array of records {t, <key>: number|null, ...} sorted by t (unix seconds, or seconds since start
   with time:'elapsed'). null = no reading; the line breaks there and is never drawn as zero.

   Interaction (identical on every device):
   Mouse: hover shows values, drag sideways zooms, click pins the readout, double-click resets.
   Touch: slide sideways moves the cursor; where it lifts (or a tap) pins. Double-tap and slide zooms,
   double-tap resets. A tap on the readout, or outside the chart (not on a control), unpins.

   Element ids: ch (canvas, inside .cw) tip lg chNote zr ranges panel cust bpng bcsv brng (v4: with the prefix o.ids). */
(function () {
  const K = window.K, $ = K.$, css = K.css, f = K.f, esc = K.esc;

  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    const m = Math.pow(10, Math.floor(Math.log10(raw))), r = raw / m;
    return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * m;
  }
  function decs(st) { let d = 0; while (d < 5 && Math.abs(Math.round(st * Math.pow(10, d)) - st * Math.pow(10, d)) > 1e-6) d++; return d; }

  /* o = {
       series: {key: [label, '--cN', laneId]},   (v14: a 4th item names the series' group, e.g. its device)
       lanes:  {laneId: {u:'°C', ua:'short axis label', dec:1, min, max, minSpan, log, fmt(v)}},
       panels: {id: {n:'Name', k:[keys]}, custom:{n:'Custom…'}}   -> <select id=panel>, optional custom picker #cust
       chips:  [keys on by default]                                -> legend checkboxes instead of panels
       ranges: [[hours, 'label'], ...] (0 = all)                   -> <span id=ranges class=seg>
       time:   'clock' (default) | 'elapsed',
       shade:  r => '--var' | null      background band for the interval ending at r
       shadeLegend: [['--var', 'label'], ...],
       gapS:   break the line when points are further apart than this (default 180),
       minZoomS, tipHead: r => html, tipExtra: (r, keys) => html,
       png: {name:'device', caption: () => [lines]}, csv: {name:'device', cols: [[key, 'header']]},
       empty: () => 'text when there is nothing to draw', store: 'chart' (prefix for saved view) }
     v2 additions (all optional; leaving them out keeps the v1 behaviour):
       store: ''              saved-view keys without a prefix (panel, range, custom, chips), for pages that predate the kit
       range: hours           default range (else the first of ranges); custom: [keys] default custom selection
       interval: s            each record covers the interval s before its t (per-minute logs): shading spans [t-interval, t]
                              with no gap check, and the view starts at the first record's t-interval
       now: () => unix|null   the device clock; records dated later than now+futureS (default 300) are left out of the
                              view's end (a clock that jumped ahead and back). endIdx() gives that last record
       minTickS: s            smallest time-axis step (default 10)
       seconds: false         no seconds in the tooltip time or the CSV time_local column
       countLabel: 'minutes'  word after the record count in #chNote (default 'samples')
       shadeLegend: [['--var', 'label', '--border'], ...]  optional border colour (default --line)
       beforeDraw: () => {}   called at the start of every draw (fill derived fields on the records)
       lanes[id].tick: v => 'label'   axis tick text (log lanes get the decade value 10^k)
       png.name / csv.name may be functions of the current panel id
       png.lines: ({t0, t1, keys, panel}) => [lines]   replaces the whole default caption (first line in --fg)
     v3 additions (all optional; leaving them out keeps the v2 behaviour):
       axes: n                only the first n lanes get a y-axis (EBC: 2, voltage left, current right). Further lanes
                              are scaled on their own and named with their range at the top left of the plot
       lanes[id].zero: true   axis from 0 up to the largest value + 6 % (current, power, counters); floor: smallest top
       lanes[id].empty: [lo, hi]   range to use when the view has no value for the lane (else 0..1)
       tipAll: true           the readout lists every series, also the ones not drawn
       timeHint: true         elapsed time: the label format (h:mm:ss, h:mm or m:ss) at the bottom left
       persist: false         nothing saved or read from localStorage (a copy of the chart in a saved report)
       caption lines (png.lines, png.caption, png(lines)) may be [text, '--colour'] instead of a string
     v4 additions (all optional; leaving them out keeps the v3 behaviour):
       ids: 'tn-'             prefix for every element id above (tn-ch, tn-tip, tn-lg, ...), so one page can hold several
                              charts; give each its own store prefix too (or persist:false)
       marks: () => [[t, '--colour', dashed, label], ...]   vertical marker lines (e.g. now), drawn over the traces;
                              (v10) an optional label sits above the plot at the line
       lanes[id].ref: [values]   reference lines across the plot in --mut (e.g. 0° = the horizon)
       lanes[id].step: n      fixed tick step for the first lane (e.g. 30 for -90..90°) instead of the nice step
     v5 additions (kit v12, optional; leaving it out keeps the v4 behaviour):
       bands: true | {lo: '_min', hi: '_max'}   a record may carry each series' lowest and highest value over its
                              interval next to the line's value (r.vin, r.vin_min, r.vin_max): drawn as a faint band
                              around the line (so a spike the average hides still shows), counted in the axis range,
                              given in the tooltip ("12.31 V, 10.80–12.40") and added to the CSV (<header>_min/_max).
                              Records without them (e.g. 1 s samples) draw the line alone.
       (kit v13) bands are drawn only while at most bands.max (default 2) series are shown, so a busy view stays
                              clean; the tooltip and the CSV keep the ranges anyway. An optional button #brng (class
                              rng) cycles Range: auto -> on (every view) -> off, remembered with the view.
     (kit v14) the Custom picker #cust shows the series as chips. With groups (series[k][3], or labels that all read
       "Group · Value" with two groups or more) it has one block per group: a header (fold chevron, the group name,
       "n of m" on, None while any is on) over chips with the short names (the "Group · " prefix dropped; the legend
       and readout keep the full label). A group with nothing on starts folded. Clear all leaves one series on, as
       the chart always shows at least one. Without groups the chips stand alone.
     (kit v16, optional; leaving it out keeps the v15 behaviour):
       hold: [keys]           series that sit at a value and jump (a focuser position, a filter slot, a set level): a
                              record's value holds until the next record that gives one, drawn as steps (flat, then
                              a vertical jump), never as a ramp, and without a band (the steps are exact). With hold,
                              any record may leave a key out (undefined, not null): a held series carries its value
                              through it, any other series skips it without a break, and the readout takes that
                              series from the nearest record that has it. null still means no reading (a break).
                              K.histJoin(coarse, fine, changes) builds such records from history.json res=m, res=s
                              and res=c (the hub's History with held keys).
     (kit v15) the picker is shown under the chart in every view, not only Custom, so changing views never changes
       the page's height: it lights the current view's values and stands in for the legend (#lg then shows only
       shadeLegend). Clicking a chip, None or Clear all in another view switches to Custom, starting from that
       view's values. Groups fold only when clicked (the start: those with nothing on), remembered with the view.
       A folded group lists its lit values on its header line (one line, cut with …), so it still reads as a legend.
     Returns {set, merge, records, draw, endIdx, view, panel, keys} and (v3) zoom(), zoom([t0, t1] | null),
     pngCanvas(lines), png(lines, name): build or save the PNG with these caption lines (the device can fetch
     what it needs for the caption first). */
  /* v16: chart records from a hub History's replies (already turned into records {t, key: value}): the 10 s steps
     (res=m) before the 1 s samples (res=s), with each held key's exact changes (res=c, rows [t, key, value]) in place
     of the steps' values from its first change on (step: the steps' length, default 10 s). Give the chart
     hold: [the held keys]. */
  K.histJoin = function (coarse, fine, changes, step) {
    const start = fine.length ? fine[0].t : Infinity, first = {}, at = new Map();
    (changes || []).forEach(([t, k, v]) => {
      if (!(k in first)) first[k] = t;
      if (t >= start) return;
      if (!at.has(t)) at.set(t, { t });
      at.get(t)[k] = v;
    });
    const held = Object.keys(first);
    const out = coarse.filter((r) => r.t < start).map((r) => {
      const c = Object.assign({}, r);
      // a step that ends after the key's first change: its value comes from the log
      held.forEach((k) => { if (r.t + (step || 10) > first[k]) { delete c[k]; delete c[k + '_min']; delete c[k + '_max']; } });
      if (at.has(r.t)) { Object.assign(c, at.get(r.t)); at.delete(r.t); }   // a change at a step's start: one record
      return c;
    });
    return out.concat([...at.values()]).sort((x, y) => x.t - y.t).concat(fine);
  };

  K.chart = function (o) {
    const E = (id) => $((o.ids || '') + id);  // v9: element ids with a prefix, so a page can hold several charts
    const SER = o.series, LANE = o.lanes || {}, PANELS = o.panels, RANGES = o.ranges;
    const elapsed = o.time === 'elapsed', gapS = o.gapS || 180, minZoom = o.minZoomS || (elapsed ? 2 : 120);
    const sk = (k) => (o.store === '' ? k : (o.store || 'chart') + '-' + k);
    const ivl = o.interval || 0, futureS = o.futureS == null ? 300 : o.futureS, nm = (x) => (typeof x == 'function' ? x(panel) : x);
    const ST = o.persist === false ? { get: (k, d) => d, set() {} } : K.store;
    const BLO = o.bands ? (o.bands.lo || '_min') : null, BHI = o.bands ? (o.bands.hi || '_max') : null;   // v12
    const BMAX = o.bands && o.bands.max != null ? o.bands.max : 2;      // v13: auto draws bands up to this many series
    const HOLD = new Set(o.hold || []), SPARSE = HOLD.size > 0;         // v16: held series; records may leave keys out
    const skip = (r, s) => SPARSE && r[s] === undefined;
    // v16: each held series' value carried into the records that leave it out (null too: no reading until the next)
    function prep() {
      if (!SPARSE) return;
      HOLD.forEach((s) => { let v; R.forEach((r) => { if (r[s] === undefined) { if (v !== undefined) r[s] = v; } else v = r[s]; }); });
    }
    let bandMode = BLO ? ST.get(sk('bands'), 'auto') : 'auto';
    if (!['auto', 'on', 'off'].includes(bandMode)) bandMode = 'auto';
    let R = [], zoom = null, hov = null, pin = null, drag = null, lastTap = null, G = null;
    let panel = PANELS ? ST.get(sk('panel'), Object.keys(PANELS)[0]) : null;
    if (PANELS && !PANELS[panel]) panel = Object.keys(PANELS)[0];
    const range0 = RANGES ? (o.range != null ? o.range : RANGES[0][0]) : 0;
    let range = RANGES ? ST.get(sk('range'), range0) : 0;
    if (RANGES && !RANGES.some((r) => r[0] == range)) range = range0;
    let custom = ST.get(sk('custom'), PANELS && PANELS.custom ? o.custom || Object.keys(SER).slice(0, 4) : []).filter((k) => SER[k]);
    if (PANELS && PANELS.custom && !custom.length) custom = [Object.keys(SER)[0]];
    let chipsOn = o.chips ? ST.get(sk('chips'), o.chips).filter((k) => SER[k]) : [];
    const base = document.createElement('canvas');

    function keys() {
      if (o.chips) return Object.keys(SER).filter((k) => chipsOn.includes(k));
      if (!PANELS) return Object.keys(SER);
      return panel == 'custom' ? Object.keys(SER).filter((k) => custom.includes(k)) : PANELS[panel].k;
    }
    function bandsOn() { return !!BLO && (bandMode == 'on' || (bandMode == 'auto' && keys().length <= BMAX)); }
    function bandUi() {
      const el = E('brng'); if (!el) return;
      el.style.display = BLO ? '' : 'none';
      el.textContent = 'Range: ' + bandMode;
      el.classList.toggle('on', bandMode == 'on');
      el.title = bandMode == 'auto' ? `Each step's lowest to highest reading, as a band, when ${BMAX == 1 ? 'one value is' : 'at most ' + BMAX + ' values are'} shown. Click: always`
        : bandMode == 'on' ? 'The lowest-highest band in every view. Click: never' : 'No bands (the readout still gives each range). Click: automatic';
    }
    function lanes() {
      const out = [];
      keys().forEach((k) => { const id = SER[k][2]; let l = out.find((x) => x.id == id); if (!l) { l = Object.assign({ id, S: [] }, LANE[id]); out.push(l); } l.S.push(k); });
      return out;
    }

    // ---- controls
    function legend() {
      const lg = E('lg');
      if (!lg) return;
      if (o.chips) {
        lg.innerHTML = Object.keys(SER).map((k) => `<label><input type="checkbox" data-k="${k}" ${chipsOn.includes(k) ? 'checked' : ''}><i style="background:var(${SER[k][1]})"></i>${esc(SER[k][0])}</label>`).join('');
      } else {
        lg.innerHTML = (PICK ? '' : keys().map((k) => `<span><i style="background:var(${SER[k][1]})"></i>${esc(SER[k][0])}</span>`).join('')) + (o.shadeLegend || []).map(([v, n, bd]) => `<span><i style="background:var(${v});border:1px solid var(${bd || '--line'})"></i>${esc(n)}</span>`).join('');
      }
    }
    if (o.chips && E('lg')) E('lg').onchange = (e) => {
      const k = e.target.dataset.k; if (!k) return;
      chipsOn = e.target.checked ? chipsOn.concat(k) : chipsOn.filter((x) => x != k);
      if (!chipsOn.length) { chipsOn = [k]; e.target.checked = true; }
      ST.set(sk('chips'), chipsOn); draw();
    };
    // v14: the Custom picker. Groups: the series' 4th item, else "Group · Value" labels when there are two or more.
    const GRP = (() => {
      const ks = Object.keys(SER), sep = ' · ';
      let g = ks.map((k) => SER[k][3] || null);
      if (!g.some(Boolean)) {
        const d = ks.map((k) => { const i = SER[k][0].indexOf(sep); return i > 0 ? SER[k][0].slice(0, i) : null; });
        if (d.every(Boolean) && new Set(d).size > 1) g = d;
      }
      if (!g.some(Boolean)) return null;
      const out = [];
      ks.forEach((k, i) => { const n = g[i] || ''; let x = out.find((o) => o.n == n); if (!x) out.push((x = { n, k: [] })); x.k.push(k); });
      return out;
    })();
    const short = (k) => { const l = SER[k][0], g = GRP && GRP.find((x) => x.k.includes(k)); return g && g.n && l.startsWith(g.n + ' · ') ? l.slice(g.n.length + 3) : l; };
    const PICK = !!(PANELS && PANELS.custom && E('cust') && !o.chips);   // v15: the picker shows in every view
    let shut = null;   // group names folded (v15: a group with nothing on at the start, then only by clicking)
    function custUi() {
      const el = E('cust'); if (!el) return;
      el.style.display = PICK ? '' : 'none';
      if (!PICK) return;
      const cur = keys();
      if (GRP && !shut) { const s = ST.get(sk('shut'), null); shut = new Set(Array.isArray(s) ? s : GRP.filter((g) => !g.k.some((k) => cur.includes(k))).map((g) => g.n)); }
      const chip = (k) => { const on = cur.includes(k); return `<button type="button" class="chip${on ? ' on' : ''}" data-k="${esc(k)}" aria-pressed="${on}" title="${esc(SER[k][0])}">` +
        `<i style="background:${on ? 'var(' + SER[k][1] + ')' : 'transparent'}"></i>${esc(short(k))}</button>`; };
      el.innerHTML = '<div class="cpk">' + (GRP ? GRP.map((g, i) => {
        const n = g.k.filter((k) => cur.includes(k)).length;
        return `<div class="cg${shut.has(g.n) ? ' shut' : ''}" data-g="${i}"><div class="cgh" role="button" tabindex="0" aria-expanded="${!shut.has(g.n)}"><span class="chev">▾</span>` +
          `<b>${esc(g.n || 'Other')}</b><span class="cn">${n} of ${g.k.length}</span>` +
          (n && shut.has(g.n) ? `<span class="clit">${g.k.filter((k) => cur.includes(k)).map((k) => `<i style="background:var(${SER[k][1]})"></i>${esc(short(k))}`).join(' ')}</span>` : '') +
          (n ? `<button type="button" class="cnone" data-g="${i}" title="Turn off every value of ${esc(g.n || 'this group')}">None</button>` : '') +
          `</div><div class="cgv">${g.k.map(chip).join('')}</div></div>`;
      }).join('') + '<div class="cft"><button type="button" class="call" title="Leaves one value on: the chart always shows at least one">Clear all</button></div>'
        : `<div class="cflat">${Object.keys(SER).map(chip).join('')}</div>`) + '</div>';
    }
    function setCustom(next, keep) {  // never empty: keep stays on. v15: from another view, switches to Custom
      custom = Object.keys(SER).filter((k) => next.includes(k));
      if (!custom.length) custom = [keep || Object.keys(SER)[0]];
      ST.set(sk('custom'), custom);
      if (panel != 'custom') { panel = 'custom'; ST.set(sk('panel'), panel); if (E('panel')) E('panel').value = panel; }
      custUi(); draw();
    }
    if (E('cust')) E('cust').onclick = (e) => {
      const c = e.target.closest('.chip'), none = e.target.closest('.cnone'), all = e.target.closest('.call'), h = e.target.closest('.cgh');
      const cur = keys();
      if (c) { const k = c.dataset.k; setCustom(cur.includes(k) ? cur.filter((x) => x != k) : cur.concat(k), k); }
      else if (none) { const g = GRP[+none.dataset.g]; setCustom(cur.filter((k) => !g.k.includes(k)), cur.find((k) => !g.k.includes(k)) || g.k.find((k) => cur.includes(k))); }
      else if (all) setCustom([], cur[0]);
      else if (h) { const g = GRP[+h.parentElement.dataset.g]; shut.has(g.n) ? shut.delete(g.n) : shut.add(g.n); ST.set(sk('shut'), [...shut]); custUi(); }
    };
    if (E('cust')) E('cust').onkeydown = (e) => { if ((e.key == 'Enter' || e.key == ' ') && e.target.classList.contains('cgh')) { e.preventDefault(); e.target.click(); } };
    if (PANELS && E('panel')) {
      E('panel').innerHTML = Object.entries(PANELS).map(([k, p]) => `<option value="${k}">${esc(p.n)}</option>`).join('');
      E('panel').value = panel;
      E('panel').onchange = (e) => { panel = e.target.value; ST.set(sk('panel'), panel); custUi(); draw(); };
    }
    custUi();
    function rangeUi() { if (RANGES && E('ranges')) E('ranges').innerHTML = RANGES.map(([h, l]) => `<button type="button" data-h="${h}" class="${h == range && !zoom ? 'on' : ''}">${esc(l)}</button>`).join(''); }
    if (RANGES && E('ranges')) E('ranges').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; range = +b.dataset.h; ST.set(sk('range'), range); zoom = null; draw(); };
    if (E('zr')) E('zr').onclick = () => { zoom = null; draw(); };
    if (E('brng')) E('brng').onclick = () => { bandMode = { auto: 'on', on: 'off', off: 'auto' }[bandMode]; ST.set(sk('bands'), bandMode); draw(); };   // v13

    // ---- view window
    // Last record at or before the device clock (+futureS): a clock that jumped ahead and back leaves records dated
    // in the future, which must not stretch the view.
    function endIdx() {
      let i = R.length - 1;
      const n = o.now ? o.now() : null;
      if (n != null) while (i > 0 && R[i].t > n + futureS) i--;
      return i;
    }
    function view() {
      if (!R.length) return null;
      const end = R[endIdx()].t;
      let t0, t1;
      if (zoom) { t0 = zoom[0]; t1 = zoom[1]; }
      else { t1 = end; t0 = Math.max(range ? end - range * 3600 : -Infinity, R[0].t - ivl); }  // a young log fills the chart
      if (t1 - t0 < minZoom) t0 = t1 - minZoom;
      return [t0, t1];
    }

    // ---- static layer (drawn to an offscreen canvas)
    function draw() {
      if (o.beforeDraw) o.beforeDraw();
      const c = E('ch'), AX = lanes();
      const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
      base.width = c.width = Math.round(w * dpr); base.height = c.height = Math.round(h * dpr);
      const g = base.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.fillStyle = css('--card'); g.fillRect(0, 0, w, h); g.font = '11px system-ui';
      rangeUi(); legend(); bandUi();
      const BON = bandsOn();
      if (E('zr')) E('zr').style.display = zoom ? '' : 'none';
      // One plot, one y-axis per unit: axis 0 left, 1 right, then outward on alternate sides.
      // v3 axes: n: lanes after the first n are drawn without an axis (named with their range in the plot).
      const NA = o.axes ? Math.min(o.axes, AX.length) : AX.length;
      const AW = w < 500 ? 36 : 46, nL = Math.ceil(NA / 2), nR = Math.floor(NA / 2);
      const L = Math.max(Math.max(nL, 1) * AW, elapsed && o.timeHint ? (w < 500 ? 40 : 52) : 0), Rr = Math.max(nR * AW, 12), T = 24, B = 24, pw = w - L - Rr, ph = h - T - B;
      G = null;
      const V = view();
      if (!V || !AX.length) { g.fillStyle = css('--mut'); g.fillText(o.empty ? o.empty() : 'No data yet', L, T + 14); render(); return; }
      const [t0, t1] = V, n = R.length;
      let a, b;
      { let lo = 0, hi = n - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (R[m].t < t0) lo = m + 1; else hi = m; } a = Math.max(0, lo - 1); }
      { let lo = 0, hi = n - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (R[m].t > t1) hi = m - 1; else lo = m; } b = Math.min(n - 1, lo + 1); }
      const X = (t) => L + ((t - t0) / (t1 - t0)) * pw;

      if (o.shade) {  // state bands
        g.save(); g.beginPath(); g.rect(L, T, pw, ph); g.clip();
        for (let k = ivl ? a : Math.max(a, 1); k <= b; k++) {
          const v = o.shade(R[k]); if (!v) continue;
          const x0 = X(ivl ? R[k].t - ivl : R[k - 1].t), x1 = X(R[k].t);
          if (x1 > x0 && (ivl || R[k].t - R[k - 1].t <= gapS)) { g.fillStyle = css(v); g.fillRect(x0, T, Math.max(1, x1 - x0), ph); }
        }
        g.restore();
      }

      // Scales: the first axis sets the gridlines; the others pick a step that lands on the same lines.
      let divs = 5;
      AX.forEach((ax, i) => {
        let mn = Infinity, mx = -Infinity;
        ax.tf = ax.log ? (v) => (v > 0 ? Math.log10(v) : null) : (v) => v;
        const rng = (v) => { const y = v == null ? null : ax.tf(v); if (y != null) { if (y < mn) mn = y; if (y > mx) mx = y; } };
        for (let k = a; k <= b; k++) ax.S.forEach((s) => { rng(R[k][s]); if (BON && !HOLD.has(s)) { rng(R[k][s + BLO]); rng(R[k][s + BHI]); } });
        let st;
        if (ax.log) {
          if (mn > mx) { mn = -4; mx = 0; }
          mn = Math.floor(mn); mx = Math.max(Math.ceil(mx), mn + 1);
          if (i >= NA) st = 0;
          else if (i == 0) { st = Math.max(1, Math.ceil((mx - mn) / (ph < 230 ? 4 : 5))); mx = mn + Math.ceil((mx - mn) / st) * st; divs = (mx - mn) / st; }
          else { st = Math.max(1, Math.ceil((mx - mn) / divs)); mx = mn + st * divs; }
        } else {
          if (ax.min != null && ax.max != null) { mn = ax.min; mx = ax.max; }
          else if (ax.zero) { mx = Math.max(mx > -Infinity ? mx * 1.06 : 0, ax.floor || 0) || 1; mn = 0; }
          else if (mn > mx && !ax.empty) { mn = 0; mx = 1; }
          else {
            if (mn > mx) { mn = ax.empty[0]; mx = ax.empty[1]; }
            const sp = Math.max(mx - mn, ax.minSpan || 1), mid = (mx + mn) / 2; mn = mid - sp * 0.56; mx = mid + sp * 0.56; if (ax.min != null && mn < ax.min) { mx += ax.min - mn; mn = ax.min; }
          }
          if (i >= NA) st = 0;  // no axis: its own range, no gridlines to match
          else if (i == 0) { st = ax.step || niceStep((mx - mn) / (ph < 230 ? 4 : 5)); mn = Math.floor(mn / st + 1e-9) * st; mx = Math.ceil(mx / st - 1e-9) * st; divs = Math.max(1, Math.round((mx - mn) / st)); }
          else {
            st = niceStep((mx - mn) / divs); let m0 = Math.floor(mn / st + 1e-9) * st;
            for (let q = 0; q < 8 && m0 + st * divs < mx - 1e-9; q++) { st = niceStep(st * 1.01); m0 = Math.floor(mn / st + 1e-9) * st; }
            if (ax.min != null && m0 < ax.min) m0 = ax.min;
            mn = m0; mx = m0 + st * divs;
          }
        }
        ax.mn = mn; ax.mx = mx; ax.st = st;
        ax.Y = (v) => T + ph - ((v - mn) / ((mx - mn) || 1)) * ph;
        ax.left = i % 2 == 0; ax.slot = Math.floor(i / 2); ax.col = ax.S.length == 1 ? SER[ax.S[0]][1] : '--mut';
      });
      g.lineWidth = 1;
      for (let j = 0; j <= divs; j++) { const y = Math.round(T + ph - (j / divs) * ph) + 0.5; g.strokeStyle = css('--grid'); g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke(); }
      AX.forEach((ax) => (ax.ref || []).forEach((v) => {  // v9: lane reference lines (e.g. the horizon)
        if (v < ax.mn || v > ax.mx) return; const y = Math.round(ax.Y(v)) + 0.5;
        g.strokeStyle = css('--mut'); g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke();
      }));
      AX.slice(0, NA).forEach((ax) => {
        const x = ax.left ? L - ax.slot * AW - 5 : L + pw + ax.slot * AW + 5;
        g.fillStyle = css(ax.col); g.textAlign = ax.left ? 'right' : 'left'; g.textBaseline = 'middle';
        for (let j = 0; j <= divs; j++) {
          const q = ax.mn + j * ax.st, v = ax.log ? Math.pow(10, q) : q;
          g.fillText(ax.tick ? ax.tick(v) : ax.log ? (ax.fmt ? ax.fmt(v) : String(v)) : q.toFixed(decs(ax.st)), x, Math.round(T + ph - (j / divs) * ph));
        }
        g.textBaseline = 'bottom'; g.fillText(ax.ua || ax.u || '', x, T - 6);
      });

      // Time axis
      const span = t1 - t0, ts0 = (sp) => [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400].find((s) => sp / s <= Math.max(3, Math.floor(pw / 80))) || 86400;
      g.textAlign = 'center'; g.textBaseline = 'top';
      // v9: a tick label near either edge is moved inwards so it isn't cut off (e.g. 12:00 at the right end).
      const tlabel = (s, x) => { const hw = g.measureText(s).width / 2 + 1; g.fillText(s, Math.max(hw, Math.min(w - hw, x)), T + ph + 6); };
      if (elapsed) {
        const ts = ts0(span);
        for (let tt = Math.ceil(t0 / ts) * ts; tt <= t1; tt += ts) {
          const x = Math.round(X(tt)) + 0.5; g.strokeStyle = css('--grid'); g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke();
          g.fillStyle = css('--mut'); tlabel(K.clock(tt, ts < 60), x);
        }
      } else {
        const TS = [10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800].filter((s) => s >= (o.minTickS || 10)), maxT = Math.max(4, Math.floor(pw / 55));
        const ts = TS.find((s) => span / s <= maxT) || 604800, tz = new Date().getTimezoneOffset() * 60;
        for (let tt = Math.ceil((t0 - tz) / ts) * ts + tz; tt <= t1; tt += ts) {
          const x = Math.round(X(tt)) + 0.5; g.strokeStyle = css('--grid'); g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke();
          const d = new Date(tt * 1000), mid = d.getHours() == 0 && d.getMinutes() == 0 && d.getSeconds() == 0;
          g.fillStyle = css('--mut'); tlabel(ts >= 86400 || mid ? K.dm(tt) : ts < 60 ? K.hms(tt) : K.hm(tt), x);
        }
      }
      if (elapsed && o.timeHint) { g.textAlign = 'left'; g.fillStyle = css('--mut'); g.fillText(t1 >= 3600 ? (ts0(span) < 60 ? 'h:mm:ss' : 'h:mm') : 'm:ss', 2, T + ph + 6); }
      g.strokeStyle = css('--line'); g.strokeRect(L + 0.5, T + 0.5, pw - 1, ph - 1);
      if (NA < AX.length) {  // lanes without an axis: name and range at the top left
        g.textAlign = 'left'; g.textBaseline = 'top'; let x = L + 6;
        AX.slice(NA).forEach((ax) => {
          const d = ax.dec == null ? 2 : ax.dec, txt = ax.S.map((s) => SER[s][0]).join(', ') + ' ' + f(ax.mn, d) + '–' + f(ax.mx, d) + (ax.u ? ' ' + ax.u : '');
          g.fillStyle = css(ax.col); g.fillText(txt, x, T + 4); x += g.measureText(txt).width + 12;
        });
      }

      // Traces (first series on top)
      g.save(); g.beginPath(); g.rect(L, T, pw, ph); g.clip(); g.lineJoin = 'round'; g.lineWidth = 1.6;
      if (BON) {  // v12: min-max bands under the lines, one filled run per stretch without a gap (v13: when shown)
        g.globalAlpha = 0.2;
        AX.slice().reverse().forEach((ax) => ax.S.slice().reverse().forEach((s) => {
          if (HOLD.has(s)) return;   // v16: a held series' steps are exact
          g.fillStyle = css(SER[s][1]);
          let run = [], pt = -Infinity;
          const flush = () => {
            if (run.length > 1) {
              g.beginPath(); run.forEach(([x, , yh], i) => (i ? g.lineTo(x, yh) : g.moveTo(x, yh)));
              for (let i = run.length - 1; i >= 0; i--) g.lineTo(run[i][0], run[i][1]);
              g.closePath(); g.fill();
            }
            run = [];
          };
          for (let k = a; k <= b; k++) {
            if (skip(R[k], s)) continue;
            const lo = R[k][s + BLO] == null ? null : ax.tf(R[k][s + BLO]), hi = R[k][s + BHI] == null ? null : ax.tf(R[k][s + BHI]);
            if (lo == null || hi == null || R[k].t - pt > gapS) flush();
            pt = R[k].t;
            if (lo != null && hi != null) run.push([X(R[k].t), ax.Y(lo), ax.Y(hi)]);
          }
          flush();
        }));
        g.globalAlpha = 1;
      }
      AX.slice().reverse().forEach((ax) => ax.S.slice().reverse().forEach((s) => {
        g.strokeStyle = css(SER[s][1]); g.beginPath();
        let pen = false, pt = -Infinity, py = 0;
        const step = HOLD.has(s);
        for (let k = a; k <= b; k++) {
          if (skip(R[k], s)) continue;
          const v = R[k][s] == null ? null : ax.tf(R[k][s]);
          if (v == null || R[k].t - pt > gapS) pen = false;
          pt = R[k].t;
          if (v == null) continue;
          const x = X(R[k].t), y = ax.Y(v);
          if (pen && step) g.lineTo(x, py);   // v16: held: flat to here, then the jump
          pen ? g.lineTo(x, y) : g.moveTo(x, y); pen = true; py = y;
        }
        g.stroke();
      }));
      g.restore();
      if (o.marks) {  // v9: vertical marker lines [t, '--colour', dashed, label] (e.g. now); v10: label above the plot
        const M = o.marks().filter(([t]) => t >= t0 && t <= t1);
        g.save(); g.beginPath(); g.rect(L, T, pw, ph); g.clip(); g.lineWidth = 1;
        M.forEach(([t, v, dash]) => {
          const x = Math.round(X(t)) + 0.5;
          g.strokeStyle = css(v || '--fg'); g.setLineDash(dash ? [3, 3] : []); g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke();
        });
        g.restore();
        g.textAlign = 'center'; g.textBaseline = 'bottom';
        M.forEach(([t, v, , lb]) => {  // in the top margin, kept clear of the left axis label and the right edge
          if (!lb) return; const hw = g.measureText(lb).width / 2 + 1;
          g.fillStyle = css(v || '--fg'); g.fillText(lb, Math.max(L + hw, Math.min(w - hw, X(t))), T - 6);
        });
      }
      if (E('chNote')) E('chNote').textContent = elapsed ? `${K.clock(t0, true)} – ${K.clock(t1, true)} · ${b - a + 1} samples`
        : `${K.stampT(t0)} – ${K.stampT(t1)} · ${b - a + 1} ${o.countLabel || 'samples'}`;
      G = { L, T, pw, ph, t0, t1, a, b, X, LN: AX };
      render();
    }

    // ---- dynamic layer: selection, cursor, tooltip
    function render() {
      const c = E('ch'), g = c.getContext('2d'), dpr = window.devicePixelRatio || 1, tip = E('tip');
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.width, c.height);
      if (base.width) g.drawImage(base, 0, 0);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!G) { tip.style.display = 'none'; return; }
      if (drag && Math.abs(drag.x1 - drag.x0) > 3) { g.fillStyle = css('--sel'); g.fillRect(Math.min(drag.x0, drag.x1), G.T, Math.abs(drag.x1 - drag.x0), G.ph); }
      const pinned = hov == null && pin != null, qx = pinned ? G.X(pin) : hov;
      if (qx == null || qx < G.L - 1 || qx > G.L + G.pw + 1) { tip.style.display = 'none'; return; }
      const tq = G.t0 + ((qx - G.L) / G.pw) * (G.t1 - G.t0);
      let lo = G.a, hi = G.b;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (R[m].t < tq) lo = m; else hi = m; }
      const k = Math.abs(R[lo].t - tq) <= Math.abs(R[hi].t - tq) ? lo : hi, x = G.X(R[k].t), r = R[k];
      if (x < G.L - 1 || x > G.L + G.pw + 1) { tip.style.display = 'none'; return; }
      g.strokeStyle = css('--fg'); g.globalAlpha = 0.45; g.setLineDash([4, 3]);
      g.beginPath(); g.moveTo(Math.round(x) + 0.5, G.T); g.lineTo(Math.round(x) + 0.5, G.T + G.ph); g.stroke();
      g.setLineDash([]); g.globalAlpha = 1;
      // v16: a series this record leaves out is read from the nearest record that has it (within the gap limit)
      const near = (s) => {
        if (!skip(r, s)) return r;
        for (let d = 1; d < 400; d++) {
          const i = k - d, j = k + d, ri = i >= G.a ? R[i] : null, rj = j <= G.b ? R[j] : null;
          if (!ri && !rj) break;
          const best = [ri, rj].filter((q) => q && !skip(q, s) && Math.abs(q.t - r.t) <= gapS).sort((p, q) => Math.abs(p.t - r.t) - Math.abs(q.t - r.t))[0];
          if (best) return best;
        }
        return {};
      };
      G.LN.forEach((ln) => ln.S.forEach((s) => {
        const rs = near(s), tv = rs[s] == null ? null : ln.tf(rs[s]); if (tv == null) return;
        const y = ln.Y(tv); g.fillStyle = css(SER[s][1]); g.beginPath(); g.arc(x, y, 3.5, 0, 7); g.fill();
        g.strokeStyle = css('--card'); g.lineWidth = 1.5; g.stroke();
      }));
      const ks = keys(), lane = (s) => LANE[SER[s][2]] || {};
      const val = (s) => {
        const l = lane(s), d = l.dec == null ? 2 : l.dec, r = near(s);
        const v = l.fmt ? (r[s] == null ? '—' : l.fmt(r[s]) + ' ' + (l.u || '')) : f(r[s], d, l.u ? ' ' + l.u : '');
        const lo = BLO && !HOLD.has(s) ? r[s + BLO] : null, hi = BLO && !HOLD.has(s) ? r[s + BHI] : null;   // v12: the step's range, when it has one
        return lo == null || hi == null || (f(lo, d) == f(r[s], d) && f(hi, d) == f(r[s], d)) ? v
          : v + '</b><span style="opacity:.7">, ' + f(lo, d) + '–' + f(hi, d) + '</span><b>';
      };
      tip.innerHTML = '<b>' + (elapsed ? K.clock(r.t, true) : K.stampT(r.t) + (o.seconds !== false && G.t1 - G.t0 < 3600 ? ':' + K.p2(new Date(r.t * 1000).getSeconds()) : '')) + '</b>' +
        (o.tipHead ? ' · ' + o.tipHead(r) : '') +
        (pinned ? ' · <span style="opacity:.7">pinned</span> <b style="float:right;margin-left:10px">✕</b>' : '') + '<br>' +
        (o.tipAll ? Object.keys(SER) : ks).map((s) => '<i style="background:var(' + SER[s][1] + ')"></i>' + esc(SER[s][0]) + ': <b>' + val(s) + '</b>').join('<br>') +
        (o.tipExtra ? o.tipExtra(r, ks) : '');
      tip.style.pointerEvents = pinned ? 'auto' : 'none'; tip.style.cursor = pinned ? 'pointer' : ''; tip.title = pinned ? 'Tap or click to unpin' : '';
      tip.style.display = 'block';
      const tw = tip.offsetWidth, cw = c.clientWidth;
      let lx = x + 14; if (lx + tw > cw - 4) lx = x - 14 - tw; if (lx < 0) lx = 4;
      tip.style.left = lx + 'px'; tip.style.top = G.T + 8 + 'px';
    }

    // ---- pointer handling
    (function events() {
      const cv = E('ch'), tip = E('tip'), px = (e) => e.clientX - cv.getBoundingClientRect().left;
      let down = null;
      tip.addEventListener('click', () => { pin = null; lastTap = null; render(); });
      document.addEventListener('click', (e) => {
        if (pin == null || e.target === cv || tip.contains(e.target) || e.target.closest('button,input,label,select,a,summary,textarea')) return;
        pin = null; lastTap = null; render();
      });
      const tt = (x) => G.t0 + ((x - G.L) / G.pw) * (G.t1 - G.t0), inP = (x) => G && x >= G.L && x <= G.L + G.pw, cl = (x) => Math.max(G.L, Math.min(G.L + G.pw, x));
      cv.addEventListener('pointermove', (e) => { if (e.pointerType != 'mouse' && !down) return; hov = px(e); if (drag && G) drag.x1 = cl(hov); render(); });
      cv.addEventListener('pointerleave', () => { if (!drag) { hov = null; render(); } });
      cv.addEventListener('pointerdown', (e) => {
        const x = px(e), m = e.pointerType == 'mouse', lt = lastTap;
        const dbl = !m && lt && Date.now() - lt.t < 400 && Math.abs(x - lt.x) < 40;
        hov = x; down = { x, mouse: m, dbl, prev: dbl ? lt.pin : pin }; lastTap = null;
        if (inP(x)) { if (m || dbl) drag = { x0: x, x1: x }; try { cv.setPointerCapture(e.pointerId); } catch (_) {} }
        render();
      });
      cv.addEventListener('pointercancel', () => { drag = null; down = null; hov = null; render(); });
      // iOS: the second touch of a double-tap would start a text selection: cancel its default.
      cv.addEventListener('touchstart', (e) => { if (down && down.dbl) e.preventDefault(); }, { passive: false });
      cv.addEventListener('pointerup', (e) => {
        const x = px(e), d = down; down = null;
        if (drag && G && Math.abs(drag.x1 - drag.x0) > 8) {
          const A = tt(Math.min(drag.x0, drag.x1)), B = tt(Math.max(drag.x0, drag.x1));
          if (B - A >= minZoom) zoom = [A, B];
          if (d && d.dbl) pin = d.prev;
        } else if (d && d.dbl) { zoom = null; pin = d.prev; }
        else if (d && G && inP(d.x) && (!d.mouse || Math.abs(x - d.x) <= 8)) {
          pin = tt(cl(x));
          if (!d.mouse && Math.abs(x - d.x) <= 8) lastTap = { t: Date.now(), x, pin: d.prev };
        }
        drag = null; if (d && !d.mouse) hov = null;
        draw();
      });
      cv.addEventListener('dblclick', () => { zoom = null; draw(); });
    })();

    // ---- export
    if (E('bcsv')) E('bcsv').onclick = () => {
      const V = view(); if (!V) return;
      const rows = R.filter((r) => r.t >= V[0] && r.t <= V[1]);
      let cols = (o.csv && o.csv.cols) || Object.keys(SER).map((k) => [k, k]);
      if (BLO) cols = cols.flatMap(([k, h]) => (rows.some((r) => r[k + BLO] != null)   // v12: each band's columns
        ? [[k, h], [k + BLO, h + '_min'], [k + BHI, h + '_max']] : [[k, h]]));
      const head = (elapsed ? 'time_s' : 'time_local,time_utc') + ',' + cols.map((c) => c[1]).join(',');
      const csv = [head].concat(rows.map((r) => (elapsed ? r.t : K.stampT(r.t) + (o.seconds === false ? '' : ':' + K.p2(new Date(r.t * 1000).getSeconds())) + ',' + new Date(r.t * 1000).toISOString()) + ',' +
        cols.map((c) => (r[c[0]] == null ? '' : r[c[0]])).join(','))).join('\r\n');
      K.save((nm(o.csv && o.csv.name) || 'device') + '_' + K.fileStamp() + '.csv', new Blob([csv], { type: 'text/csv' }));
    };
    // The chart as shown plus caption lines below it. A line is a string (first in --fg, the rest in --mut) or
    // (v3) [text, '--colour'].
    function pngCanvas(lines) {
      const dpr = window.devicePixelRatio || 1, w = base.width / dpr;
      const lh = 16, chh = lines.length * lh + 12, c = document.createElement('canvas');
      c.width = base.width; c.height = base.height + Math.round(chh * dpr);
      const g = c.getContext('2d'); g.drawImage(base, 0, 0); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const y0 = base.height / dpr; g.fillStyle = css('--card'); g.fillRect(0, y0, w, chh);
      g.font = '12px system-ui'; g.textBaseline = 'top';
      lines.forEach((t, k) => { const a = Array.isArray(t); g.fillStyle = css(a ? t[1] : k ? '--mut' : '--fg'); g.fillText(a ? t[0] : t, 10, y0 + 6 + k * lh, w - 20); });
      return c;
    }
    function png(lines, name) {
      if (!G || !base.width) return;
      lines = lines || (o.png && o.png.lines ? o.png.lines({ t0: G.t0, t1: G.t1, keys: keys(), panel }) :
        [((o.png && o.png.title && o.png.title()) || document.title) + ' · ' + keys().map((k) => SER[k][0]).join(', '),
        (elapsed ? K.clock(G.t0, true) + ' – ' + K.clock(G.t1, true) : K.stampT(G.t0) + ' – ' + K.stampT(G.t1) + ' (local time)')]
        .concat(o.png && o.png.caption ? o.png.caption() : []));
      pngCanvas(lines).toBlob((b) => K.save((name || nm(o.png && o.png.name) || 'device') + '_' + K.fileStamp() + '.png', b), 'image/png');
    }
    if (E('bpng')) E('bpng').onclick = () => png();

    // Phones resize the height while scrolling (toolbar in/out): only a width change redraws.
    let lastW = innerWidth;
    addEventListener('resize', () => { if (innerWidth == lastW) return; lastW = innerWidth; draw(); });
    K.onNight.push(() => draw());
    // v3: the light/dark switch of the system redraws too (the canvas colours come from the tokens).
    if (window.matchMedia) { const mq = matchMedia('(prefers-color-scheme: dark)'); if (mq.addEventListener) mq.addEventListener('change', () => draw()); }

    return {
      set(recs) { R = recs; prep(); draw(); },
      // Adds or replaces records by t (incremental loads, e.g. ?since=).
      merge(recs) { if (!recs.length) return; const m = new Map(R.map((r) => [r.t, r])); recs.forEach((r) => m.set(r.t, r)); R = [...m.values()].sort((x, y) => x.t - y.t); prep(); draw(); },
      records: () => R,
      draw,
      endIdx,
      view,
      panel: () => panel,
      keys,
      // v3
      zoom(z) { if (z === undefined) return zoom; zoom = z; draw(); },
      pngCanvas,
      png,
    };
  };
})();
