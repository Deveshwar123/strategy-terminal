'use strict';
// JavaScript strategy harness.
//   Your code defines:  function onBar(bar, ctx) { ... }
//   Optionally also:    function initialize(ctx) { ... }
// The harness walks the bars, hands you a ctx, and collects the orders you emit.

const fs = require('node:fs');
const vm = require('node:vm');

const [, , reqPath, resPath] = process.argv;
const req = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
const { code, bars, params, config } = req;

const cfg = Object.assign(
  { initialCash: 100000, fillMode: 'next_open', commission: 0, slippageBps: 0, defaultQty: 100 },
  config || {}
);

const orders = [];
const logs = [];
const plots = {};
const N = bars.length;

const closes = bars.map((b) => b.c);
const opens = bars.map((b) => b.o);
const highs = bars.map((b) => b.h);
const lows = bars.map((b) => b.l);
const volumes = bars.map((b) => b.v);

// ---- indicators: computed once over the whole series, read only up to the current bar.
// Every formula is causal (index k uses bars <= k), so precomputing cannot leak the future.
const cache = new Map();
const src = (name) => ({ close: closes, open: opens, high: highs, low: lows, volume: volumes }[name] || closes);

function series(kind, n, source) {
  const key = `${kind}:${n}:${source}`;
  if (cache.has(key)) return cache.get(key);
  const s = src(source);
  const out = new Array(N).fill(null);

  if (kind === 'sma') {
    let sum = 0;
    for (let k = 0; k < N; k++) {
      sum += s[k];
      if (k >= n) sum -= s[k - n];
      if (k >= n - 1) out[k] = sum / n;
    }
  } else if (kind === 'ema') {
    const a = 2 / (n + 1);
    let sum = 0;
    for (let k = 0; k < N; k++) {
      sum += s[k];
      if (k === n - 1) out[k] = sum / n;
      else if (k > n - 1) out[k] = s[k] * a + out[k - 1] * (1 - a);
    }
  } else if (kind === 'stdev') {
    for (let k = n - 1; k < N; k++) {
      const w = s.slice(k - n + 1, k + 1);
      const m = w.reduce((a, b) => a + b, 0) / n;
      out[k] = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / n);
    }
  } else if (kind === 'highest') {
    for (let k = n - 1; k < N; k++) out[k] = Math.max(...highs.slice(k - n + 1, k + 1));
  } else if (kind === 'lowest') {
    for (let k = n - 1; k < N; k++) out[k] = Math.min(...lows.slice(k - n + 1, k + 1));
  } else if (kind === 'roc') {
    for (let k = n; k < N; k++) out[k] = s[k - n] !== 0 ? (s[k] / s[k - n] - 1) * 100 : null;
  } else if (kind === 'rsi') {
    let ag = 0, al = 0;
    for (let k = 1; k < N; k++) {
      const ch = closes[k] - closes[k - 1];
      const g = ch > 0 ? ch : 0, l = ch < 0 ? -ch : 0;
      if (k <= n) { ag += g / n; al += l / n; if (k === n) out[k] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
      else {
        ag = (ag * (n - 1) + g) / n;
        al = (al * (n - 1) + l) / n;
        out[k] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
      }
    }
  } else if (kind === 'atr') {
    const tr = new Array(N).fill(0);
    for (let k = 0; k < N; k++) {
      tr[k] = k === 0 ? highs[k] - lows[k]
        : Math.max(highs[k] - lows[k], Math.abs(highs[k] - closes[k - 1]), Math.abs(lows[k] - closes[k - 1]));
    }
    let sum = 0;
    for (let k = 0; k < N; k++) {
      sum += tr[k];
      if (k === n - 1) out[k] = sum / n;
      else if (k > n - 1) out[k] = (out[k - 1] * (n - 1) + tr[k]) / n;
    }
  }
  cache.set(key, out);
  return out;
}

// ------------------------------------------------------------------ context
let i = 0;
let pos = 0;
let avg = 0;
let cash = cfg.initialCash;
let pending = [];

function emit(side, qty, reason) {
  const q = Math.abs(Number(qty));
  if (!isFinite(q) || q === 0) return;
  const o = { i, side, qty: q, reason: reason || '' };
  orders.push(o);
  pending.push(o);
}

// Mirror of the engine's fill logic so ctx.position / ctx.cash are accurate mid-run.
function applyFill(side, qty, price) {
  const q = side === 'buy' ? qty : -qty;
  const dir = side === 'buy' ? 1 : -1;
  const px = price * (1 + (dir * cfg.slippageBps) / 10000);
  cash -= q * px + cfg.commission;
  if (pos === 0) { avg = px; pos = q; }
  else if (Math.sign(q) === Math.sign(pos)) { avg = (avg * Math.abs(pos) + px * Math.abs(q)) / (Math.abs(pos) + Math.abs(q)); pos += q; }
  else {
    const before = pos;
    pos += q;
    if (pos !== 0 && Math.sign(pos) !== Math.sign(before)) avg = px;
  }
}

