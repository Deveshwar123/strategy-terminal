'use strict';
// Backtest engine: spawns a language runner, then simulates fills and computes stats.
// The runner is responsible ONLY for turning bars into orders. All money math lives here,
// so every language produces identical results from identical signals.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const RUNNER_DIR = path.join(__dirname, 'runners');

// To add a language: drop a harness in runners/ and add an entry here.
const LANGUAGES = {
  javascript: { label: 'JavaScript', cmd: 'node',    file: 'javascript.js', probe: ['--version'], entry: 'onBar(bar, ctx)' },
  python:     { label: 'Python',     cmd: 'python3', file: 'python.py',     probe: ['--version'], entry: 'on_bar(bar, ctx)' },
  ruby:       { label: 'Ruby',       cmd: 'ruby',    file: 'ruby.rb',       probe: ['--version'], entry: 'on_bar(bar, ctx)' },
};

const BARS_PER_YEAR = {
  '1Min': 252 * 390, '5Min': 252 * 78, '15Min': 252 * 26, '30Min': 252 * 13,
  '1Hour': 252 * 7, '4Hour': 252 * 2, '1Day': 252, '1Week': 52, '1Month': 12,
};

function probeLanguages() {
  const { execFileSync } = require('node:child_process');
  const out = {};
  for (const [id, L] of Object.entries(LANGUAGES)) {
    let version = null;
    try {
      version = String(execFileSync(L.cmd, L.probe, { timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }))
        .trim().split('\n')[0];
    } catch { version = null; }
    out[id] = { id, label: L.label, cmd: L.cmd, entry: L.entry, available: !!version, version };
  }
  return out;
}

// ---------------------------------------------------------------- runner IPC

// The runner reads a request JSON file and writes a response JSON file. Using files
// (not stdout) leaves stdout/stderr free for the strategy's own prints, which we
// surface in the terminal console.
function runStrategy({ language, code, bars, params, config, timeoutMs = 60000 }) {
  const L = LANGUAGES[language];
  if (!L) return Promise.reject(new Error(`Unknown language: ${language}`));

  const id = crypto.randomBytes(6).toString('hex');
  const tmp = os.tmpdir();
  const reqPath = path.join(tmp, `strat-req-${id}.json`);
  const resPath = path.join(tmp, `strat-res-${id}.json`);

  fs.writeFileSync(reqPath, JSON.stringify({ code, bars, params: params || {}, config }));

  return new Promise((resolve) => {
    const child = spawn(L.cmd, [path.join(RUNNER_DIR, L.file), reqPath, resPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '', stderr = '', killed = false;
    const cap = 200000; // don't let a runaway print loop eat memory
    child.stdout.on('data', (d) => { if (stdout.length < cap) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < cap) stderr += d; });

    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      resolve({ ok: false, error: { message: `Could not start ${L.cmd}: ${err.message}` }, stdout, stderr });
    });

    child.on('close', (codeNum) => {
      clearTimeout(timer);
      let res = null;
      try { res = JSON.parse(fs.readFileSync(resPath, 'utf8')); } catch { /* runner died before writing */ }
      cleanup();

      if (killed) {
        return resolve({ ok: false, error: { message: `Strategy timed out after ${timeoutMs / 1000}s (infinite loop?)` }, stdout, stderr });
      }
      if (!res) {
        return resolve({
          ok: false,
          error: { message: `Runner exited (code ${codeNum}) without producing a result.`, traceback: stderr.slice(-4000) },
          stdout, stderr,
        });
      }
      res.stdout = stdout;
      res.stderr = stderr;
      resolve(res);
    });

    function cleanup() {
      for (const p of [reqPath, resPath]) { try { fs.unlinkSync(p); } catch {} }
    }
  });
}

// ------------------------------------------------------------- fill simulation

