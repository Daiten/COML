// Data layer: CSV parsing, column roles, tag extraction, variables and lagged associations.
(function (global) {
  'use strict';
  const S = global.Stats;

  const METRIC_INFO = {
    'MOOD': { name: 'Mood', dir: 1 },
    'HEALTH': { name: 'Health', dir: 1, desc: 'Subjective feeling of health' },
    'HI': { name: 'Libido', dir: 1, desc: 'Horny index' },
    'HRV': { name: 'HRV', dir: 1, desc: 'Heart rate variability' },
    'RHR': { name: 'Resting HR', dir: -1, desc: 'Resting heart rate (lower is better)' },
    'SS': { name: 'Sleep score', dir: 1 },
    'TTSS': { name: 'Time to sound sleep', dir: -1, desc: 'Lower is better' },
    'AWAKE%': { name: 'Awake %', dir: -1, desc: '% of sleep time awake (lower is better)' },
    'REM%': { name: 'REM %', dir: 1, desc: '% of sleep in REM' },
    'DEEP%': { name: 'Deep %', dir: 1, desc: '% of sleep in deep sleep' },
    'REMS': { name: 'REM episodes', dir: 1 },
    'WE': { name: 'Work ethic', dir: 1, desc: 'Work effectiveness (missing = not working)' },
    'TD': { name: 'Tasks done', dir: 1, desc: 'Actions done in the day (missing = not tracked)' },
    'PSI': { name: 'PSI', dir: 1, desc: 'Prediction score' },
    'MEMORY': { name: 'Memory', dir: 1 },
    'RT': { name: 'Reaction time', dir: -1, desc: 'Lower is better' },
  };
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const DAY = 86400000;

  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', q = false;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
        } else field += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(v => v.trim() !== ''));
  }

  function parseDate(s) {
    s = (s || '').trim();
    let m = s.match(/^(\d{1,2})[-\s/.]([A-Za-z]{3,})[-\s/.,]*(\d{2,4})$/);
    if (m) {
      const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
      if (mo === undefined) return null;
      let y = +m[3]; if (y < 100) y += 2000;
      return Date.UTC(y, mo, +m[1]);
    }
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/);
    if (m) { let y = +m[3]; if (y < 100) y += 2000; return Date.UTC(y, +m[2] - 1, +m[1]); }
    const t = Date.parse(s);
    if (!isNaN(t)) { const d = new Date(t); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); }
    return null;
  }

  function parseNum(s) {
    if (s == null) return null;
    s = String(s).trim();
    if (s === '') return null;
    const v = parseFloat(s.replace(',', '.'));
    return isFinite(v) ? v : null;
  }

  function parseAliases(text) {
    const map = {};
    for (const line of (text || '').split(/\n/)) {
      const m = line.split(/=>|->|=/);
      if (m.length < 2) continue;
      const to = m[m.length - 1].trim().toLowerCase();
      for (const from of m.slice(0, -1)) {
        for (const f of from.split(',')) if (f.trim()) map[f.trim().toLowerCase()] = to;
      }
    }
    return map;
  }

  function metricInfo(col) {
    return METRIC_INFO[col.toUpperCase()] || { name: col, dir: 1 };
  }

  // Default role for each column based on the known layout.
  function defaultRoles(headers) {
    const up = headers.map(h => h.toUpperCase());
    const dateIdx = Math.max(0, up.findIndex(h => h === 'DATE'));
    const inputIdx = up.findIndex(h => h === 'INPUT' || h === 'INPUTS' || h === 'TAGS');
    const doseIdx = up.findIndex(h => /KRATOM/.test(h));
    const cafIdx = up.findIndex(h => h === 'CAF');
    const roles = {};
    headers.forEach((h, i) => {
      let r;
      if (i === dateIdx) r = 'date';
      else if (i === inputIdx) r = 'input';
      else if (/SCORE$/.test(up[i]) || / \(alt\d*\)$/.test(h)) r = 'ignore';
      else if (/KRATOM/.test(up[i])) r = 'dose';
      else if (cafIdx >= 0 && i >= cafIdx && (doseIdx < 0 || i < doseIdx)) r = 'nutrient';
      else if (inputIdx >= 0 && i > inputIdx && (cafIdx < 0 ? (doseIdx < 0 || i < doseIdx) : i < cafIdx)) r = 'group';
      else if (doseIdx >= 0 && i > doseIdx) r = 'metric';
      else if (METRIC_INFO[up[i]]) r = 'metric';
      else r = 'ignore';
      roles[h] = r;
    });
    return roles;
  }

  // Build the dataset from CSV text. opts: { roles, dirs, aliases }
  function build(text, opts) {
    opts = opts || {};
    const rows = parseCSV(text);
    if (rows.length < 2) throw new Error('The CSV has no data rows.');
    const rawHeaders = rows[0].map(h => h.trim());
    const body = rows.slice(1);
    const nonEmptyCount = rawHeaders.map((_, i) => body.filter(r => (r[i] || '').trim() !== '').length);

    // Duplicate headers: the most complete copy keeps the name, others become "NAME (alt)".
    const headers = [...rawHeaders];
    const groups = {};
    rawHeaders.forEach((h, i) => { (groups[h] = groups[h] || []).push(i); });
    for (const h in groups) {
      const idxs = groups[h];
      if (idxs.length < 2) continue;
      const best = idxs.reduce((a, b) => (nonEmptyCount[b] > nonEmptyCount[a] ? b : a));
      let k = 1;
      for (const i of idxs) if (i !== best) headers[i] = `${h} (alt${k > 1 ? k : ''})`, k++;
    }

    const defRoles = defaultRoles(headers);
    const roles = {};
    for (const h of headers) roles[h] = (opts.roles && opts.roles[h]) || defRoles[h];
    const dirs = {};
    for (const h of headers) dirs[h] = (opts.dirs && opts.dirs[h]) || metricInfo(h).dir;

    const dateCol = headers.find(h => roles[h] === 'date') || headers[0];
    const inputCol = headers.find(h => roles[h] === 'input');
    const aliasMap = parseAliases(opts.aliases);
    const dI = headers.indexOf(dateCol), iI = inputCol ? headers.indexOf(inputCol) : -1;

    const byKey = new Map();
    const warnings = [];
    for (const r of body) {
      const t = parseDate(r[dI]);
      if (t == null) { warnings.push(`Skipped row with unreadable date "${r[dI]}"`); continue; }
      const raw = iI >= 0 ? (r[iI] || '') : '';
      const tagCounts = {};
      for (let tg of raw.split(/[,;]/)) {
        tg = tg.trim().toLowerCase().replace(/\s+/g, ' ');
        if (!tg) continue;
        tg = aliasMap[tg] || tg;
        tagCounts[tg] = (tagCounts[tg] || 0) + 1;
      }
      const values = {};
      headers.forEach((h, i) => {
        if (roles[h] !== 'date' && roles[h] !== 'input') values[h] = parseNum(r[i]);
      });
      if (byKey.has(t)) warnings.push(`Duplicate date ${r[dI]}: later row wins`);
      byKey.set(t, { t, tagCounts, tags: new Set(Object.keys(tagCounts)), hasInput: raw.trim() !== '', values, raw: r });
    }
    const days = [...byKey.values()].sort((a, b) => a.t - b.t);
    if (!days.length) throw new Error('No rows with a readable date.');
    const idxByT = new Map(days.map((d, i) => [d.t, i]));
    const t0 = days[0].t;
    days.forEach((d, i) => { d.i = i; d.dayNum = Math.round((d.t - t0) / DAY); });

    const cols = role => headers.filter(h => roles[h] === role);
    const metrics = cols('metric').filter(h => days.some(d => d.values[h] != null));
    const nutrients = cols('nutrient');
    const groupsCols = cols('group');
    const doses = cols('dose');

    // Variables
    const vars = new Map();
    const addVar = (id, label, kind, vals, extra) => {
      const v = Object.assign({ id, label, kind, vals, binary: kind === 'tag' }, extra || {});
      vars.set(id, v);
      return v;
    };
    for (const m of metrics) {
      const inf = metricInfo(m);
      addVar('m:' + m, m, 'metric', days.map(d => d.values[m]), { col: m, name: inf.name, desc: inf.desc, dir: dirs[m] });
    }
    for (const c of doses) addVar('d:' + c, c, 'dose', days.map(d => d.values[c]), { col: c });
    for (const c of nutrients) addVar('n:' + c, c, 'nutrient', days.map(d => d.values[c]), { col: c });
    for (const c of groupsCols) addVar('g:' + c, c, 'group', days.map(d => d.values[c]), { col: c });

    const tagFreq = {};
    for (const d of days) for (const tg of d.tags) tagFreq[tg] = (tagFreq[tg] || 0) + 1;
    const inputDays = days.filter(d => d.hasInput).length;
    const tags = Object.keys(tagFreq).sort((a, b) => tagFreq[b] - tagFreq[a] || a.localeCompare(b));
    for (const tg of tags) {
      addVar('t:' + tg, tg, 'tag', days.map(d => (d.hasInput ? (d.tags.has(tg) ? 1 : 0) : null)), { freq: tagFreq[tg] });
    }

    return {
      headers, rawHeaders, roles, defRoles, dirs, days, idxByT, metrics, nutrients, groups: groupsCols, doses,
      tags, tagFreq, inputDays, vars, warnings, dateCol, inputCol,
    };
  }

  // Index of the day `lag` calendar days before day i (or -1).
  function shift(ds, i, lag) {
    if (!lag) return i;
    const j = ds.idxByT.get(ds.days[i].t - lag * DAY);
    return j === undefined ? -1 : j;
  }

  // Resolve control variables into per-day getters.
  function controlGetters(ds, controls, excludeVar, lagOfX) {
    const out = [];
    if (!controls) return out;
    if (controls.trend) out.push(i => ds.days[i].dayNum);
    const dose = ds.doses[0] && ds.vars.get('d:' + ds.doses[0]);
    if (dose) {
      if (controls.dose0 && !(excludeVar && excludeVar.id === dose.id && lagOfX === 0)) out.push(i => dose.vals[i]);
      if (controls.dose1 && !(excludeVar && excludeVar.id === dose.id && lagOfX === 1)) out.push(i => { const j = shift(ds, i, 1); return j < 0 ? null : dose.vals[j]; });
    }
    return out;
  }

  // Aligned pairs: x from day (i - lag), y from day i.
  function pairs(ds, xv, yv, lag) {
    const out = [];
    for (let i = 0; i < ds.days.length; i++) {
      const y = yv.vals[i];
      if (y == null) continue;
      const j = shift(ds, i, lag);
      if (j < 0) continue;
      const x = xv.vals[j];
      if (x == null) continue;
      out.push({ i, j, x, y });
    }
    return out;
  }

  // Association of x (lagged) with y, optionally adjusted for controls, optionally on ranks.
  function assoc(ds, xv, yv, lag, opts) {
    opts = opts || {};
    const getters = controlGetters(ds, opts.controls, xv, lag);
    const rows = [];
    for (const p of pairs(ds, xv, yv, lag)) {
      const c = getters.map(g => g(p.i));
      if (c.some(v => v == null)) continue;
      rows.push({ x: p.x, y: p.y, c, i: p.i });
    }
    const n = rows.length;
    if (n < 4) return null;
    let xs = rows.map(r => r.x), ys = rows.map(r => r.y);
    const rawYs = ys;
    const binary = xv.binary;
    let n1 = 0, m1 = NaN, m0 = NaN;
    if (binary) {
      const a = [], b = [];
      rows.forEach(r => (r.x ? a : b).push(r.y));
      n1 = a.length;
      if (n1 < 1 || n1 === n) return null;
      m1 = S.mean(a); m0 = S.mean(b);
    }
    if (opts.ranks) {
      ys = S.ranks(ys);
      if (!binary) xs = S.ranks(xs);
    }
    const ctl = getters.map((_, k) => rows.map(r => r.c[k]));
    const fit = S.olsCoef(xs, ys, ctl);
    if (!fit) return null;
    const sdY = S.sd(ys);
    const sdYraw = S.sd(rawYs);
    const res = Object.assign(fit, { n, binary, sdY, sdYraw });
    if (binary) {
      res.n1 = n1; res.n0 = n - n1; res.m1 = m1; res.m0 = m0;
      res.d = sdY > 0 ? fit.coef / sdY : 0;         // standardized mean difference (adjusted)
      res.rawDiff = m1 - m0;
      res.std = res.d;
    } else {
      res.std = fit.r;
      res.slope = fit.coef;
    }
    const dir = yv.dir || 1;
    res.good = dir * res.std;                        // positive = better outcome
    return res;
  }

  global.CoMLData = { build, parseCSV, parseDate, assoc, pairs, shift, metricInfo, parseAliases, DAY };
})(window);
