// CoML Engine: views, state and interactions.
(function () {
  'use strict';
  const D = CoMLData, S = Stats, C = Charts, esc = C.esc;
  const { fmtNum, fmtSigned, fmtP, fmtDate, fmtDay } = C;

  // ---------- Persistence (localStorage may be unavailable) ----------
  const LS = {
    get(k, def) { try { const v = localStorage.getItem('coml.' + k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
    set(k, v) { try { localStorage.setItem('coml.' + k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem('coml.' + k); } catch (e) { /* ignore */ } },
  };

  const DEFAULT_STATE = {
    view: 'impact', lag: 0, impTiming: 'best', impSort: 'evidence', impHideNoise: false, impAll: false, showSettings: false,
    rankDir: 'pos', rankSrc: 'tag', rankTiming: 'best', rankSort: 'evidence', rankMetric: '', rankSearch: '', minDays: 3, ranks: false, alpha: 0.05,
    controls: { trend: false, dose0: false, dose1: false },
    tag: null, tagMetric: null, metric: null, doseCol: null, doseMetric: null,
    heatSort: 'minp', heatSearch: '', heatOnlySig: false, nutKind: 'nutrient',
    exX: null, exY: null, theme: 'auto',
  };
  let state = Object.assign({}, DEFAULT_STATE, LS.get('state', {}));
  state.controls = Object.assign({}, DEFAULT_STATE.controls, state.controls);
  if (!LS.get('v2')) { state.view = 'impact'; LS.set('v2', 1); }
  const cfg = { roles: LS.get('roles', {}), dirs: LS.get('dirs', {}), aliases: LS.get('aliases', '') };
  let csv = LS.get('csv', null);
  let ds = null, buildError = null;
  const memo = new Map();

  const saveState = () => LS.set('state', Object.assign({}, state, { heatSearch: '', rankSearch: '' }));

  function rebuild() {
    memo.clear();
    ds = null; buildError = null;
    if (!csv) return;
    try { ds = D.build(csv.text, cfg); } catch (e) { buildError = e.message; }
    if (!ds) return;
    if (!ds.metrics.includes(state.metric)) state.metric = ds.metrics[0];
    if (!ds.metrics.includes(state.tagMetric)) state.tagMetric = ds.metrics[0];
    if (!ds.metrics.includes(state.doseMetric)) state.doseMetric = ds.metrics[0];
    if (!ds.doses.includes(state.doseCol)) state.doseCol = ds.doses[0] || null;
    if (!ds.tags.includes(state.tag)) state.tag = eligibleTags()[0] || ds.tags[0] || null;
    if (!state.exX || !ds.vars.has(state.exX)) state.exX = state.doseCol ? 'd:' + state.doseCol : 'm:' + ds.metrics[0];
    if (!state.exY || !ds.vars.has(state.exY)) state.exY = 'm:' + ds.metrics[0];
  }

  // ---------- Analysis helpers ----------
  const opts = () => ({ controls: state.controls, ranks: state.ranks });
  const optKey = () => JSON.stringify([state.controls, state.ranks, state.minDays]);
  const mv = m => ds.vars.get('m:' + m);
  const tv = t => ds.vars.get('t:' + t);
  const metricVars = () => ds.metrics.map(mv);
  const LAGS = ['Same day', 'Day before'];
  const lagName = l => (l === 0 ? 'same day' : l === 1 ? 'day before' : `${l} days before`);
  const dirLabel = v => (v.dir < 0 ? '↓ better' : '↑ better');

  function eligibleTags() {
    return ds.tags.filter(t => ds.tagFreq[t] >= state.minDays && ds.inputDays - ds.tagFreq[t] >= state.minDays);
  }

  function cached(key, fn) {
    const k = key + '|' + optKey();
    if (!memo.has(k)) memo.set(k, fn());
    return memo.get(k);
  }

  // Every eligible tag x every metric at lag 0 and 1, with BH q-values across the whole family.
  function tagEffects() {
    return cached('tagEffects', () => {
      const tags = eligibleTags(), ms = metricVars();
      const cells = { 0: new Map(), 1: new Map() };
      const all = [];
      for (const lag of [0, 1]) {
        for (const t of tags) {
          const row = ms.map(m => {
            const r = D.assoc(ds, tv(t), m, lag, opts());
            if (!r || r.n1 < state.minDays || r.n0 < state.minDays) return null;
            r.tag = t; r.metric = m.col; r.lag = lag; all.push(r);
            return r;
          });
          cells[lag].set(t, row);
        }
      }
      const q = S.bh(all.map(r => r.p));
      all.forEach((r, k) => { r.q = q[k]; });
      return { tags, ms, cells, all };
    });
  }

  // Continuous rows (nutrients/groups/metrics) vs metrics at a lag, q within the family.
  function contMatrix(kind, lag) {
    return cached(`cont|${kind}|${lag}`, () => {
      const rows = kind === 'metric' ? metricVars() : (kind === 'nutrient' ? ds.nutrients : ds.groups).map(c => ds.vars.get((kind === 'nutrient' ? 'n:' : 'g:') + c));
      const ms = metricVars();
      const all = [];
      const cells = new Map();
      for (const rv of rows) {
        cells.set(rv.id, ms.map(m => {
          if (kind === 'metric' && lag === 0 && rv.id === m.id) return null;
          const r = D.assoc(ds, rv, m, lag, opts());
          if (r) all.push(r);
          return r;
        }));
      }
      const q = S.bh(all.map(r => r.p));
      all.forEach((r, k) => { r.q = q[k]; });
      return { rows, ms, cells };
    });
  }

  const isSig = r => r && r.p < state.alpha;

  function effTip(r, xLabel, yv) {
    if (!r) return 'Not enough data';
    const head = `<b>${esc(xLabel)}</b> → <b>${esc(yv.col)}</b> <span class="muted">(${esc(yv.name)}, ${dirLabel(yv)})</span>`;
    const lagTxt = r.lag != null ? `<div class="muted">${r.lag === 0 ? 'Input on the same day' : 'Input on the day before'}</div>` : '';
    let body;
    if (r.binary) {
      body = `<div>With: <b>${fmtNum(r.m1)}</b> (${r.n1} d) · Without: <b>${fmtNum(r.m0)}</b> (${r.n0} d)</div>` +
        `<div>Effect: ${state.ranks ? '' : fmtSigned(r.coef) + ' · '}d = ${fmtSigned(r.d, 2)}</div>`;
    } else {
      body = `<div>r = ${fmtSigned(r.r, 2)} · n = ${r.n}</div>`;
    }
    const verdict = r.good > 0 ? 'better' : r.good < 0 ? 'worse' : 'no change';
    return `${head}${lagTxt}${body}<div>p = ${fmtP(r.p)}${r.q != null && isFinite(r.q) ? ' · q = ' + fmtP(r.q) : ''} · <b>${verdict}</b></div>`;
  }

  function effBar(good, sig) {
    if (good == null || !isFinite(good)) return '<span class="eff"></span>';
    const w = Math.min(1, Math.abs(good) / 1.5) * 50;
    const style = good >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`;
    return `<span class="eff"><span class="eff-bar ${good >= 0 ? 'good' : 'bad'}${sig ? '' : ' faint'}" style="${style}"></span></span>`;
  }

  function rolling(vals, days, win) {
    const out = [];
    for (let i = 0; i < days.length; i++) {
      const t = days[i].t;
      const w = [];
      for (let j = i; j >= 0 && t - days[j].t < win * D.DAY; j--) if (vals[j] != null) w.push(vals[j]);
      if (w.length >= Math.min(3, win) && vals[i] != null) out.push({ t, y: S.mean(w) });
    }
    return out;
  }

  function tagsOf(i, max) {
    const d = ds.days[i];
    if (!d.hasInput) return '<span class="muted">no input logged</span>';
    const t = [...d.tags];
    const shown = t.slice(0, max || 14).map(esc).join(', ');
    return shown + (t.length > (max || 14) ? ` <span class="muted">+${t.length - (max || 14)}</span>` : '');
  }

  function dayTip(i, label, value) {
    return `<b>${fmtDay(ds.days[i].t)}</b>${label ? `<div>${esc(label)}: <b>${fmtNum(value)}</b></div>` : ''}<div class="tags-tip">${tagsOf(i)}</div>`;
  }

  const tile = (label, value, sub) => `<div class="tile"><div class="tile-l">${label}</div><div class="tile-v">${value}</div>${sub ? `<div class="tile-s">${sub}</div>` : ''}</div>`;
  const tagLink = t => `<button class="link" data-act="go-tag" data-v="${esc(t)}">${esc(t)}</button>`;
  const metricLink = m => `<button class="link" data-act="go-metric" data-v="${esc(m)}">${esc(m)}</button>`;
  const seg = (key, options, cur) => `<div class="seg" role="group">${options.map(([v, l]) => `<button class="${String(v) === String(cur) ? 'on' : ''}" data-act="set" data-k="${key}" data-v="${esc(String(v))}">${esc(l)}</button>`).join('')}</div>`;
  const metricChips = (key, cur) => `<div class="chips">${ds.metrics.map(m => `<button class="chip ${m === cur ? 'on' : ''}" data-act="set" data-k="${key}" data-v="${esc(m)}" title="${esc(mv(m).name)}">${esc(m)}</button>`).join('')}</div>`;

  function section(title, sub, body, extra) {
    return `<section class="card ${extra || ''}"><header><h2>${title}</h2>${sub ? `<p class="sub">${sub}</p>` : ''}</header>${body}</section>`;
  }

  // ---------- Views ----------
  const VIEWS = [
    ['impact', 'Impact'], ['rank', 'Rankings'], ['overview', 'Overview'], ['heat', 'Tags × Metrics'], ['tag', 'Tag'], ['metric', 'Metric'],
    ['dose', 'Kratom'], ['corr', 'Metric links'], ['nutr', 'Nutrients & groups'], ['explore', 'Explorer'], ['data', 'Data'],
  ];

  function renderNav() {
    const nav = document.getElementById('nav');
    nav.innerHTML = VIEWS.map(([k, l]) => `<button class="${state.view === k ? 'on' : ''}" data-act="view" data-v="${k}" ${!ds && k !== 'data' ? 'disabled' : ''}>${l === 'Kratom' && ds && ds.doses[0] && !/kratom/i.test(ds.doses[0]) ? 'Dose' : l}</button>`).join('');
  }

  const OWN_TIMING = ['impact', 'rank'];

  function renderControls() {
    const el = document.getElementById('controls');
    if (!ds || state.view === 'data' || (OWN_TIMING.includes(state.view) && !state.showSettings)) { el.innerHTML = ''; el.hidden = true; return; }
    el.hidden = false;
    const dose = ds.doses[0];
    el.innerHTML = `
      ${OWN_TIMING.includes(state.view) ? '' : `<div class="ctl"><span class="ctl-l">Input timing</span>${seg('lag', [[0, 'Same day'], [1, 'Day before']], state.lag)}</div>`}
      <div class="ctl"><span class="ctl-l">Adjust for</span>
        <label class="chk"><input type="checkbox" data-bind="controls.trend" ${state.controls.trend ? 'checked' : ''}> Time trend</label>
        ${dose ? `<label class="chk"><input type="checkbox" data-bind="controls.dose0" ${state.controls.dose0 ? 'checked' : ''}> ${esc(dose)} same day</label>
        <label class="chk"><input type="checkbox" data-bind="controls.dose1" ${state.controls.dose1 ? 'checked' : ''}> ${esc(dose)} day before</label>` : ''}
      </div>
      <div class="ctl"><label class="chk" title="Use ranks instead of raw values: robust to outliers (Spearman-style)"><input type="checkbox" data-bind="ranks" ${state.ranks ? 'checked' : ''}> Rank-based</label></div>
      <div class="ctl"><span class="ctl-l">Min. days</span><input type="number" min="1" max="50" value="${state.minDays}" data-bind="minDays" class="num" title="A tag needs at least this many days with AND without it"></div>
      <div class="ctl"><span class="ctl-l">Significance</span><select data-bind="alpha">${[0.01, 0.05, 0.1].map(a => `<option value="${a}" ${state.alpha === a ? 'selected' : ''}>p &lt; ${a}</option>`).join('')}</select></div>`;
  }

  function render() {
    renderNav();
    renderControls();
    const main = document.getElementById('main');
    if (!ds && state.view !== 'data') state.view = 'data';
    const fn = { impact: vImpact, rank: vRank, overview: vOverview, heat: vHeat, tag: vTag, metric: vMetric, dose: vDose, corr: vCorr, nutr: vNutr, explore: vExplore, data: vData }[state.view];
    main.innerHTML = '';
    fn(main);
    bindUpload();
    saveState();
  }

  // ---- Impact: what improves / worsens one metric ----
  const EVIDENCE = [
    [0.01, 3, 'strong'], [0.05, 2, 'moderate'], [0.15, 1, 'weak'], [Infinity, 0, 'likely noise'],
  ];
  const evidenceOf = p => EVIDENCE.find(e => p < e[0]);
  const evDots = ev => `<span class="evd">${'●'.repeat(ev[1])}${'○'.repeat(3 - ev[1])} ${ev[2]}</span>`;

  function vImpact(main) {
    const m = mv(state.metric);
    const eff = tagEffects();
    const k = eff.ms.findIndex(x => x.id === m.id);
    const timing = state.impTiming;
    const items = [];
    for (const t of eff.tags) {
      const r0 = eff.cells[0].get(t)[k], r1 = eff.cells[1].get(t)[k];
      const r = timing === 'best' ? [r0, r1].filter(Boolean).sort((a, b) => a.p - b.p)[0] : timing === '0' ? r0 : r1;
      if (r && r.good !== 0) items.push({ t, r });
    }
    const byEvidence = (a, b) => a.r.p - b.r.p;
    const bySize = (a, b) => Math.abs(b.r.good) - Math.abs(a.r.good);
    const keep = i => !state.impHideNoise || i.r.p < 0.15;
    const sorter = state.impSort === 'size' ? bySize : byEvidence;
    const pos = items.filter(i => i.r.good > 0 && keep(i)).sort(sorter);
    const neg = items.filter(i => i.r.good < 0 && keep(i)).sort(sorter);
    const N = state.impAll ? Infinity : 10;
    const shown = [...pos.slice(0, N), ...neg.slice(0, N)];
    const maxD = Math.max(0.5, ...shown.map(i => Math.abs(i.r.d)));
    const units = !state.ranks;
    const when = lag => (lag === 0 ? 'same day' : 'the day after');

    const item = ({ t, r }) => {
      const ev = evidenceOf(r.p);
      const good = r.good > 0;
      return `<button class="imp-item ev${ev[1]}" data-act="go-tag" data-v="${esc(t)}" data-tip="${esc(effTip(r, t, m))}">
        <span class="imp-top"><span class="imp-tag">${esc(t)}</span><span class="imp-eff"><span class="imp-arrow ${good ? 'good' : 'bad'}">${good ? '▲' : '▼'}</span>${units ? fmtSigned(r.coef) : fmtSigned(r.d, 2) + ' SD'}</span></span>
        <span class="imp-bar"><span class="${good ? 'good' : 'bad'}" style="width:${Math.max(3, 100 * Math.abs(r.d) / maxD)}%"></span></span>
        <span class="imp-meta"><span>${when(r.lag)} · ${fmtNum(r.m1)} vs ${fmtNum(r.m0)} · ${r.n1} days</span>${evDots(ev)}</span>
      </button>`;
    };
    const col = (list, good) => `<section class="card imp-col">
        <header><h2><span class="imp-arrow ${good ? 'good' : 'bad'}">${good ? '▲' : '▼'}</span> ${good ? 'Improves' : 'Worsens'} ${esc(m.name)}</h2>
        <p class="sub">${list.length} tag${list.length === 1 ? '' : 's'}${list.length > N ? ` · top ${N} shown` : ''}</p></header>
        ${list.length ? list.slice(0, N).map(item).join('') : '<p class="muted">Nothing here yet.</p>'}
      </section>`;

    let doseHtml = '';
    if (ds.doses[0]) {
      const dv = ds.vars.get('d:' + ds.doses[0]);
      const lags = timing === 'best' ? [0, 1] : [+timing];
      const r = lags.map(l => { const a = D.assoc(ds, dv, m, l, opts()); if (a) a.lag = l; return a; }).filter(Boolean).sort((a, b) => a.p - b.p)[0];
      if (r) {
        const good = r.good > 0;
        doseHtml = `<div class="imp-dose" data-tip="${esc(effTip(r, dv.col, m))}"><span class="imp-arrow ${good ? 'good' : 'bad'}">${good ? '▲' : '▼'}</span>
          <span><b>${esc(dv.col)}</b>: each +1 → ${esc(m.col)} ${units ? fmtSigned(r.coef, 2) : `r = ${fmtSigned(r.r, 2)}`} (${when(r.lag)}) · ${good ? 'better' : 'worse'}</span>
          ${evDots(evidenceOf(r.p))}</div>`;
      }
    }

    const adj = [state.controls.trend && 'time trend', state.controls.dose0 && ds.doses[0] + ' same day', state.controls.dose1 && ds.doses[0] + ' day before'].filter(Boolean);
    main.innerHTML = `
      <div class="imp-head">
        <h2 class="imp-title">What affects ${esc(m.name)}${m.name !== m.col ? ` <span class="muted">(${esc(m.col)})</span>` : ''}</h2>
        <p class="sub">${dirLabel(m)}${m.desc ? ' · ' + esc(m.desc) : ''} · average ${fmtNum(S.mean(m.vals.filter(v => v != null)))}</p>
      </div>
      ${metricChips('metric', m.col)}
      <div class="toolbar">
        <span class="ctl-l">Timing</span>${seg('impTiming', [['best', 'Both'], ['0', 'Same day'], ['1', 'Day after']], timing)}
        <span class="ctl-l">Rank by</span>${seg('impSort', [['evidence', 'Most reliable'], ['size', 'Biggest effect']], state.impSort)}
        <label class="chk"><input type="checkbox" data-bind="impHideNoise" ${state.impHideNoise ? 'checked' : ''}> Hide likely noise</label>
        <span class="grow"></span>
        <button class="btn" data-act="toggle-settings">⚙ Settings${adj.length || state.ranks ? ' •' : ''}</button>
      </div>
      ${doseHtml}
      <div class="imp-cols">${col(pos, true)}${col(neg, false)}</div>
      ${pos.length > 10 || neg.length > 10 ? `<div class="center"><button class="btn" data-act="set" data-k="impAll" data-v="${state.impAll ? '' : '1'}">${state.impAll ? 'Show top 10' : 'Show all tags'}</button></div>` : ''}
      <p class="small muted">The number is the change in ${esc(m.col)} on days with the tag (“same day”) or on the day after it, compared with days without it. ${timing === 'best' ? '“Both” uses whichever timing shows the clearer effect for each tag. ' : ''}Evidence: ●●● strong · ●●○ moderate · ●○○ weak – how unlikely the difference is to be chance. Tags need ≥${state.minDays} days with and without${adj.length ? ` · adjusted for ${esc(adj.join(', '))}` : ''}. Click a tag for details.</p>`;
  }

  // ---- Rankings: every input x metric link, best first ----
  const SOURCES = { tag: ['Tags', 'tag'], dose: ['Kratom', 'dose'], group: ['Food groups', 'food group'], nutrient: ['Nutrients', 'nutrient'] };

  function rankRows() {
    const src = state.rankSrc, timing = state.rankTiming;
    const ms = metricVars();
    const pick = (r0, r1) => (timing === 'best' ? [r0, r1].filter(Boolean).sort((a, b) => a.p - b.p)[0] : timing === '0' ? r0 : r1);
    const rows = [];
    const add = (label, id, m, r) => { if (r) rows.push({ label, id, m, r }); };
    if (src === 'tag') {
      const eff = tagEffects();
      for (const t of eff.tags) ms.forEach((m, k) => add(t, 't:' + t, m, pick(eff.cells[0].get(t)[k], eff.cells[1].get(t)[k])));
    } else if (src === 'dose') {
      for (const d of ds.doses) {
        const dv = ds.vars.get('d:' + d);
        ms.forEach(m => {
          const [a, b] = [0, 1].map(l => { const x = D.assoc(ds, dv, m, l, opts()); if (x) x.lag = l; return x; });
          add(d, dv.id, m, pick(a, b));
        });
      }
    } else {
      const M = [contMatrix(src, 0), contMatrix(src, 1)];
      M[0].rows.forEach(rv => ms.forEach((m, k) => {
        const [a, b] = M.map((mx, l) => { const x = mx.cells.get(rv.id)[k]; if (x) x.lag = l; return x; });
        add(rv.col, rv.id, m, pick(a, b));
      }));
    }
    return rows;
  }

  function vRank(main) {
    const pos = state.rankDir === 'pos';
    const q = state.rankSearch.trim().toLowerCase();
    const size = r => Math.abs(r.binary ? r.d : r.r);
    let rows = rankRows().filter(x => (pos ? x.r.good > 0 : x.r.good < 0));
    const total = rows.length;
    if (state.rankMetric) rows = rows.filter(x => x.m.col === state.rankMetric);
    if (q) rows = rows.filter(x => x.label.toLowerCase().includes(q));
    const byEvidence = state.rankSort === 'evidence';
    rows.sort(byEvidence ? (a, b) => a.r.p - b.r.p : (a, b) => size(b.r) - size(a.r));
    const maxSize = Math.max(0.3, ...rows.map(x => size(x.r)));
    const units = !state.ranks;
    const tiers = EVIDENCE.map(e => rows.filter(x => evidenceOf(x.r.p) === e).length);

    let lastTier = null;
    const body = rows.map((x, i) => {
      const { r, m } = x;
      const ev = evidenceOf(r.p);
      let head = '';
      if (byEvidence && ev !== lastTier) {
        lastTier = ev;
        head = `<tr class="tier"><td colspan="9">${'●'.repeat(ev[1])}${'○'.repeat(3 - ev[1])} ${ev[2] === 'likely noise' ? 'Likely noise' : ev[2][0].toUpperCase() + ev[2].slice(1) + ' evidence'} <span class="muted">· ${tiers[EVIDENCE.indexOf(ev)]}</span></td></tr>`;
      }
      const act = x.id.startsWith('t:') ? `data-act="go-tag" data-v="${esc(x.label)}"` : `data-act="explore" data-x="${esc(x.id)}" data-y="${esc(m.id)}"`;
      const effect = r.binary ? (units ? fmtSigned(r.coef) : fmtSigned(r.d, 2) + ' SD') : `r ${fmtSigned(r.r, 2)}`;
      const detail = r.binary ? `${fmtNum(r.m1)} vs ${fmtNum(r.m0)}` : (units ? `${fmtSigned(r.coef, 2)} per +1` : '');
      return `${head}<tr class="clickable ev${ev[1]}" ${act} data-tip="${esc(effTip(r, x.label, m))}">
        <td class="num muted">${i + 1}</td>
        <td class="rk-in">${esc(x.label)}</td>
        <td class="nowrap"><b>${esc(m.col)}</b> <span class="muted small">${esc(m.name !== m.col ? m.name : '')}</span></td>
        <td class="rk-eff"><span class="imp-arrow ${pos ? 'good' : 'bad'}">${pos ? '▲' : '▼'}</span> ${effect}</td>
        <td class="rk-bar"><span class="imp-bar"><span class="${pos ? 'good' : 'bad'}" style="width:${Math.max(2, 100 * size(r) / maxSize)}%"></span></span></td>
        <td class="num nowrap">${detail}</td>
        <td class="muted nowrap">${r.lag === 0 ? 'same day' : 'day after'}</td>
        <td class="num muted">${r.binary ? r.n1 + ' d' : 'n ' + r.n}</td>
        <td>${evDots(ev)}</td></tr>`;
    }).join('');

    const srcOpts = Object.entries(SOURCES).filter(([k]) => (k === 'tag' ? ds.tags.length : k === 'dose' ? ds.doses.length : k === 'group' ? ds.groups.length : ds.nutrients.length))
      .map(([k, v]) => [k, k === 'dose' && ds.doses[0] && !/kratom/i.test(ds.doses[0]) ? 'Dose' : v[0]]);
    main.innerHTML = `
      <div class="imp-head">
        <h2 class="imp-title">${pos ? 'Strongest positive links' : 'Strongest negative links'}</h2>
        <p class="sub">Every ${esc(SOURCES[state.rankSrc][1])} → metric link that ${pos ? '<b>improves</b>' : '<b>worsens</b>'} a metric, across all metrics, best first. “Positive” means better for that metric (e.g. lower resting HR counts as positive).</p>
      </div>
      <div class="toolbar">
        ${seg('rankDir', [['pos', '▲ Positive'], ['neg', '▼ Negative']], state.rankDir)}
        ${seg('rankSrc', srcOpts, state.rankSrc)}
      </div>
      <div class="toolbar">
        <span class="ctl-l">Timing</span>${seg('rankTiming', [['best', 'Both'], ['0', 'Same day'], ['1', 'Day after']], state.rankTiming)}
        <span class="ctl-l">Rank by</span>${seg('rankSort', [['evidence', 'Most reliable'], ['size', 'Biggest effect']], state.rankSort)}
        <select data-bind="rankMetric"><option value="">All metrics</option>${ds.metrics.map(c => `<option value="${esc(c)}" ${c === state.rankMetric ? 'selected' : ''}>${esc(c)}${mv(c).name !== c ? ' – ' + esc(mv(c).name) : ''}</option>`).join('')}</select>
        <input type="search" class="search" placeholder="Filter ${esc(SOURCES[state.rankSrc][0].toLowerCase())}…" value="${esc(state.rankSearch)}" data-bind="rankSearch">
        <span class="grow"></span>
        <button class="btn" data-act="toggle-settings">⚙ Settings</button>
      </div>
      <p class="small muted">${rows.length}${rows.length !== total ? ` of ${total}` : ''} links · ${EVIDENCE.map((e, k) => `${tiers[k]} ${e[2]}`).join(' · ')}</p>
      <section class="card rk"><div class="tablewrap"><table class="tbl rk-tbl">
        <thead><tr><th class="num">#</th><th>${esc(SOURCES[state.rankSrc][1][0].toUpperCase() + SOURCES[state.rankSrc][1].slice(1))}</th><th>Metric</th><th>Effect</th><th></th><th class="num">${state.rankSrc === 'tag' ? 'With vs without' : 'Slope'}</th><th>Timing</th><th class="num">Days</th><th>Evidence</th></tr></thead>
        <tbody>${body || '<tr><td colspan="9" class="muted">No links match.</td></tr>'}</tbody></table></div></section>
      <p class="small muted">Effect = change in the metric (tags: with vs without; others: correlation r). “Both” timing keeps, for each pair, whichever of same day / day after is clearer. Click a row for details.</p>`;
  }

  // ---- Overview ----
  function vOverview(main) {
    const days = ds.days;
    const eff = tagEffects();
    const dose = ds.doses[0] ? ds.vars.get('d:' + ds.doses[0]) : null;
    const doseVals = dose ? dose.vals.filter(v => v != null) : [];
    const last7 = dose ? dose.vals.slice(-7).filter(v => v != null) : [];
    const nSig = eff.all.filter(r => r.p < state.alpha).length;
    const nQ = eff.all.filter(r => r.q < 0.1).length;
    const expected = eff.all.length * state.alpha;

    const top = [...eff.all].sort((a, b) => a.p - b.p).slice(0, 15);
    const rows = top.map(r => {
      const m = mv(r.metric);
      return `<tr data-tip="${esc(effTip(r, r.tag, m))}">
        <td>${tagLink(r.tag)}</td><td class="muted">${lagName(r.lag)}</td><td>${metricLink(r.metric)} <span class="muted small">${dirLabel(m)}</span></td>
        <td class="num">${fmtNum(r.m1)}</td><td class="num">${fmtNum(r.m0)}</td>
        <td class="effcell">${effBar(r.good, true)}<span class="num">${fmtSigned(r.d, 2)}</span></td>
        <td class="num">${fmtP(r.p)}</td><td class="num">${fmtP(r.q)}</td><td class="num muted">${r.n1}/${r.n0}</td></tr>`;
    }).join('');

    const cards = metricVars().map(m => {
      const v = m.vals.filter(x => x != null);
      const lastI = m.vals.map((x, i) => [x, i]).filter(p => p[0] != null).pop();
      const recent = m.vals.slice(-7).filter(x => x != null);
      const delta = recent.length && v.length ? S.mean(recent) - S.mean(v) : NaN;
      const good = m.dir * delta;
      return `<button class="mcard" data-act="go-metric" data-v="${esc(m.col)}">
        <div class="mcard-h"><b>${esc(m.col)}</b><span class="muted small">${esc(m.name !== m.col ? m.name : '')}</span></div>
        <div class="mcard-v">${lastI ? fmtNum(lastI[0]) : '–'}<span class="muted small"> latest</span></div>
        ${C.spark(m.vals)}
        <div class="small muted">mean ${fmtNum(S.mean(v))} · n ${v.length}${isFinite(delta) ? ` · 7d ${fmtSigned(delta)} <span class="${good > 0 ? 'up' : good < 0 ? 'down' : ''}">${good > 0 ? '▲' : good < 0 ? '▼' : ''}</span>` : ''}</div>
      </button>`;
    }).join('');

    main.innerHTML = `
      <div class="tiles">
        ${tile('Days tracked', days.length, `${fmtDate(days[0].t, true)} – ${fmtDate(days[days.length - 1].t, true)}`)}
        ${tile('Tags', ds.tags.length, `${eff.tags.length} analysable (≥${state.minDays} days with and without)`)}
        ${tile('Metrics', ds.metrics.length, `${ds.nutrients.length} nutrients · ${ds.groups.length} groups`)}
        ${dose ? tile(esc(dose.col) + ' avg', fmtNum(S.mean(doseVals), 1), `last 7 days ${fmtNum(S.mean(last7), 1)} · range ${fmtNum(Math.min(...doseVals))}–${fmtNum(Math.max(...doseVals))}`) : ''}
      </div>
      <div class="note"><b>Read with care.</b> ${eff.all.length} tag→metric tests were run; at p &lt; ${state.alpha} about <b>${Math.round(expected)}</b> would look "significant" by pure chance. Found <b>${nSig}</b>. ${nQ ? `<b>${nQ}</b> survive a false-discovery check (q &lt; 0.1).` : 'None survive the false-discovery check (q &lt; 0.1) yet – more days will sharpen this.'} Correlation is not causation: check co-occurring tags on each tag's page.</div>
      ${section('Strongest tag signals', 'Lowest p-values across all tags, both timings. d = difference in standard deviations (sign as measured). Bar colour: blue = better, red = worse.',
        `<div class="tablewrap"><table class="tbl"><thead><tr><th>Tag</th><th>Timing</th><th>Metric</th><th class="num">With</th><th class="num">Without</th><th>Effect (d)</th><th class="num">p</th><th class="num">q</th><th class="num">Days</th></tr></thead><tbody>${rows || '<tr><td colspan="9" class="muted">Not enough data</td></tr>'}</tbody></table></div>`)}
      ${section('Metrics', 'Latest value, trend and last-7-day average vs overall. Click for details.', `<div class="mgrid">${cards}</div>`)}`;
  }

  // ---- Heatmap ----
  function vHeat(main) {
    const eff = tagEffects();
    const lag = state.lag;
    const ms = eff.ms;
    let tags = eff.tags.filter(t => !state.heatSearch || t.includes(state.heatSearch.toLowerCase()));
    const row = t => eff.cells[lag].get(t);
    if (state.heatOnlySig) tags = tags.filter(t => row(t).some(isSig));
    const minp = t => Math.min(...row(t).map(r => (r ? r.p : 1)));
    const srt = state.heatSort;
    if (srt === 'freq') tags.sort((a, b) => ds.tagFreq[b] - ds.tagFreq[a]);
    else if (srt === 'az') tags.sort();
    else if (srt.startsWith('m:')) {
      const [, col, ord] = srt.split('|');
      const k = ms.findIndex(m => m.col === col);
      const g = t => (row(t)[k] ? row(t)[k].good : (ord === 'desc' ? -9 : 9));
      tags.sort((a, b) => (ord === 'desc' ? g(b) - g(a) : g(a) - g(b)));
    } else tags.sort((a, b) => minp(a) - minp(b));

    const sortCol = srt.startsWith('m:') ? srt.split('|') : null;
    const head = `<div class="hh corner">Tag <span class="muted small">(days)</span></div>` + ms.map(m => {
      const on = sortCol && sortCol[1] === m.col;
      const next = on && sortCol[2] === 'desc' ? 'asc' : 'desc';
      return `<button class="hh col ${on ? 'on' : ''}" data-act="set" data-k="heatSort" data-v="m:|${esc(m.col)}|${next}" data-tip="<b>${esc(m.col)}</b> – ${esc(m.name)}<br>${dirLabel(m)}<br><span class='muted'>Click to sort tags by effect on this metric</span>">${esc(m.col)}${on ? (sortCol[2] === 'desc' ? ' ▾' : ' ▴') : ''}</button>`;
    }).join('');
    const body = tags.map(t => {
      const cells = row(t).map((r, k) => {
        if (!r) return `<div class="hc na" data-tip="Not enough data"></div>`;
        const sig = isSig(r);
        const bg = C.divColor((state.heatOnlySig && !sig) ? 0 : (r.good / 1.2) * (sig ? 1 : 0.45));
        return `<div class="hc${sig ? ' sig' : ''}" style="background:${bg};color:${C.inkOn(bg)}" data-tip="${esc(effTip(r, t, ms[k]))}" data-act="go-tag" data-v="${esc(t)}">${sig ? fmtSigned(r.d, 1) : ''}</div>`;
      }).join('');
      return `<button class="hr" data-act="go-tag" data-v="${esc(t)}"><span>${esc(t)}</span><span class="muted small">${ds.tagFreq[t]}</span></button>${cells}`;
    }).join('');

    main.innerHTML = section(`Tags × Metrics <span class="muted">· ${LAGS[lag].toLowerCase()}</span>`,
      `Each cell compares days ${lag === 0 ? 'with' : 'after'} the tag vs days without. Colour = effect in standard deviations, oriented so <b>blue = better</b> and <b>red = worse</b> for that metric. Numbers are shown where p &lt; ${state.alpha}.`,
      `<div class="toolbar">
        <input type="search" placeholder="Filter tags…" value="${esc(state.heatSearch)}" data-bind="heatSearch" class="search">
        <span class="ctl-l">Sort</span>${seg('heatSort', [['minp', 'Strongest'], ['freq', 'Frequency'], ['az', 'A–Z']], srt.startsWith('m:') ? '' : srt)}
        <label class="chk"><input type="checkbox" data-bind="heatOnlySig" ${state.heatOnlySig ? 'checked' : ''}> Only rows with a significant cell</label>
        <span class="grow"></span>
        <button class="btn" data-act="export-effects">Export CSV</button>
      </div>
      <div class="legend"><span>worse</span><span class="ramp"></span><span>better</span><span class="muted small">(±1.2 SD saturates; non-significant cells are muted)</span><span class="lg-sig">±0.8</span><span class="muted small">= significant</span><span class="muted small">· ${tags.length} tags</span></div>
      <div class="heatwrap"><div class="heat" style="grid-template-columns:minmax(130px,190px) repeat(${ms.length},minmax(44px,1fr))">${head}${body}</div></div>
      ${eff.tags.length < ds.tags.length ? `<p class="small muted">${ds.tags.length - eff.tags.length} tags hidden because they appear on fewer than ${state.minDays} days, or are missing on fewer than ${state.minDays} days (e.g. taken daily). Change “Min. days” above.</p>` : ''}`);
    const ramp = main.querySelector('.ramp');
    ramp.style.background = `linear-gradient(90deg, ${[-1, -0.5, 0, 0.5, 1].map(C.divColor).join(',')})`;
    const s = main.querySelector('.lg-sig');
    const bg = C.divColor(0.8 / 1.2); s.style.background = bg; s.style.color = C.inkOn(bg);
  }

  function exportEffects() {
    const eff = tagEffects();
    const lines = [['tag', 'timing', 'metric', 'days_with', 'days_without', 'mean_with', 'mean_without', 'effect', 'd', 'p', 'q', 'better_or_worse'].join(',')];
    for (const r of eff.all) {
      lines.push([`"${r.tag.replace(/"/g, '""')}"`, lagName(r.lag), r.metric, r.n1, r.n0, r.m1.toFixed(3), r.m0.toFixed(3), r.coef.toFixed(3), r.d.toFixed(3), r.p.toFixed(5), r.q.toFixed(5), r.good > 0 ? 'better' : 'worse'].join(','));
    }
    download('coml-tag-effects.csv', lines.join('\n'));
  }

  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---- Tag detail ----
  function vTag(main) {
    if (!ds.tags.includes(state.tag)) state.tag = eligibleTags()[0] || ds.tags[0];
    const t = state.tag;
    const v = tv(t);
    const eff = tagEffects();
    const eligible = eff.cells[0].has(t);
    const freq = ds.tagFreq[t] || 0;
    const tagDays = ds.days.filter(d => d.tags.has(t));
    const lastUsed = tagDays.length ? tagDays[tagDays.length - 1].t : null;
    const ms = metricVars();

    const res = ms.map((m, k) => [0, 1].map(lag => (eligible ? eff.cells[lag].get(t)[k] : D.assoc(ds, v, m, lag, opts()))));
    const cellHtml = (r, m) => r ? `<td class="num">${fmtNum(r.m1)}</td><td class="num">${fmtNum(r.m0)}</td><td class="effcell" data-tip="${esc(effTip(Object.assign({}, r), t, m))}">${effBar(r.good, isSig(r))}<span class="num">${fmtSigned(r.d, 2)}</span></td><td class="num ${isSig(r) ? 'b' : 'muted'}">${fmtP(r.p)}</td>`
      : '<td class="muted" colspan="4">not enough data</td>';
    const rows = ms.map((m, k) => `<tr class="clickable ${m.col === state.tagMetric ? 'sel' : ''}" data-act="set" data-k="tagMetric" data-v="${esc(m.col)}">
      <td><b>${esc(m.col)}</b> <span class="muted small">${esc(m.name !== m.col ? m.name : '')} ${dirLabel(m)}</span></td>
      ${cellHtml(res[k][0], m)}${cellHtml(res[k][1], m)}</tr>`).join('');

    // co-occurrence
    const inDays = ds.days.filter(d => d.hasInput);
    const co = ds.tags.filter(u => u !== t && ds.tagFreq[u] >= 2).map(u => {
      const x = inDays.map(d => (d.tags.has(t) ? 1 : 0)), y = inDays.map(d => (d.tags.has(u) ? 1 : 0));
      const both = inDays.filter(d => d.tags.has(t) && d.tags.has(u)).length;
      return { u, phi: S.pearson(x, y), both };
    }).filter(c => isFinite(c.phi)).sort((a, b) => b.phi - a.phi).slice(0, 10);
    const coRows = co.map(c => `<tr><td>${tagLink(c.u)}</td><td class="num">${fmtNum(c.phi, 2)}</td><td class="num">${c.both}/${freq}</td><td>${c.phi > 0.6 ? '<span class="pill warn">⚠ hard to separate</span>' : c.phi > 0.4 ? '<span class="pill">often together</span>' : ''}</td></tr>`).join('');

    let doseCmp = '';
    if (ds.doses[0]) {
      const dv = ds.vars.get('d:' + ds.doses[0]);
      const a = [], b = [];
      ds.days.forEach((d, i) => { if (dv.vals[i] != null && d.hasInput) (d.tags.has(t) ? a : b).push(dv.vals[i]); });
      if (a.length && b.length) doseCmp = `<p class="small">${esc(dv.col)} on days with this tag: <b>${fmtNum(S.mean(a), 1)}</b> vs without: <b>${fmtNum(S.mean(b), 1)}</b>${Math.abs(S.mean(a) - S.mean(b)) > 0.5 * (S.sd([...a, ...b]) || 1) ? ' – <b>noticeably different</b>, consider ticking “adjust for dose”.' : '.'}</p>`;
    }

    const cal = ds.days.map(d => `<span class="calday ${!d.hasInput ? 'na' : d.tags.has(t) ? 'on' : ''}" data-tip="${esc(fmtDay(d.t) + (d.tags.has(t) ? ' – <b>' + esc(t) + '</b>' + (d.tagCounts[t] > 1 ? ' ×' + d.tagCounts[t] : '') : ''))}"></span>`).join('');
    const m = mv(state.tagMetric);

    main.innerHTML = `
      <div class="pickerbar">
        <label class="ctl-l" for="tagpick">Tag</label>
        <input id="tagpick" list="taglist" value="${esc(t || '')}" data-bind="tag" class="search" autocomplete="off">
        <datalist id="taglist">${ds.tags.map(x => `<option value="${esc(x)}">${ds.tagFreq[x]} days</option>`).join('')}</datalist>
        <span class="muted small">${eligible ? '' : `Not in the main analysis (needs ≥${state.minDays} days with and without) – results below are indicative only.`}</span>
      </div>
      <div class="tiles">
        ${tile('Days used', `${freq}<span class="muted small"> / ${ds.inputDays}</span>`, `${fmtNum(100 * freq / ds.inputDays, 0)}% of logged days`)}
        ${tile('Last used', lastUsed ? fmtDate(lastUsed, true) : '–', tagDays.length ? `first ${fmtDate(tagDays[0].t, true)}` : '')}
        ${tile('Significant links', res.flat().filter(isSig).length, `of ${res.flat().filter(Boolean).length} tests (p &lt; ${state.alpha})`)}
      </div>
      ${section('Usage calendar', '', `<div class="cal">${cal}</div>`)}
      ${section(`Effect of <i>${esc(t)}</i> on each metric`, 'Click a row to plot it. “With/Without” are raw means; d is the (adjusted) difference in standard deviations. Bar: blue = better, red = worse, faded = not significant.',
        `<div class="tablewrap"><table class="tbl"><thead><tr><th rowspan="2">Metric</th><th colspan="4" class="grp">Tag on the same day</th><th colspan="4" class="grp">Tag on the day before</th></tr>
        <tr><th class="num">With</th><th class="num">Without</th><th>d</th><th class="num">p</th><th class="num">With</th><th class="num">Without</th><th>d</th><th class="num">p</th></tr></thead><tbody>${rows}</tbody></table></div>`)}
      ${section(`${esc(m.col)}: with vs without <i>${esc(t)}</i>`, `${esc(m.name)} · ${dirLabel(m)} · orange = days with the tag`,
        `<div class="two"><div><h3>Same day</h3><div id="strip0"></div></div><div><h3>Day before</h3><div id="strip1"></div></div></div><h3>Timeline</h3><div id="tl"></div>`)}
      ${section('Often logged together', 'Tags that co-occur with this one (phi correlation). Strong overlap means their effects can’t be told apart from this data.',
        `${doseCmp}<div class="tablewrap"><table class="tbl"><thead><tr><th>Tag</th><th class="num">phi</th><th class="num">Together</th><th></th></tr></thead><tbody>${coRows || '<tr><td colspan="4" class="muted">None</td></tr>'}</tbody></table></div>`)}`;

    [0, 1].forEach(lag => {
      const ps = D.pairs(ds, v, m, lag);
      const g = [{ label: 'Without', pts: [] }, { label: lag ? 'After tag day' : 'With', pts: [] }];
      ps.forEach(p => g[p.x ? 1 : 0].pts.push({ y: p.y, tip: dayTip(p.i, m.col, p.y) + (lag ? `<div class="muted">Day before: ${ds.days[p.j].tags.has(t) ? 'with' : 'without'} tag</div>` : '') }));
      C.strip(document.getElementById('strip' + lag), { groups: g, height: 240 });
    });
    const hl = new Set(tagDays.map(d => d.i));
    C.timeSeries(document.getElementById('tl'), {
      pts: ds.days.map((d, i) => ({ i, t: d.t, y: m.vals[i] })), highlight: hl, rolling: rolling(m.vals, ds.days, 7),
      tip: p => dayTip(p.i, m.col, p.y) + (hl.has(p.i) ? `<div><b>${esc(t)}</b> this day</div>` : ''),
    });
  }

  // ---- Metric detail ----
  function vMetric(main) {
    const m = mv(state.metric);
    const vals = m.vals.filter(v => v != null);
    // trend per week
    const trendVar = { id: '_trend', binary: false, vals: ds.days.map(d => d.dayNum) };
    const tr = D.assoc(ds, trendVar, Object.assign({}, m), 0, { ranks: false });

    // other metrics
    const others = metricVars().filter(o => o.id !== m.id).map(o => ({ o, r0: D.assoc(ds, o, m, 0, opts()), r1: D.assoc(ds, o, m, 1, opts()) }));
    const oRows = others.filter(x => x.r0 || x.r1).sort((a, b) => Math.abs((b.r0 || {}).r || 0) - Math.abs((a.r0 || {}).r || 0)).map(x =>
      `<tr><td>${metricLink(x.o.col)} <span class="muted small">${esc(x.o.name !== x.o.col ? x.o.name : '')}</span></td>
       <td class="num ${isSig(x.r0) ? 'b' : ''}" data-tip="p = ${fmtP(x.r0 && x.r0.p)} · n = ${x.r0 ? x.r0.n : 0}">${x.r0 ? fmtSigned(x.r0.r, 2) : '–'}</td>
       <td class="num ${isSig(x.r1) ? 'b' : ''}" data-tip="${esc(x.o.col)} yesterday → ${esc(m.col)} today<br>p = ${fmtP(x.r1 && x.r1.p)} · n = ${x.r1 ? x.r1.n : 0}">${x.r1 ? fmtSigned(x.r1.r, 2) : '–'}</td></tr>`).join('');

    // weekday
    const wd = [1, 2, 3, 4, 5, 6, 0].map(w => {
      const a = ds.days.map((d, i) => [d, m.vals[i]]).filter(([d, y]) => y != null && new Date(d.t).getUTCDay() === w).map(x => x[1]);
      return { w, n: a.length, mean: S.mean(a) };
    });
    const wmin = Math.min(...wd.filter(x => x.n).map(x => x.mean)), wmax = Math.max(...wd.filter(x => x.n).map(x => x.mean));
    const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const wdHtml = wd.map(x => `<div class="wd"><span>${WD[x.w]}</span><span class="hbar"><span style="width:${x.n ? 8 + 92 * (x.mean - wmin) / ((wmax - wmin) || 1) : 0}%"></span></span><span class="num">${x.n ? fmtNum(x.mean) : '–'}</span><span class="muted small">n ${x.n}</span></div>`).join('');

    // best / worst days
    const ranked = ds.days.map((d, i) => ({ i, y: m.vals[i] })).filter(x => x.y != null).sort((a, b) => m.dir * (b.y - a.y));
    const dayRow = x => {
      const j = D.shift(ds, x.i, 1);
      return `<tr><td class="nowrap">${fmtDay(ds.days[x.i].t)}</td><td class="num b">${fmtNum(x.y)}</td><td class="small">${tagsOf(x.i, 30)}${j >= 0 ? `<div class="muted">day before: ${tagsOf(j, 30)}</div>` : ''}</td></tr>`;
    };

    main.innerHTML = `
      ${metricChips('metric', m.col)}
      <div class="tiles">
        ${tile(esc(m.name), fmtNum(S.mean(vals)), `mean · ${dirLabel(m)}${m.desc ? ' · ' + esc(m.desc) : ''}`)}
        ${tile('Spread', fmtNum(S.sd(vals)), `SD · range ${fmtNum(Math.min(...vals))} – ${fmtNum(Math.max(...vals))}`)}
        ${tile('Trend', tr ? fmtSigned(tr.coef * 7) + '/wk' : '–', tr ? `p = ${fmtP(tr.p)} · ${tr.p < state.alpha ? (tr.coef * m.dir > 0 ? 'improving' : 'worsening') : 'no clear trend'}` : '')}
        ${tile('Days', vals.length, `of ${ds.days.length} tracked`)}
      </div>
      ${section('Over time', 'Dots = daily values, grey line = 7-day average. Hover for that day’s tags.', '<div id="ts"></div>')}
      <p><button class="link" data-act="view" data-v="impact">See which tags improve or worsen ${esc(m.col)} →</button></p>
      <div class="two">
        ${section('Linked metrics', `Correlation (r) with other metrics. “Yesterday” = the other metric on the previous day.`, `<div class="tablewrap"><table class="tbl"><thead><tr><th>Metric</th><th class="num">Same day</th><th class="num">Yesterday</th></tr></thead><tbody>${oRows}</tbody></table></div>`)}
        ${section('By weekday', 'Mean per day of the week.', `<div class="wds">${wdHtml}</div>`)}
      </div>
      <div class="two">
        ${section('Best days', '', `<table class="tbl"><tbody>${ranked.slice(0, 5).map(dayRow).join('')}</tbody></table>`)}
        ${section('Worst days', '', `<table class="tbl"><tbody>${ranked.slice(-5).reverse().map(dayRow).join('')}</tbody></table>`)}
      </div>`;

    C.timeSeries(document.getElementById('ts'), {
      pts: ds.days.map((d, i) => ({ i, t: d.t, y: m.vals[i] })), rolling: rolling(m.vals, ds.days, 7), height: 260,
      tip: p => dayTip(p.i, m.col, p.y),
    });
  }

  // ---- Dose ----
  function vDose(main) {
    if (!ds.doses.length) { main.innerHTML = section('No dose column', 'Set a column’s role to “dose” on the Data tab.', ''); return; }
    const dv = ds.vars.get('d:' + state.doseCol);
    const vals = dv.vals.filter(v => v != null);
    const q1 = S.quantile(vals, 1 / 3), q2 = S.quantile(vals, 2 / 3);
    const bin = x => (x <= q1 ? 0 : x <= q2 ? 1 : 2);
    const lag = state.lag;
    const rows = metricVars().map(m => {
      const r0 = D.assoc(ds, dv, m, 0, opts()), r1 = D.assoc(ds, dv, m, 1, opts());
      const bins = [[], [], []];
      D.pairs(ds, dv, m, lag).forEach(p => bins[bin(p.x)].push(p.y));
      const bm = bins.map(b => (b.length ? S.mean(b) : NaN));
      const cell = r => r ? `<td class="effcell" data-tip="${esc(effTip(r, dv.col, m))}">${effBar(r.good, isSig(r))}<span class="num">${fmtSigned(r.r, 2)}</span></td><td class="num ${isSig(r) ? 'b' : 'muted'}">${fmtP(r.p)}</td>` : '<td class="muted" colspan="2">–</td>';
      return `<tr class="clickable ${m.col === state.doseMetric ? 'sel' : ''}" data-act="set" data-k="doseMetric" data-v="${esc(m.col)}"><td><b>${esc(m.col)}</b> <span class="muted small">${dirLabel(m)}</span></td>${cell(r0)}${cell(r1)}${bm.map(b => `<td class="num">${fmtNum(b)}</td>`).join('')}</tr>`;
    }).join('');
    const m = mv(state.doseMetric);
    const ps = D.pairs(ds, dv, m, lag);
    const r = D.assoc(ds, dv, m, lag, { ranks: false });

    main.innerHTML = `
      ${ds.doses.length > 1 ? `<div class="pickerbar"><span class="ctl-l">Dose column</span>${seg('doseCol', ds.doses.map(d => [d, d]), state.doseCol)}</div>` : ''}
      <div class="tiles">
        ${tile('Average', fmtNum(S.mean(vals), 1), `median ${fmtNum(S.median(vals), 1)} · SD ${fmtNum(S.sd(vals), 1)}`)}
        ${tile('Range', `${fmtNum(Math.min(...vals))} – ${fmtNum(Math.max(...vals))}`, `${vals.length} days logged`)}
        ${tile('Last 7 days', fmtNum(S.mean(dv.vals.slice(-7).filter(v => v != null)), 1), 'average')}
        ${tile('Dose bands', `≤${fmtNum(q1, 1)} · ≤${fmtNum(q2, 1)} · &gt;${fmtNum(q2, 1)}`, 'low · mid · high (tertiles)')}
      </div>
      ${section(`${esc(dv.col)} over time`, '', '<div id="dts"></div>')}
      ${section(`Dose vs metrics`, `r = correlation (with adjustments ticked above, excluding itself). Band means use the dose on the ${lagName(lag)}. Click a row to plot it.`,
        `<div class="tablewrap"><table class="tbl"><thead><tr><th rowspan="2">Metric</th><th colspan="2" class="grp">Dose same day</th><th colspan="2" class="grp">Dose day before</th><th colspan="3" class="grp">Mean by dose band (${lagName(lag)})</th></tr>
        <tr><th>r</th><th class="num">p</th><th>r</th><th class="num">p</th><th class="num">Low</th><th class="num">Mid</th><th class="num">High</th></tr></thead><tbody>${rows}</tbody></table></div>`)}
      ${section(`${esc(m.col)} vs ${esc(dv.col)} <span class="muted">· dose ${lagName(lag)}</span>`, r ? `r = ${fmtSigned(r.r, 2)}, p = ${fmtP(r.p)}, n = ${r.n}. Slope: ${fmtSigned(r.coef, 2)} ${esc(m.col)} per 1 unit of dose.` : 'Not enough data', '<div id="dsc"></div>')}`;

    C.timeSeries(document.getElementById('dts'), {
      pts: ds.days.map((d, i) => ({ i, t: d.t, y: dv.vals[i] })), rolling: rolling(dv.vals, ds.days, 7), height: 200,
      tip: p => dayTip(p.i, dv.col, p.y),
    });
    C.scatter(document.getElementById('dsc'), {
      pts: ps.map(p => ({ x: p.x, y: p.y, tip: `${dayTip(p.i, m.col, p.y)}<div>${esc(dv.col)} (${lagName(lag)}): <b>${fmtNum(p.x)}</b></div>` })),
      fit: r ? { a: r.intercept, b: r.coef } : null, xLabel: `${dv.col} (${lagName(lag)})`,
    });
  }

  // ---- Metric correlations ----
  function heatTable(rows, ms, cells, rowLabel, rowTip, colTip, cellTip, act) {
    const head = `<div class="hh corner"></div>` + ms.map(m => `<div class="hh col" data-tip="${esc(colTip(m))}">${esc(m.col)}</div>`).join('');
    const body = rows.map(rv => `<div class="hr static" data-tip="${esc(rowTip(rv))}"><span>${esc(rowLabel(rv))}</span></div>` + cells.get(rv.id).map((r, k) => {
      if (!r) return `<div class="hc na"></div>`;
      const sig = isSig(r);
      const bg = C.divColor(r.good * (sig ? 1 : 0.45));
      return `<div class="hc${sig ? ' sig' : ''}" style="background:${bg};color:${C.inkOn(bg)}" data-tip="${esc(cellTip(r, rv, ms[k]))}" ${act ? act(rv, ms[k]) : ''}>${sig ? fmtSigned(r.r, 1).replace('0.', '.') : ''}</div>`;
    }).join('')).join('');
    return `<div class="heatwrap"><div class="heat" style="grid-template-columns:minmax(110px,170px) repeat(${ms.length},minmax(44px,1fr))">${head}${body}</div></div>`;
  }

  function legendHtml(label) {
    return `<div class="legend"><span>worse</span><span class="ramp" style="background:linear-gradient(90deg, ${[-1, -0.5, 0, 0.5, 1].map(C.divColor).join(',')})"></span><span>better</span><span class="muted small">${label}</span></div>`;
  }

  function vCorr(main) {
    const lag = state.lag;
    const M = contMatrix('metric', lag);
    // For metric-metric, colour by raw r (not "good"): both sides have their own direction.
    const cellTip = (r, rv, m) => `<b>${esc(rv.col)}</b>${lag ? ' (yesterday)' : ''} ↔ <b>${esc(m.col)}</b><br>r = ${fmtSigned(r.r, 2)} · p = ${fmtP(r.p)} · q = ${fmtP(r.q)} · n = ${r.n}`;
    const head = `<div class="hh corner"></div>` + M.ms.map(m => `<div class="hh col" data-tip="${esc(m.name)}">${esc(m.col)}</div>`).join('');
    const body = M.rows.map(rv => `<button class="hr" data-act="go-metric" data-v="${esc(rv.col)}"><span>${esc(rv.col)}${lag ? ' <span class="muted small">yday</span>' : ''}</span></button>` + M.cells.get(rv.id).map((r, k) => {
      if (!r) return `<div class="hc na"></div>`;
      const sig = isSig(r);
      const bg = C.divColor(r.r * (sig ? 1 : 0.45));
      return `<div class="hc${sig ? ' sig' : ''}" style="background:${bg};color:${C.inkOn(bg)}" data-tip="${esc(cellTip(r, rv, M.ms[k]))}" data-act="explore" data-x="${esc(rv.id)}" data-y="${esc(M.ms[k].id)}">${sig ? fmtSigned(r.r, 1) : ''}</div>`;
    }).join('')).join('');
    main.innerHTML = section(`How metrics move together <span class="muted">· ${lag ? 'row metric yesterday → column metric today' : 'same day'}</span>`,
      `Correlation r between metrics. Blue = move together, red = move oppositely (this view is not oriented to better/worse). Numbers where p &lt; ${state.alpha}. Click a cell to open it in the Explorer.`,
      `<div class="legend"><span>−1</span><span class="ramp" style="background:linear-gradient(90deg, ${[-1, -0.5, 0, 0.5, 1].map(C.divColor).join(',')})"></span><span>+1</span></div>
       <div class="heatwrap"><div class="heat" style="grid-template-columns:minmax(90px,130px) repeat(${M.ms.length},minmax(44px,1fr))">${head}${body}</div></div>`);
  }

  // ---- Nutrients & groups ----
  function vNutr(main) {
    const kind = state.nutKind;
    const lag = state.lag;
    const cols = kind === 'nutrient' ? ds.nutrients : ds.groups;
    if (!cols.length) { main.innerHTML = section('Nothing here', `No ${kind} columns. Assign roles on the Data tab.`, seg('nutKind', [['nutrient', 'Nutrients'], ['group', 'Groups']], kind)); return; }
    const M = contMatrix(kind, lag);
    const flat = [];
    M.rows.forEach(rv => M.cells.get(rv.id).forEach((r, k) => { if (r) flat.push({ r, rv, m: M.ms[k] }); }));
    const top = flat.sort((a, b) => a.r.p - b.r.p).slice(0, 12);
    main.innerHTML = `<div class="pickerbar">${seg('nutKind', [['nutrient', `Nutrients (${ds.nutrients.length})`], ['group', `Food groups (${ds.groups.length})`]], kind)}</div>` +
      section(`${kind === 'nutrient' ? 'Nutrients' : 'Food groups'} × Metrics <span class="muted">· ${LAGS[lag].toLowerCase()}</span>`,
        `Correlation between the daily ${kind} value and each metric, oriented so blue = better. Numbers where p &lt; ${state.alpha}. Click a cell to explore.`,
        legendHtml('(r)') + heatTable(M.rows, M.ms, M.cells, rv => rv.col,
          rv => `<b>${esc(rv.col)}</b><br>mean ${fmtNum(S.mean(rv.vals.filter(v => v != null)))} · ${rv.vals.filter(v => v != null).length} days`,
          m => `<b>${esc(m.col)}</b> – ${esc(m.name)}<br>${dirLabel(m)}`,
          (r, rv, m) => effTip(r, rv.col, m),
          (rv, m) => `data-act="explore" data-x="${esc(rv.id)}" data-y="${esc(m.id)}"`)) +
      section('Strongest links', 'Lowest p-values in the table above.', `<div class="tablewrap"><table class="tbl"><thead><tr><th>${kind === 'nutrient' ? 'Nutrient' : 'Group'}</th><th>Metric</th><th>r</th><th class="num">p</th><th class="num">q</th><th class="num">n</th></tr></thead><tbody>${top.map(x => `<tr class="clickable" data-act="explore" data-x="${esc(x.rv.id)}" data-y="${esc(x.m.id)}"><td>${esc(x.rv.col)}</td><td>${esc(x.m.col)} <span class="muted small">${dirLabel(x.m)}</span></td><td class="effcell">${effBar(x.r.good, isSig(x.r))}<span class="num">${fmtSigned(x.r.r, 2)}</span></td><td class="num">${fmtP(x.r.p)}</td><td class="num">${fmtP(x.r.q)}</td><td class="num muted">${x.r.n}</td></tr>`).join('')}</tbody></table></div>`);
  }

  // ---- Explorer ----
  function varOptions(cur, includeTags) {
    const grp = (label, ids) => ids.length ? `<optgroup label="${label}">${ids.map(id => { const v = ds.vars.get(id); return `<option value="${esc(id)}" ${id === cur ? 'selected' : ''}>${esc(v.col || v.label)}${v.kind === 'tag' ? ` (${v.freq} d)` : v.name && v.name !== v.col ? ' – ' + esc(v.name) : ''}</option>`; }).join('')}</optgroup>` : '';
    return grp('Metrics', ds.metrics.map(m => 'm:' + m)) + grp('Dose', ds.doses.map(d => 'd:' + d)) +
      (includeTags ? grp('Tags', ds.tags.map(t => 't:' + t)) : '') + grp('Food groups', ds.groups.map(g => 'g:' + g)) + grp('Nutrients', ds.nutrients.map(n => 'n:' + n));
  }

  function vExplore(main) {
    const xv = ds.vars.get(state.exX), yv = ds.vars.get(state.exY);
    const lag = state.lag;
    const r = D.assoc(ds, xv, yv, lag, opts());
    const sweep = [0, 1, 2, 3].map(l => ({ l, r: D.assoc(ds, xv, yv, l, opts()) }));
    const stat = r => !r ? '–' : xv.binary ? `d = ${fmtSigned(r.d, 2)} (${fmtNum(r.m1)} vs ${fmtNum(r.m0)})` : `r = ${fmtSigned(r.r, 2)}`;
    main.innerHTML = section('Explorer', 'Pick any two variables. X is taken from the chosen timing (same day / day before), Y from the day itself.',
      `<div class="exrow"><label>X <select data-bind="exX">${varOptions(state.exX, true)}</select></label>
        <button class="btn" data-act="swap" title="Swap X and Y" ${xv.kind === 'tag' ? 'disabled' : ''}>⇄</button>
        <label>Y <select data-bind="exY">${varOptions(state.exY, false)}</select></label></div>
       <p class="lead">${r ? `${stat(r)} · p = ${fmtP(r.p)} · n = ${r.n}${yv.dir ? ` · <b>${r.good > 0 ? 'better' : 'worse'}</b> for ${esc(yv.col)} (${dirLabel(yv)})` : ''}` : 'Not enough overlapping data.'}</p>
       <div id="exchart"></div>
       <h3>Delay sweep</h3><p class="small muted">Same relation with X shifted 0–3 days back – a peak at a later delay hints at a delayed effect.</p>
       <table class="tbl narrow"><thead><tr><th>X from</th><th>Effect</th><th class="num">p</th><th class="num">n</th></tr></thead><tbody>${sweep.map(s => `<tr class="${s.l === lag ? 'sel' : ''}"><td>${lagName(s.l)}</td><td>${stat(s.r)}</td><td class="num ${isSig(s.r) ? 'b' : ''}">${fmtP(s.r && s.r.p)}</td><td class="num muted">${s.r ? s.r.n : 0}</td></tr>`).join('')}</tbody></table>`);
    const ps = D.pairs(ds, xv, yv, lag);
    const host = document.getElementById('exchart');
    if (xv.binary) {
      const g = [{ label: 'Without', pts: [] }, { label: 'With', pts: [] }];
      ps.forEach(p => g[p.x ? 1 : 0].pts.push({ y: p.y, tip: dayTip(p.i, yv.col, p.y) }));
      C.strip(host, { groups: g });
    } else {
      const rr = D.assoc(ds, xv, yv, lag, {});
      C.scatter(host, { pts: ps.map(p => ({ x: p.x, y: p.y, tip: `${dayTip(p.i, yv.col, p.y)}<div>${esc(xv.col)} (${lagName(lag)}): <b>${fmtNum(p.x)}</b></div>` })), fit: rr ? { a: rr.intercept, b: rr.coef } : null, xLabel: `${xv.col} (${lagName(lag)})` });
    }
  }

  // ---- Data ----
  function lev(a, b) {
    const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let prev = dp[0]; dp[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = dp[j];
        dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return dp[b.length];
  }

  function similarTags() {
    const out = [];
    const tags = ds.tags;
    for (let i = 0; i < tags.length; i++) for (let j = i + 1; j < tags.length; j++) {
      const a = tags[i], b = tags[j];
      const L = Math.min(a.length, b.length);
      if (L < 4 || Math.abs(a.length - b.length) > 2) continue;
      const d = lev(a, b);
      if (d <= (L >= 8 ? 2 : 1)) out.push(ds.tagFreq[a] >= ds.tagFreq[b] ? [b, a] : [a, b]);
    }
    return out;
  }

  function vData(main) {
    const upload = `<div class="drop" id="drop">
        <p><b>Drop your CSV here</b> or <label class="btn primary">Choose file<input type="file" accept=".csv,text/csv" id="file" hidden></label></p>
        <p class="small muted">Everything stays in this browser – nothing is uploaded anywhere. The last file is remembered here until you replace it.</p>
        ${csv ? `<p class="small">Current: <b>${esc(csv.name || 'data.csv')}</b>${csv.at ? ` · loaded ${esc(new Date(csv.at).toLocaleString())}` : ''} ${ds ? `· ${ds.days.length} days, ${ds.tags.length} tags` : ''} <button class="link" data-act="clear-data">Forget this file</button></p>` : ''}
        ${buildError ? `<p class="err">Could not read the file: ${esc(buildError)}</p>` : ''}
      </div>`;
    if (!ds) { main.innerHTML = section('Load data', 'Start by loading your tracking CSV.', upload); return; }

    const roleOpts = ['metric', 'dose', 'nutrient', 'group', 'ignore', 'date', 'input'];
    const colRows = ds.headers.map(h => {
      const nn = ds.days.filter(d => d.values[h] != null).length;
      const role = ds.roles[h];
      const changed = cfg.roles[h] && cfg.roles[h] !== ds.defRoles[h];
      return `<tr><td><b>${esc(h)}</b>${role === 'metric' ? ` <span class="muted small">${esc(D.metricInfo(h).name !== h ? D.metricInfo(h).name : '')}</span>` : ''}</td>
        <td><select data-col-role="${esc(h)}">${roleOpts.map(o => `<option ${o === role ? 'selected' : ''}>${o}</option>`).join('')}</select>${changed ? ' <span class="pill">custom</span>' : ''}</td>
        <td>${role === 'metric' ? `<select data-col-dir="${esc(h)}"><option value="1" ${ds.dirs[h] > 0 ? 'selected' : ''}>higher is better</option><option value="-1" ${ds.dirs[h] < 0 ? 'selected' : ''}>lower is better</option></select>` : ''}</td>
        <td class="num muted">${role === 'date' || role === 'input' ? '' : nn}</td></tr>`;
    }).join('');
    const sim = similarTags();
    const dayRows = [...ds.days].reverse().map(d => `<tr><td class="nowrap">${fmtDay(d.t)}</td><td class="num">${d.tags.size}</td><td class="small">${[...d.tags].map(esc).join(', ')}</td></tr>`).join('');

    main.innerHTML = section('Data file', '', upload) +
      (ds.warnings.length ? section('Warnings', '', `<ul class="small">${ds.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>`) : '') +
      `<div class="two">` +
      section('Tag aliases', 'Merge spellings or synonyms. One per line: <code>old name =&gt; new name</code> (several old names can be comma-separated).',
        `<textarea id="aliases" rows="8" spellcheck="false" placeholder="swis cheese => swiss cheese&#10;linseed => linseed oil">${esc(cfg.aliases)}</textarea>
         <div class="toolbar"><button class="btn primary" data-act="save-aliases">Apply aliases</button></div>
         ${sim.length ? `<h3>Possible duplicates</h3><p class="small muted">Similar spellings found – merge if they are the same thing.</p><ul class="simlist">${sim.map(([a, b]) => `<li><span>${esc(a)} <span class="muted">(${ds.tagFreq[a]})</span> → ${esc(b)} <span class="muted">(${ds.tagFreq[b]})</span></span><button class="btn small" data-act="merge" data-a="${esc(a)}" data-b="${esc(b)}">Merge</button></li>`).join('')}</ul>` : ''}`) +
      section('All tags', `${ds.tags.length} unique tags, by number of days used.`, `<div class="taglist">${ds.tags.map(t => `<button class="chip" data-act="go-tag" data-v="${esc(t)}">${esc(t)} <span class="muted">${ds.tagFreq[t]}</span></button>`).join('')}</div>`) +
      `</div>` +
      section('Columns', 'Roles are detected automatically from your column layout; change any here (remembered for future uploads). “Score” columns are ignored by default.',
        `<div class="toolbar"><button class="btn" data-act="reset-cols">Reset to automatic</button></div><div class="tablewrap tall"><table class="tbl"><thead><tr><th>Column</th><th>Role</th><th>Direction</th><th class="num">Values</th></tr></thead><tbody>${colRows}</tbody></table></div>`) +
      section('Days', 'Parsed tags per day (newest first).', `<div class="tablewrap tall"><table class="tbl"><thead><tr><th>Date</th><th class="num">Tags</th><th>Input</th></tr></thead><tbody>${dayRows}</tbody></table></div>`);
  }

  function bindUpload() {
    const f = document.getElementById('file');
    if (f) f.addEventListener('change', () => f.files[0] && readFile(f.files[0]));
  }

  function readFile(file) {
    const rd = new FileReader();
    rd.onload = () => loadText(String(rd.result), file.name);
    rd.readAsText(file);
  }

  function loadText(text, name) {
    try { D.build(text, cfg); } catch (e) { toast('Could not read file: ' + e.message, true); return; }
    csv = { text, name, at: Date.now() };
    const ok = LS.set('csv', csv);
    rebuild();
    if (state.view === 'data' && ds) state.view = 'overview';
    render();
    toast(`Loaded ${ds.days.length} days · ${ds.tags.length} tags${ok ? '' : ' (browser storage unavailable – reload will forget it)'}`);
  }

  function toast(msg, err) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
    clearTimeout(t._h); t._h = setTimeout(() => { t.className = 'toast'; }, 3500);
  }

  // ---------- Events ----------
  function go(view, v) {
    if (view === 'tag' && v != null) state.tag = v;
    if ((view === 'metric' || view === 'impact') && v != null) state.metric = v;
    state.view = view;
    C.hideTip();
    render();
    window.scrollTo({ top: 0 });
  }

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act, v = b.dataset.v;
    if (act === 'view') go(v);
    else if (act === 'go-tag') go('tag', v);
    else if (act === 'go-metric') go(state.view === 'metric' ? 'metric' : 'impact', v);
    else if (act === 'toggle-settings') { state.showSettings = !state.showSettings; render(); }
    else if (act === 'explore') { state.exX = b.dataset.x; state.exY = b.dataset.y; go('explore'); }
    else if (act === 'swap') { [state.exX, state.exY] = [state.exY, state.exX]; render(); }
    else if (act === 'set') {
      const k = b.dataset.k;
      const def = DEFAULT_STATE[k];
      state[k] = typeof def === 'number' ? +v : typeof def === 'boolean' ? !!v : v;
      C.hideTip();
      render();
    } else if (act === 'export-effects') exportEffects();
    else if (act === 'save-aliases') { cfg.aliases = document.getElementById('aliases').value; LS.set('aliases', cfg.aliases); rebuild(); render(); toast('Aliases applied'); }
    else if (act === 'merge') {
      cfg.aliases = (cfg.aliases.trim() ? cfg.aliases.trim() + '\n' : '') + `${b.dataset.a} => ${b.dataset.b}`;
      LS.set('aliases', cfg.aliases); rebuild(); render(); toast(`Merged “${b.dataset.a}” into “${b.dataset.b}”`);
    } else if (act === 'reset-cols') { cfg.roles = {}; cfg.dirs = {}; LS.del('roles'); LS.del('dirs'); rebuild(); render(); }
    else if (act === 'clear-data') { csv = null; LS.del('csv'); rebuild(); render(); }
    else if (act === 'theme') { state.theme = { auto: 'light', light: 'dark', dark: 'auto' }[state.theme]; applyTheme(); render(); }
  });

  function onBind(e) {
    const t = e.target;
    if (t.dataset.colRole) { cfg.roles[t.dataset.colRole] = t.value; LS.set('roles', cfg.roles); rebuild(); render(); return; }
    if (t.dataset.colDir) { cfg.dirs[t.dataset.colDir] = +t.value; LS.set('dirs', cfg.dirs); rebuild(); render(); return; }
    const key = t.dataset.bind;
    if (!key) return;
    let val = t.type === 'checkbox' ? t.checked : t.value;
    if (key === 'minDays') val = Math.max(1, +val || 1);
    if (key === 'alpha') val = +val;
    if (key === 'tag') { val = val.trim().toLowerCase(); if (!ds.tags.includes(val)) return; }
    if (key.startsWith('controls.')) state.controls[key.split('.')[1]] = val;
    else state[key] = val;
    if (LIVE.includes(key) && key !== 'tag') {
      render();
      const inp = document.querySelector(`[data-bind="${key}"]`);
      if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
      return;
    }
    render();
  }
  const LIVE = ['heatSearch', 'rankSearch', 'tag'];
  document.addEventListener('change', e => { if (!LIVE.includes(e.target.dataset.bind) || e.target.dataset.bind === 'tag') onBind(e); });
  document.addEventListener('input', e => { if (LIVE.includes(e.target.dataset.bind)) onBind(e); });

  // Drag & drop anywhere
  document.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging'); });
  document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
  document.addEventListener('drop', e => {
    e.preventDefault(); document.body.classList.remove('dragging');
    const f = e.dataTransfer.files[0];
    if (f) readFile(f);
  });

  let rz;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(render, 200); });

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const dark = state.theme === 'dark' || (state.theme === 'auto' && mq.matches);
    document.documentElement.classList.toggle('dark', dark);
    const b = document.getElementById('themeBtn');
    b.textContent = { auto: '◐ Auto', light: '☀ Light', dark: '☾ Dark' }[state.theme];
  }
  mq.addEventListener && mq.addEventListener('change', () => { applyTheme(); render(); });

  // Public hook (e.g. for loading data programmatically).
  window.COML = { loadText };

  // ---------- Boot ----------
  C.initTooltip();
  applyTheme();
  rebuild();
  render();
  if (!csv) {
    // When served over http, a data.csv next to index.html is picked up automatically.
    fetch('data.csv', { cache: 'no-store' }).then(r => (r.ok ? r.text() : null)).then(t => { if (t && !csv) loadText(t, 'data.csv'); }).catch(() => {});
  }
})();
