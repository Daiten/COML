// Minimal SVG chart helpers + shared tooltip. Colors come from CSS classes / tokens.
(function (global) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (t, year) => { const d = new Date(t); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}${year ? ' ' + d.getUTCFullYear() : ''}`; };
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const fmtDay = t => `${DOW[new Date(t).getUTCDay()]} ${fmtDate(t, true)}`;

  function fmtNum(v, dp) {
    if (v == null || !isFinite(v)) return '–';
    if (dp == null) dp = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
    return (+v.toFixed(dp)).toLocaleString('en-US', { maximumFractionDigits: dp });
  }
  const fmtSigned = (v, dp) => (v > 0 ? '+' : v < 0 ? '−' : '') + fmtNum(Math.abs(v), dp);
  const fmtP = p => (p == null || !isFinite(p) ? '–' : p < 0.001 ? '<0.001' : p.toFixed(3));

  function niceTicks(min, max, count) {
    count = count || 5;
    if (!isFinite(min) || !isFinite(max)) return [0, 1];
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const step0 = Math.pow(10, Math.floor(Math.log10(span / count)));
    const err = span / count / step0;
    const step = step0 * (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1);
    const ticks = [];
    for (let v = Math.floor(min / step) * step; v <= max + step * 0.5; v += step) ticks.push(+v.toFixed(10));
    if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
    return ticks;
  }
  const lin = (d0, d1, r0, r1) => v => r0 + (v - d0) / ((d1 - d0) || 1) * (r1 - r0);

  // ---- Tooltip ----
  let tipEl;
  function initTooltip() {
    tipEl = document.createElement('div');
    tipEl.className = 'tip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tipEl);
    document.addEventListener('mouseover', e => {
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (t) showTip(t.getAttribute('data-tip'), e.clientX, e.clientY);
    });
    document.addEventListener('mousemove', e => {
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (t) moveTip(e.clientX, e.clientY);
    });
    document.addEventListener('mouseout', e => {
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (t && !(e.relatedTarget && t.contains(e.relatedTarget))) hideTip();
    });
    window.addEventListener('scroll', hideTip, { passive: true });
  }
  function showTip(html, x, y) { tipEl.innerHTML = html; tipEl.style.display = 'block'; moveTip(x, y); }
  function moveTip(x, y) {
    const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    let left = x + 14, top = y + 14;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    if (top + h > window.innerHeight - 8) top = y - h - 14;
    tipEl.style.left = Math.max(8, left) + 'px';
    tipEl.style.top = Math.max(8, top) + 'px';
  }
  function hideTip() { if (tipEl) tipEl.style.display = 'none'; }

  // ---- Diverging color (positive = good = blue, negative = bad = red) ----
  const RAMP = {
    light: { mid: '#f0efec', pos: ['#cde2fb', '#86b6ef', '#3987e5', '#1c5cab'], neg: ['#fad4cf', '#f29d92', '#e34948', '#a92b2b'] },
    dark: { mid: '#383835', pos: ['#1d3a5f', '#1c5cab', '#3987e5', '#86b6ef'], neg: ['#5c2424', '#a92b2b', '#e34948', '#f29d92'] },
  };
  const hex2rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const rgb2hex = c => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  const isDark = () => document.documentElement.classList.contains('dark');
  function divColor(v) {
    const r = RAMP[isDark() ? 'dark' : 'light'];
    if (!isFinite(v) || v === 0) return r.mid;
    const stops = [r.mid, ...(v > 0 ? r.pos : r.neg)];
    const a = Math.min(1, Math.abs(v)) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(a));
    const f = a - k;
    const c0 = hex2rgb(stops[k]), c1 = hex2rgb(stops[k + 1]);
    return rgb2hex(c0.map((c, i) => c + (c1[i] - c) * f));
  }
  function inkOn(hex) {
    const [r, g, b] = hex2rgb(hex).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return L > 0.33 ? '#0b0b0b' : '#ffffff';
  }

  function svg(w, h, cls) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', `0 0 ${w} ${h}`);
    s.setAttribute('width', w);
    s.setAttribute('height', h);
    s.setAttribute('class', 'chart ' + (cls || ''));
    return s;
  }
  function el(parent, tag, attrs, text) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    parent.appendChild(e);
    return e;
  }
  const widthOf = (host, def) => Math.max(280, Math.floor(host.clientWidth || def || 640));

  function yAxis(s, ticks, y, x0, x1, fmt) {
    const g = el(s, 'g', { class: 'axis' });
    for (const t of ticks) {
      el(g, 'line', { x1: x0, x2: x1, y1: y(t), y2: y(t), class: 'grid' });
      el(g, 'text', { x: x0 - 6, y: y(t) + 4, 'text-anchor': 'end' }, fmt ? fmt(t) : fmtNum(t));
    }
  }

  // Time series: pts [{i, t, y}], rolling [{t, y}], highlight Set of day index.
  function timeSeries(host, o) {
    host.innerHTML = '';
    const W = widthOf(host), H = o.height || 240, m = { l: 46, r: 14, t: 12, b: 26 };
    const pts = o.pts.filter(p => p.y != null);
    const s = svg(W, H, 'ts');
    host.appendChild(s);
    if (!pts.length) { el(s, 'text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'empty' }, 'No data'); return; }
    const t0 = o.tMin != null ? o.tMin : pts[0].t, t1 = o.tMax != null ? o.tMax : pts[pts.length - 1].t;
    const ys = pts.map(p => p.y);
    const ticks = niceTicks(Math.min(...ys), Math.max(...ys), 4);
    const x = lin(t0, t1, m.l + 6, W - m.r - 6), y = lin(ticks[0], ticks[ticks.length - 1], H - m.b, m.t);
    yAxis(s, ticks, y, m.l, W - m.r);
    // x ticks
    const g = el(s, 'g', { class: 'axis' });
    el(g, 'line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: 'base' });
    const nT = Math.max(2, Math.min(8, Math.floor((W - m.l) / 80)));
    const span = t1 - t0;
    for (let k = 0; k <= nT; k++) {
      const t = t0 + Math.round(span * k / nT / 86400000) * 86400000;
      el(g, 'text', { x: x(t), y: H - 8, 'text-anchor': k === 0 ? 'start' : k === nT ? 'end' : 'middle' }, fmtDate(t));
    }
    // raw line, broken at calendar gaps
    let d = '', prev = null;
    for (const p of pts) {
      d += (prev && p.t - prev.t <= 86400000 * 1.5 ? 'L' : 'M') + x(p.t).toFixed(1) + ',' + y(p.y).toFixed(1);
      prev = p;
    }
    el(s, 'path', { d, class: 'line s1 thin' });
    if (o.rolling && o.rolling.length) {
      let rd = '';
      o.rolling.forEach((p, k) => { rd += (k ? 'L' : 'M') + x(p.t).toFixed(1) + ',' + y(p.y).toFixed(1); });
      el(s, 'path', { d: rd, class: 'line avg' });
    }
    for (const p of pts) {
      const hl = o.highlight && o.highlight.has(p.i);
      el(s, 'circle', { cx: x(p.t), cy: y(p.y), r: hl ? 5 : 3.5, class: 'dot ' + (hl ? 's2' : 's1') });
    }
    // hover crosshair
    const cross = el(s, 'line', { y1: m.t, y2: H - m.b, class: 'cross', visibility: 'hidden' });
    const ring = el(s, 'circle', { r: 6, class: 'hover-ring', visibility: 'hidden' });
    const ov = el(s, 'rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, class: 'overlay' });
    const pick = ev => {
      const b = s.getBoundingClientRect();
      const px = (ev.clientX - b.left) * (W / b.width);
      let best = pts[0], bd = Infinity;
      for (const p of pts) { const dd = Math.abs(x(p.t) - px); if (dd < bd) { bd = dd; best = p; } }
      return best;
    };
    ov.addEventListener('mousemove', ev => {
      const p = pick(ev);
      cross.setAttribute('x1', x(p.t)); cross.setAttribute('x2', x(p.t)); cross.setAttribute('visibility', 'visible');
      ring.setAttribute('cx', x(p.t)); ring.setAttribute('cy', y(p.y)); ring.setAttribute('visibility', 'visible');
      showTip(o.tip ? o.tip(p) : `${fmtDay(p.t)}<br><b>${fmtNum(p.y)}</b>`, ev.clientX, ev.clientY);
    });
    ov.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); ring.setAttribute('visibility', 'hidden'); hideTip(); });
    if (o.onClick) ov.addEventListener('click', ev => o.onClick(pick(ev)));
  }

  // Scatter: pts [{x, y, tip}], optional fit {a, b} (y = a + b x).
  function scatter(host, o) {
    host.innerHTML = '';
    const W = widthOf(host), H = o.height || 280, m = { l: 46, r: 14, t: 12, b: 40 };
    const s = svg(W, H, 'sc');
    host.appendChild(s);
    const pts = o.pts;
    if (pts.length < 2) { el(s, 'text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'empty' }, 'Not enough data'); return; }
    const xt = niceTicks(Math.min(...pts.map(p => p.x)), Math.max(...pts.map(p => p.x)), 5);
    const yt = niceTicks(Math.min(...pts.map(p => p.y)), Math.max(...pts.map(p => p.y)), 4);
    const x = lin(xt[0], xt[xt.length - 1], m.l + 8, W - m.r - 8), y = lin(yt[0], yt[yt.length - 1], H - m.b, m.t);
    yAxis(s, yt, y, m.l, W - m.r);
    const g = el(s, 'g', { class: 'axis' });
    el(g, 'line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: 'base' });
    for (const t of xt) el(g, 'text', { x: x(t), y: H - m.b + 16, 'text-anchor': 'middle' }, fmtNum(t));
    if (o.xLabel) el(g, 'text', { x: (m.l + W - m.r) / 2, y: H - 4, 'text-anchor': 'middle', class: 'lab' }, o.xLabel);
    if (o.fit) {
      const xa = xt[0], xb = xt[xt.length - 1];
      el(s, 'line', { x1: x(xa), x2: x(xb), y1: y(o.fit.a + o.fit.b * xa), y2: y(o.fit.a + o.fit.b * xb), class: 'fit' });
    }
    // jitter overlapping points slightly
    const seen = {};
    for (const p of pts) {
      const key = p.x + '|' + p.y;
      const k = seen[key] = (seen[key] || 0) + 1;
      const jx = k > 1 ? (k % 2 ? 1 : -1) * Math.ceil((k - 1) / 2) * 5 : 0;
      const gg = el(s, 'g', { 'data-tip': p.tip || `${fmtNum(p.x)}, ${fmtNum(p.y)}`, class: 'pt' });
      el(gg, 'circle', { cx: x(p.x) + jx, cy: y(p.y), r: 11, class: 'hit' });
      el(gg, 'circle', { cx: x(p.x) + jx, cy: y(p.y), r: 4.5, class: 'dot ' + (p.hl ? 's2' : 's1') });
    }
  }

  // Strip plot: groups [{label, pts:[{y, tip}]}]; draws dots + mean bar per group.
  function strip(host, o) {
    host.innerHTML = '';
    const W = widthOf(host), H = o.height || 260, m = { l: 46, r: 14, t: 12, b: 34 };
    const s = svg(W, H, 'st');
    host.appendChild(s);
    const all = o.groups.flatMap(g => g.pts.map(p => p.y));
    if (!all.length) return;
    const yt = niceTicks(Math.min(...all), Math.max(...all), 4);
    const y = lin(yt[0], yt[yt.length - 1], H - m.b, m.t);
    yAxis(s, yt, y, m.l, W - m.r);
    const bw = (W - m.l - m.r) / o.groups.length;
    o.groups.forEach((g, gi) => {
      const cx = m.l + bw * (gi + 0.5);
      const ax = el(s, 'g', { class: 'axis' });
      el(ax, 'text', { x: cx, y: H - 12, 'text-anchor': 'middle', class: 'lab' }, `${g.label} (n=${g.pts.length})`);
      const bins = {};
      g.pts.forEach(p => {
        const key = Math.round(y(p.y) / 6);
        const k = bins[key] = (bins[key] || 0) + 1;
        const jx = (k % 2 ? 1 : -1) * Math.floor(k / 2) * 9;
        const gg = el(s, 'g', { 'data-tip': p.tip, class: 'pt' });
        el(gg, 'circle', { cx: cx + jx, cy: y(p.y), r: 10, class: 'hit' });
        el(gg, 'circle', { cx: cx + jx, cy: y(p.y), r: 4.5, class: 'dot ' + (gi ? 's2' : 's1') });
      });
      if (g.pts.length) {
        const mu = g.pts.reduce((a, p) => a + p.y, 0) / g.pts.length;
        el(s, 'line', { x1: cx - Math.min(60, bw * 0.35), x2: cx + Math.min(60, bw * 0.35), y1: y(mu), y2: y(mu), class: 'meanbar' });
        el(s, 'text', { x: cx + Math.min(60, bw * 0.35) + 6, y: y(mu) + 4, class: 'meanlab' }, 'mean ' + fmtNum(mu));
      }
    });
  }

  // Horizontal diverging bars. items [{label, v, lo, hi, tip, sig, key}], v is "good"-oriented.
  function bars(host, o) {
    host.innerHTML = '';
    const items = o.items;
    const W = widthOf(host), rowH = 24, m = { l: Math.min(190, Math.max(110, W * 0.3)), r: 56, t: 22, b: 8 };
    const H = m.t + m.b + rowH * Math.max(1, items.length);
    const s = svg(W, H, 'bars');
    host.appendChild(s);
    const ext = o.domain || Math.max(0.5, ...items.map(i => Math.max(Math.abs(i.lo != null ? i.lo : i.v), Math.abs(i.hi != null ? i.hi : i.v))));
    const x = lin(-ext, ext, m.l, W - m.r);
    const ax = el(s, 'g', { class: 'axis' });
    const ticks = niceTicks(-ext, ext, 4).filter(t => Math.abs(t) <= ext + 1e-9);
    for (const t of ticks) {
      el(ax, 'line', { x1: x(t), x2: x(t), y1: m.t - 4, y2: H - m.b, class: t === 0 ? 'base' : 'grid' });
      el(ax, 'text', { x: x(t), y: m.t - 8, 'text-anchor': 'middle' }, fmtNum(t, 1));
    }
    items.forEach((it, k) => {
      const cy = m.t + rowH * k + rowH / 2;
      const g = el(s, 'g', { 'data-tip': it.tip, class: 'barrow' + (o.onClick ? ' clickable' : '') });
      el(g, 'rect', { x: 0, y: cy - rowH / 2, width: W, height: rowH, class: 'rowhit' });
      const label = it.label.length > 26 ? it.label.slice(0, 25) + '…' : it.label;
      el(g, 'text', { x: m.l - 8, y: cy + 4, 'text-anchor': 'end', class: 'rowlab' }, label);
      const x0 = x(0), x1 = x(Math.max(-ext, Math.min(ext, it.v)));
      const h = 12, r = 4;
      const left = Math.min(x0, x1), right = Math.max(x0, x1), wdt = right - left;
      const rr = Math.min(r, wdt / 2);
      let d;
      if (it.v >= 0) d = `M${left},${cy - h / 2}H${right - rr}Q${right},${cy - h / 2} ${right},${cy - h / 2 + rr}V${cy + h / 2 - rr}Q${right},${cy + h / 2} ${right - rr},${cy + h / 2}H${left}Z`;
      else d = `M${right},${cy - h / 2}H${left + rr}Q${left},${cy - h / 2} ${left},${cy - h / 2 + rr}V${cy + h / 2 - rr}Q${left},${cy + h / 2} ${left + rr},${cy + h / 2}H${right}Z`;
      el(g, 'path', { d, class: 'bar ' + (it.v >= 0 ? 'good' : 'bad') + (it.sig ? '' : ' faint') });
      if (it.lo != null && it.hi != null) {
        const a = x(Math.max(-ext, it.lo)), b = x(Math.min(ext, it.hi));
        el(g, 'line', { x1: a, x2: b, y1: cy, y2: cy, class: 'ci' });
        el(g, 'line', { x1: a, x2: a, y1: cy - 4, y2: cy + 4, class: 'ci' });
        el(g, 'line', { x1: b, x2: b, y1: cy - 4, y2: cy + 4, class: 'ci' });
      }
      el(g, 'text', { x: W - m.r + 6, y: cy + 4, class: 'val' }, fmtSigned(it.v, 2) + (it.sig ? ' •' : ''));
      if (o.onClick) g.addEventListener('click', () => o.onClick(it));
    });
  }

  function spark(vals, w, h) {
    w = w || 120; h = h || 32;
    const v = vals.map((y, i) => [i, y]).filter(p => p[1] != null);
    if (v.length < 2) return '';
    const ys = v.map(p => p[1]);
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const x = lin(0, vals.length - 1, 2, w - 4), y = lin(lo, hi, h - 3, 3);
    const d = v.map((p, k) => (k ? 'L' : 'M') + x(p[0]).toFixed(1) + ',' + y(p[1]).toFixed(1)).join('');
    const last = v[v.length - 1];
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path d="${d}" class="line s1 thin"/><circle cx="${x(last[0])}" cy="${y(last[1])}" r="3" class="dot s1"/></svg>`;
  }

  global.Charts = { initTooltip, showTip, hideTip, divColor, inkOn, timeSeries, scatter, strip, bars, spark, fmtNum, fmtSigned, fmtP, fmtDate, fmtDay, esc };
})(window);
