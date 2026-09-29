// Statistics helpers: descriptive stats, OLS with standard errors, t-distribution, FDR.
(function (global) {
  'use strict';

  function mean(a) {
    if (!a.length) return NaN;
    let s = 0;
    for (const v of a) s += v;
    return s / a.length;
  }

  function sd(a) {
    if (a.length < 2) return NaN;
    const m = mean(a);
    let s = 0;
    for (const v of a) s += (v - m) * (v - m);
    return Math.sqrt(s / (a.length - 1));
  }

  function median(a) {
    if (!a.length) return NaN;
    const s = [...a].sort((x, y) => x - y);
    const h = s.length >> 1;
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  }

  function quantile(a, q) {
    const s = [...a].sort((x, y) => x - y);
    if (!s.length) return NaN;
    const pos = (s.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }

  // Average ranks (ties share the mean rank), 1-based.
  function ranks(a) {
    const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
    const r = new Array(a.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  }

  function pearson(x, y) {
    const n = x.length;
    if (n < 3) return NaN;
    const mx = mean(x), my = mean(y);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      const dx = x[i] - mx, dy = y[i] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    if (sxx === 0 || syy === 0) return NaN;
    return sxy / Math.sqrt(sxx * syy);
  }

  // ---- Special functions ----
  function lgamma(x) {
    const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
      -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x;
    const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
    let ser = 1.000000000190015;
    for (let j = 0; j < 6; j++) ser += c[j] / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  }

  function betacf(a, b, x) {
    const MAXIT = 200, EPS = 3e-14, FPMIN = 1e-300;
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAXIT; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }

  function ibeta(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    if (x < (a + 1) / (a + b + 2)) return bt * betacf(a, b, x) / a;
    return 1 - bt * betacf(b, a, 1 - x) / b;
  }

  // Two-sided p-value for Student's t.
  function tPValue(t, df) {
    if (!isFinite(t)) return 0;
    if (df <= 0) return NaN;
    return ibeta(df / (df + t * t), df / 2, 0.5);
  }

  // Critical t for two-sided alpha (bisection).
  function tCrit(df, alpha) {
    let lo = 0, hi = 1000;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (tPValue(mid, df) > alpha) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // ---- Linear algebra ----
  function invert(m) {
    const n = m.length;
    const a = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
      if (Math.abs(a[piv][c]) < 1e-10) return null;
      [a[c], a[piv]] = [a[piv], a[c]];
      const div = a[c][c];
      for (let k = 0; k < 2 * n; k++) a[c][k] /= div;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = a[r][c];
        if (f === 0) continue;
        for (let k = 0; k < 2 * n; k++) a[r][k] -= f * a[c][k];
      }
    }
    return a.map(row => row.slice(n));
  }

  // OLS of y on [1, x, ...controls]. Returns stats for the coefficient of x.
  function olsCoef(x, y, controls) {
    const n = y.length;
    const cols = [x, ...controls];
    const p = cols.length + 1;
    const df = n - p;
    if (df < 1) return null;
    const X = (i) => [1, ...cols.map(c => c[i])];
    const xtx = Array.from({ length: p }, () => new Array(p).fill(0));
    const xty = new Array(p).fill(0);
    for (let i = 0; i < n; i++) {
      const row = X(i);
      for (let a = 0; a < p; a++) {
        xty[a] += row[a] * y[i];
        for (let b = 0; b < p; b++) xtx[a][b] += row[a] * row[b];
      }
    }
    const inv = invert(xtx);
    if (!inv) return null;
    const beta = inv.map(row => row.reduce((s, v, k) => s + v * xty[k], 0));
    let rss = 0;
    for (let i = 0; i < n; i++) {
      const row = X(i);
      let fit = 0;
      for (let a = 0; a < p; a++) fit += row[a] * beta[a];
      rss += (y[i] - fit) ** 2;
    }
    const sigma2 = rss / df;
    const se = Math.sqrt(sigma2 * inv[1][1]);
    const coef = beta[1];
    let t;
    if (se === 0) t = coef === 0 ? 0 : Infinity * Math.sign(coef);
    else t = coef / se;
    const pv = tPValue(t, df);
    const r = isFinite(t) ? t / Math.sqrt(t * t + df) : Math.sign(t);
    const tc = tCrit(df, 0.05);
    return { coef, se, t, df, p: pv, r, lo: coef - tc * se, hi: coef + tc * se, intercept: beta[0] };
  }

  // Benjamini-Hochberg q-values. Accepts array of p (NaN allowed, returned as NaN).
  function bh(ps) {
    const idx = ps.map((p, i) => [p, i]).filter(d => isFinite(d[0])).sort((a, b) => a[0] - b[0]);
    const m = idx.length;
    const q = new Array(ps.length).fill(NaN);
    let min = 1;
    for (let k = m - 1; k >= 0; k--) {
      const v = Math.min(1, idx[k][0] * m / (k + 1));
      min = Math.min(min, v);
      q[idx[k][1]] = min;
    }
    return q;
  }

  global.Stats = { mean, sd, median, quantile, ranks, pearson, tPValue, tCrit, olsCoef, bh };
})(window);