// Orders carry the bar index they were generated on. A market order signalled on
// bar i fills at the OPEN of bar i+1 -- the earliest price you could realistically
// have transacted at. `fillMode: "close"` fills at bar i's close instead (optimistic).
function simulate(bars, orders, config) {
  const cfg = Object.assign(
    { initialCash: 100000, fillMode: 'next_open', commission: 0, slippageBps: 0, allowShort: true },
    config || {}
  );

  const n = bars.length;
  const fillsByIndex = new Map();
  const fills = [];
  const rejected = [];

  const sorted = [...(orders || [])].sort((a, b) => (a.i - b.i) || 0);

  for (const o of sorted) {
    const i = o.i;
    let fi, px;
    if (cfg.fillMode === 'close') { fi = i; px = bars[i] && bars[i].c; }
    else { fi = i + 1; px = bars[fi] && bars[fi].o; }

    if (fi >= n || !isFinite(px)) {
      rejected.push({ ...o, reason_rejected: 'signal on final bar — no price left to fill against' });
      continue;
    }
    const qty = Number(o.qty);
    if (!isFinite(qty) || qty === 0) {
      rejected.push({ ...o, reason_rejected: 'zero or invalid quantity' });
      continue;
    }
    const dir = o.side === 'buy' ? 1 : -1;
    // Slippage always works against you.
    const fillPx = px * (1 + (dir * cfg.slippageBps) / 10000);
    const fill = { i: fi, signalIndex: i, t: bars[fi].t, side: o.side, qty: Math.abs(qty), price: fillPx, reason: o.reason || '' };
    fills.push(fill);
    if (!fillsByIndex.has(fi)) fillsByIndex.set(fi, []);
    fillsByIndex.get(fi).push(fill);
  }

  // Walk the bars applying fills, tracking cash / position / round-trip trades.
  let cash = cfg.initialCash;
  let pos = 0;          // signed shares
  let avg = 0;          // average entry price of the open position
  let realized = 0;
  const equity = new Array(n);
  const posSeries = new Array(n);
  const trades = [];
  let open = null;      // current round trip
  let barsInMarket = 0;

  for (let k = 0; k < n; k++) {
    for (const f of (fillsByIndex.get(k) || [])) {
      const q = f.side === 'buy' ? f.qty : -f.qty;
      cash -= q * f.price;
      cash -= cfg.commission;

      if (pos === 0) {
        avg = f.price;
        pos = q;
        open = { entryIndex: k, entryTime: f.t, side: q > 0 ? 'long' : 'short', entryPrice: f.price, qty: Math.abs(q), pnl: 0, fees: cfg.commission };
      } else if (Math.sign(q) === Math.sign(pos)) {
        // adding to the position
        avg = (avg * Math.abs(pos) + f.price * Math.abs(q)) / (Math.abs(pos) + Math.abs(q));
        pos += q;
        if (open) { open.qty = Math.abs(pos); open.entryPrice = avg; open.fees += cfg.commission; }
      } else {
        // reducing / closing / flipping
        const closing = Math.min(Math.abs(pos), Math.abs(q));
        const pnl = closing * (f.price - avg) * Math.sign(pos);
        realized += pnl;
        if (open) { open.pnl += pnl; open.fees += cfg.commission; }
        const before = pos;
        pos += q;

        if (pos === 0 || Math.sign(pos) !== Math.sign(before)) {
          if (open) {
            open.exitIndex = k; open.exitTime = f.t; open.exitPrice = f.price;
            open.pnlPct = open.entryPrice ? (open.pnl / (open.entryPrice * open.qty)) * 100 : 0;
            open.barsHeld = k - open.entryIndex;
            trades.push(open);
            open = null;
          }
          if (pos !== 0) { // flipped straight into the other direction
            avg = f.price;
            open = { entryIndex: k, entryTime: f.t, side: pos > 0 ? 'long' : 'short', entryPrice: f.price, qty: Math.abs(pos), pnl: 0, fees: 0 };
          }
        }
      }
    }

    if (pos !== 0) barsInMarket++;
    posSeries[k] = pos;
    equity[k] = cash + pos * bars[k].c;
  }

  // A position still open at the end is marked to market, not force-closed.
  let openTrade = null;
  if (open && pos !== 0) {
    const last = bars[n - 1];
    open.exitIndex = null; open.exitTime = null; open.exitPrice = last.c;
    open.pnl += Math.abs(pos) * (last.c - avg) * Math.sign(pos);
    open.pnlPct = open.entryPrice ? (open.pnl / (open.entryPrice * open.qty)) * 100 : 0;
    open.barsHeld = (n - 1) - open.entryIndex;
    open.stillOpen = true;
    openTrade = open;
    trades.push(open);
  }

  return {
    equity, posSeries, fills, trades, rejected,
    finalCash: cash, finalPosition: pos, realizedPnl: realized, openTrade,
    exposure: n ? barsInMarket / n : 0,
    config: cfg,
  };
}