function at(arr, back) { const k = i - (back || 0); return k >= 0 && k < N ? arr[k] : null; }

// ---- price levels
// Default half-width of a level, as a fraction of its own price. "Did price come back to
// the same point" is never an exact float match, so every comparison is a 0.2% band.
const TOL_DEFAULT = 0.002;
const pivotCache = new Map();

// Every swing point as [index, price, kind]. A pivot at j is not knowable until bar
// j+right — it takes that many later bars to prove nothing exceeded it — so reads are
// gated on that confirmation index. Ties compare `>` left and `>=` right, making the last
// bar of a flat top the pivot; arbitrary, but it must match the other two runners exactly.
function pivotMarks(left, right) {
  const key = `${left}:${right}`;
  if (pivotCache.has(key)) return pivotCache.get(key);
  const out = [];
  for (let j = left; j < N - right; j++) {
    const h = highs[j], l = lows[j];
    let isHigh = true, isLow = true;
    for (let a = 1; a <= left; a++) {
      if (highs[j - a] > h) isHigh = false;
      if (lows[j - a] < l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh || isLow) {
      for (let b = 1; b <= right; b++) {
        if (highs[j + b] >= h) isHigh = false;
        if (lows[j + b] <= l) isLow = false;
      }
    }
    if (isHigh) out.push([j, h, 'high']);
    if (isLow) out.push([j, l, 'low']);
  }
  pivotCache.set(key, out);
  return out;
}

const ctx = {
  get i() { return i; },
  get bar() { return bars[i]; },
  get index() { return i; },
  get length() { return N; },
  get symbol() { return cfg.symbol; },
  get timeframe() { return cfg.timeframe; },

  get position() { return pos; },
  get avgPrice() { return pos === 0 ? 0 : avg; },
  get isLong() { return pos > 0; },
  get isShort() { return pos < 0; },
  get isFlat() { return pos === 0; },
  get cash() { return cash; },
  get equity() { return cash + pos * closes[i]; },
  get unrealized() { return pos === 0 ? 0 : pos * (closes[i] - avg); },

  get closes() { return closes.slice(0, i + 1); },
  get opens() { return opens.slice(0, i + 1); },
  get highs() { return highs.slice(0, i + 1); },
  get lows() { return lows.slice(0, i + 1); },
  get volumes() { return volumes.slice(0, i + 1); },

  close_(back) { return at(closes, back); },
  open_(back) { return at(opens, back); },
  high_(back) { return at(highs, back); },
  low_(back) { return at(lows, back); },

  buy(qty, reason) { emit('buy', qty == null ? cfg.defaultQty : qty, reason); },
  sell(qty, reason) { emit('sell', qty == null ? cfg.defaultQty : qty, reason); },
  close(reason) { if (pos > 0) emit('sell', pos, reason || 'close'); else if (pos < 0) emit('buy', -pos, reason || 'close'); },
  target(qty, reason) { const d = qty - pos; if (d > 0) emit('buy', d, reason); else if (d < 0) emit('sell', -d, reason); },

  sma(n, back, source) { return at(series('sma', n, source || 'close'), back); },
  ema(n, back, source) { return at(series('ema', n, source || 'close'), back); },
  rsi(n, back) { return at(series('rsi', n, 'close'), back); },
  atr(n, back) { return at(series('atr', n, 'close'), back); },
  stdev(n, back, source) { return at(series('stdev', n, source || 'close'), back); },
  highest(n, back) { return at(series('highest', n, 'high'), back); },
  lowest(n, back) { return at(series('lowest', n, 'low'), back); },
  roc(n, back, source) { return at(series('roc', n, source || 'close'), back); },
  crossedAbove(a, b) { return a[0] > b[0] && a[1] <= b[1]; },

  // ---- price levels: "has price been here before, and is it here again?"
  window(n, source) {
    const s = src(source || 'close');
    const k = i + 1;
    return s.slice(Math.max(0, k - n), k);
  },

  // Did that bar's range reach this price? back=1 asks about yesterday.
  touched(level, tol, back) {
    const lv = Number(level);
    if (level == null || !isFinite(lv)) return false;
    const k = i - (back || 0);
    if (k < 0 || k >= N) return false;
    const t = (tol == null ? TOL_DEFAULT : Number(tol)) * Math.abs(lv);
    return lows[k] <= lv + t && highs[k] >= lv - t;
  },

  // How many EARLIER bars reached this price — the current bar is excluded, so this
  // answers "how established is this level" before you act on today.
  countTouches(level, lookback, tol) {
    const lv = Number(level);
    if (level == null || !isFinite(lv)) return 0;
    const lb = lookback == null ? 250 : lookback;
    const t = (tol == null ? TOL_DEFAULT : Number(tol)) * Math.abs(lv);
    let c = 0;
    for (let k = Math.max(0, i - lb); k < i; k++) {
      if (lows[k] <= lv + t && highs[k] >= lv - t) c++;
    }
    return c;
  },

  // Confirmed swing highs/lows within lookback, oldest first.
  pivots(left, right, lookback, kind) {
    const L = left == null ? 2 : left, R = right == null ? 2 : right;
    const lo = i - (lookback == null ? 250 : lookback);
    const want = kind || 'both';
    const out = [];
    for (const [j, price, k] of pivotMarks(L, R)) {
      if (j + R > i) break; // index-ordered, so nothing later is confirmed either
      if (j < lo) continue;
      if (want !== 'both' && k !== want) continue;
      out.push({ price, i: j, kind: k, barsAgo: i - j });
    }
    return out;
  },

  // Swing points collapsed into price levels: pivots within tol of each other are the
  // same level, and `touches` counts how many times price turned there. Sorted by touches
  // desc, so levels()[0] is the most respected level in view.
  levels(tol, left, right, lookback, minTouches) {
    const t = tol == null ? TOL_DEFAULT : Number(tol);
    const min = minTouches == null ? 1 : minTouches;
    const clusters = [];
    for (const p of ctx.pivots(left, right, lookback, 'both')) {
      let hit = null;
      for (const c of clusters) {
        if (Math.abs(p.price - c.price) <= t * Math.abs(c.price)) { hit = c; break; }
      }
      if (!hit) {
        clusters.push({
          price: p.price, sum: p.price, touches: 1,
          highs: p.kind === 'high' ? 1 : 0, lows: p.kind === 'low' ? 1 : 0, lastI: p.i,
        });
      } else {
        hit.sum += p.price;
        hit.touches += 1;
        hit.price = hit.sum / hit.touches;
        if (p.kind === 'high') hit.highs += 1; else hit.lows += 1;
        if (p.i > hit.lastI) hit.lastI = p.i;
      }
    }
    const out = [];
    for (const c of clusters) {
      if (c.touches < min) continue;
      const kind = c.highs > c.lows ? 'high' : c.lows > c.highs ? 'low' : 'both';
      out.push({ price: c.price, kind, touches: c.touches, lastI: c.lastI, barsAgo: i - c.lastI });
    }
    // The third sort key only exists to make ties total — two runners disagreeing on the
    // order of equal-ranked levels would silently diverge their trades.
    out.sort((a, b) => (b.touches - a.touches) || (a.price - b.price) || (a.lastI - b.lastI));
    return out;
  },

  // The level today's bar is revisiting, or null. Most-touched level wins.
  retest(tol, left, right, lookback, minTouches) {
    for (const lv of ctx.levels(tol, left, right, lookback, minTouches)) {
      if (lv.lastI < i && ctx.touched(lv.price, tol)) return lv;
    }
    return null;
  },

  param(name, def) { return params && Object.prototype.hasOwnProperty.call(params, name) ? params[name] : def; },
  log(...args) {
    logs.push({ i, t: bars[i] && bars[i].t, msg: args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ') });
  },
  plot(name, value) {
    if (!plots[name]) plots[name] = new Array(N).fill(null);
    plots[name][i] = value == null || !isFinite(value) ? null : value;
  },
};

// -------------------------------------------------------------------- run
function fail(message, err, barIndex) {
  fs.writeFileSync(resPath, JSON.stringify({
    ok: false,
    error: {
      message,
      traceback: err && err.stack ? String(err.stack).split('\n').slice(0, 12).join('\n') : undefined,
      bar: barIndex,
      time: barIndex != null && bars[barIndex] ? bars[barIndex].t : undefined,
    },
    logs, plots,
  }));
  process.exit(0);
}

const sandbox = {
  console: { log: (...a) => ctx.log(...a), error: (...a) => ctx.log(...a), warn: (...a) => ctx.log(...a), info: (...a) => ctx.log(...a) },
  Math, JSON, Date, Number, String, Boolean, Array, Object, Map, Set, RegExp, Error,
  isNaN, isFinite, parseFloat, parseInt, require, ctx, params,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

try {
  vm.runInContext(code, sandbox, { filename: 'strategy.js', timeout: 15000 });
} catch (e) {
  fail(`Syntax/load error: ${e.message}`, e);
}

const onBar = sandbox.onBar || sandbox.on_bar;
const initialize = sandbox.initialize || sandbox.init;
if (typeof onBar !== 'function') {
  fail('No onBar function found. Define:  function onBar(bar, ctx) { ... }');
}

try {
  if (typeof initialize === 'function') initialize(ctx);
} catch (e) {
  fail(`Error in initialize(): ${e.message}`, e);
}

for (i = 0; i < N; i++) {
  // Fills from the previous bar's signals land at this bar's open, before you see the bar.
  if (cfg.fillMode !== 'close' && pending.length) {
    for (const o of pending) applyFill(o.side, o.qty, opens[i]);
    pending = [];
  }
  try {
    onBar(bars[i], ctx);
  } catch (e) {
    fail(`Error in onBar() at bar ${i}: ${e.message}`, e, i);
  }
  if (cfg.fillMode === 'close' && pending.length) {
    for (const o of pending) applyFill(o.side, o.qty, closes[i]);
    pending = [];
  }
}

fs.writeFileSync(resPath, JSON.stringify({ ok: true, orders, logs, plots }));