// -------------------------------------------------------------------- statistics

function computeStats(bars, sim, timeframe, initialCash) {
  const eq = sim.equity;
  const n = eq.length;
  if (!n) return {};

  const final = eq[n - 1];
  const totalReturn = (final / initialCash - 1) * 100;

  // Per-bar returns
  const rets = [];
  for (let i = 1; i < n; i++) {
    const prev = eq[i - 1];
    rets.push(prev !== 0 ? eq[i] / prev - 1 : 0);
  }
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const variance = rets.length > 1 ? rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1) : 0;
  const sd = Math.sqrt(variance);
  const downside = rets.filter((r) => r < 0);
  const dsd = downside.length
    ? Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / downside.length)
    : 0;

  const ppy = BARS_PER_YEAR[timeframe] || 252;
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(ppy) : 0;
  const sortino = dsd > 0 ? (mean / dsd) * Math.sqrt(ppy) : 0;

  // Max drawdown
  let peak = eq[0], maxDD = 0, ddStart = 0, worstStart = 0, worstEnd = 0, curDDLen = 0, maxDDLen = 0;
  for (let i = 0; i < n; i++) {
    if (eq[i] > peak) { peak = eq[i]; ddStart = i; curDDLen = 0; }
    else { curDDLen = i - ddStart; if (curDDLen > maxDDLen) maxDDLen = curDDLen; }
    const dd = peak !== 0 ? (eq[i] / peak - 1) * 100 : 0;
    if (dd < maxDD) { maxDD = dd; worstStart = ddStart; worstEnd = i; }
  }

  // Annualised return over the actual calendar span
  const t0 = new Date(bars[0].t).getTime();
  const t1 = new Date(bars[n - 1].t).getTime();
  const years = Math.max((t1 - t0) / (365.25 * 24 * 3600 * 1000), 1 / 365.25);
  const cagr = (Math.pow(final / initialCash, 1 / years) - 1) * 100;

  const closed = sim.trades;
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));

  const bh = ((bars[n - 1].c / bars[0].o) - 1) * 100;

  return {
    initialCash,
    finalEquity: final,
    totalReturn,
    cagr,
    sharpe,
    sortino,
    maxDrawdown: maxDD,
    maxDrawdownBars: maxDDLen,
    drawdownWindow: [worstStart, worstEnd],
    volatility: sd * Math.sqrt(ppy) * 100,
    numTrades: closed.length,
    numFills: sim.fills.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    expectancy: closed.length ? closed.reduce((a, t) => a + t.pnl, 0) / closed.length : 0,
    bestTrade: closed.length ? Math.max(...closed.map((t) => t.pnl)) : 0,
    worstTrade: closed.length ? Math.min(...closed.map((t) => t.pnl)) : 0,
    avgBarsHeld: closed.length ? closed.reduce((a, t) => a + (t.barsHeld || 0), 0) / closed.length : 0,
    exposure: sim.exposure * 100,
    buyHoldReturn: bh,
    alpha: totalReturn - bh,
    periodsPerYear: ppy,
    start: bars[0].t,
    end: bars[n - 1].t,
    numBars: n,
  };
}

async function backtest({ language, code, bars, params, config }) {
  const t0 = Date.now();
  const res = await runStrategy({ language, code, bars, params, config });
  if (!res.ok) return { ok: false, error: res.error, logs: res.logs || [], stdout: res.stdout, stderr: res.stderr };

  const sim = simulate(bars, res.orders, config);
  const stats = computeStats(bars, sim, config.timeframe, sim.config.initialCash);

  return {
    ok: true,
    stats,
    equity: sim.equity,
    position: sim.posSeries,
    fills: sim.fills,
    trades: sim.trades,
    rejected: sim.rejected,
    plots: res.plots || {},
    logs: res.logs || [],
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    orderCount: (res.orders || []).length,
    elapsedMs: Date.now() - t0,
  };
}

module.exports = { LANGUAGES, probeLanguages, runStrategy, simulate, computeStats, backtest, BARS_PER_YEAR };
