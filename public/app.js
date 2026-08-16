'use strict';

// ------------------------------------------------------------------ helpers

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

async function api(path, body) {
  const res = await fetch(path, body === undefined
    ? {}
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({ error: 'Bad response from server' }));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

const nf = (v, d = 2) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const money = (v) => (v == null || !isFinite(v) ? '—' : (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pct = (v, d = 2) => (v == null || !isFinite(v) ? '—' : (v >= 0 ? '+' : '') + nf(v, d) + '%');
const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
// Axis money labels keep full dollars — abbreviating to "$100k" collapses a whole
// equity curve into one indistinguishable label.
const axisMoney = (v) => (Math.abs(v) >= 1e6 ? '$' + (v / 1e6).toFixed(2) + 'M' : '$' + Math.round(v).toLocaleString('en-US'));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fmtTime(t, tf) {
  const d = new Date(t);
  if (!tf || /Day|Week|Month/.test(tf)) return d.toLocaleDateString('en-US', { year: '2-digit', month: 'short', day: 'numeric' });
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const COLORS = {
  text: '#ffffff', sec: '#c3c2b7', muted: '#85847c',
  grid: '#2a2a28', axis: '#383835', surface: '#1a1a19',
  price: '#c3c2b7', equity: '#3987e5',
  plots: ['#d95926', '#c98500', '#d55181', '#9085e9'],
  buy: '#199e70', sell: '#e66767',
};

// ------------------------------------------------------------------ templates

const TEMPLATES = {
  javascript: `// Moving-average crossover. Edit freely — or paste your own.
// Required entry point: onBar(bar, ctx). Optional: initialize(ctx).

function initialize(ctx) {
  ctx.log('starting on ' + ctx.symbol + ' ' + ctx.timeframe);
}

function onBar(bar, ctx) {
  const fast = ctx.param('fast', 10);
  const slow = ctx.param('slow', 30);

  const f = ctx.sma(fast), s = ctx.sma(slow);
  const fPrev = ctx.sma(fast, 1), sPrev = ctx.sma(slow, 1);
  if (f == null || s == null || fPrev == null || sPrev == null) return;  // warmup

  ctx.plot('fast MA', f);
  ctx.plot('slow MA', s);

  const crossedUp   = fPrev <= sPrev && f > s;
  const crossedDown = fPrev >= sPrev && f < s;

  if (crossedUp && ctx.isFlat) {
    ctx.buy(100, 'golden cross');
  } else if (crossedDown && ctx.isLong) {
    ctx.close('death cross');
  }
}
`,

  python: `# Moving-average crossover. Edit freely -- or paste your own.
# Required entry point: on_bar(bar, ctx). Optional: initialize(ctx).
# Pure stdlib -- no pandas needed, ctx has the indicators built in.

def initialize(ctx):
    ctx.log("starting on", ctx.symbol, ctx.timeframe)


def on_bar(bar, ctx):
    fast = ctx.param("fast", 10)
    slow = ctx.param("slow", 30)

    f, s = ctx.sma(fast), ctx.sma(slow)
    f_prev, s_prev = ctx.sma(fast, 1), ctx.sma(slow, 1)
    if None in (f, s, f_prev, s_prev):      # warmup
        return

    ctx.plot("fast MA", f)
    ctx.plot("slow MA", s)

    crossed_up = f_prev <= s_prev and f > s
    crossed_down = f_prev >= s_prev and f < s

    if crossed_up and ctx.is_flat:
        ctx.buy(100, "golden cross")
    elif crossed_down and ctx.is_long:
        ctx.close("death cross")
`,

  ruby: `# Moving-average crossover. Edit freely -- or paste your own.
# Required entry point: on_bar(bar, ctx). Optional: initialize_strategy(ctx).
# Bars are hashes: bar['o'], bar['h'], bar['l'], bar['c'], bar['v'], bar['t'].

def initialize_strategy(ctx)
  ctx.log("starting on #{ctx.symbol} #{ctx.timeframe}")
end

def on_bar(bar, ctx)
  fast = ctx.param('fast', 10)
  slow = ctx.param('slow', 30)

  f, s = ctx.sma(fast), ctx.sma(slow)
  f_prev, s_prev = ctx.sma(fast, 1), ctx.sma(slow, 1)
  return if [f, s, f_prev, s_prev].any?(&:nil?)   # warmup

  ctx.plot('fast MA', f)
  ctx.plot('slow MA', s)

  crossed_up   = f_prev <= s_prev && f > s
  crossed_down = f_prev >= s_prev && f < s

  if crossed_up && ctx.flat?
    ctx.buy(100, 'golden cross')
  elsif crossed_down && ctx.long?
    ctx.close('death cross')
  end
end
`,
};

const API_REF = `ENTRY POINT
  javascript   function onBar(bar, ctx) {}      optional: initialize(ctx)
  python       def on_bar(bar, ctx):            optional: initialize(ctx)
  ruby         def on_bar(bar, ctx)             optional: initialize_strategy(ctx)

THE BAR            o  h  l  c  v  t     (js: bar.c   py: bar["c"]   rb: bar['c'])

ORDERS             a signal on bar i fills at the OPEN of bar i+1
  ctx.buy(qty, reason)        qty omitted -> Settings > Default qty
  ctx.sell(qty, reason)
  ctx.close(reason)           flatten whatever is open
  ctx.target(qty, reason)     order the difference to reach a signed position

POSITION           position  avg_price  is_long  is_short  is_flat  cash  equity  unrealized
                   (ruby also: long?  short?  flat?)

HISTORY            closes  opens  highs  lows  volumes     -- arrays up to the current bar
                   close_(n)  open_(n)  high_(n)  low_(n)  -- n bars back, 0 = now

INDICATORS         every one takes (length, back = 0), back = 1 is last bar's value
  sma(n)  ema(n)  rsi(n=14)  atr(n=14)  stdev(n)  highest(n)  lowest(n)  roc(n)
  sma/ema/stdev/roc take a 3rd arg: 'close' | 'open' | 'high' | 'low' | 'volume'
  returns null/None/nil during warmup -- always guard before comparing

OTHER              ctx.param(name, default)   reads the Params JSON box
                   ctx.log(...)               -> Console tab
                   ctx.plot(name, value)      -> overlays a line on the price chart
                   ctx.i  ctx.index  ctx.length  ctx.symbol  ctx.timeframe

NO LOOKAHEAD       ctx never exposes a bar past the current one. Indicators are
                   precomputed but every formula is causal, so index k only ever
                   depends on bars <= k.`;

// ------------------------------------------------------------------ state

const state = {
  languages: {},
  providers: [],
  provider: null,
  result: null,
  bars: [],
  live: null,
  liveTimer: null,
  activeTab: 'results',
};

// ------------------------------------------------------------------ editor

const codeEl = $('#code');
const gutterEl = $('#gutter');

function syncGutter() {
  const n = codeEl.value.split('\n').length;
  gutterEl.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
  gutterEl.scrollTop = codeEl.scrollTop;
}
codeEl.addEventListener('input', syncGutter);
codeEl.addEventListener('scroll', () => { gutterEl.scrollTop = codeEl.scrollTop; });
codeEl.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = codeEl.selectionStart, en = codeEl.selectionEnd;
    if (s === en) {
      codeEl.setRangeText('    ', s, en, 'end');
    } else { // indent / outdent whole lines
      const val = codeEl.value;
      const ls = val.lastIndexOf('\n', s - 1) + 1;
      const block = val.slice(ls, en);
      const next = e.shiftKey
        ? block.replace(/^ {1,4}/gm, '')
        : block.replace(/^/gm, '    ');
      codeEl.setRangeText(next, ls, en, 'end');
    }
    syncGutter();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runBacktest(); }
});

// ------------------------------------------------------------------ charting

// Generic line chart on a canvas: index-based x, single y-axis, crosshair tooltip.
function drawChart(canvas, cfg) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.parentElement.clientWidth - 24;
  const cssH = cfg.height || 220;
  canvas.style.height = cssH + 'px';
  canvas.width = Math.max(1, Math.floor(cssW * dpr));
  canvas.height = Math.floor(cssH * dpr);

  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);

  const M = { t: 8, r: 66, b: 20, l: 6 };
  const W = cssW - M.l - M.r;
  const H = cssH - M.t - M.b;
  const n = cfg.n;
  if (n < 2 || W <= 0) return;

  // y-domain across every visible series (+ marker prices)
  let lo = Infinity, hi = -Infinity;
  for (const s of cfg.series) for (const v of s.values) if (v != null && isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (cfg.baseline != null) { lo = Math.min(lo, cfg.baseline); hi = Math.max(hi, cfg.baseline); }
  if (!isFinite(lo) || !isFinite(hi)) return;
  if (lo === hi) { lo -= 1; hi += 1; }
  const padY = (hi - lo) * 0.08;
  lo -= padY; hi += padY;

  const X = (i) => M.l + (n === 1 ? 0 : (i / (n - 1)) * W);
  const Y = (v) => M.t + H - ((v - lo) / (hi - lo)) * H;

  // grid + y labels (recessive)
  g.font = '10px ui-monospace, Menlo, monospace';
  g.textBaseline = 'middle';
  const ticks = 5;
  for (let k = 0; k <= ticks; k++) {
    const v = lo + ((hi - lo) * k) / ticks;
    const y = Y(v);
    g.strokeStyle = COLORS.grid;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(M.l, Math.round(y) + 0.5); g.lineTo(M.l + W, Math.round(y) + 0.5); g.stroke();
    g.fillStyle = COLORS.muted;
    g.textAlign = 'left';
    g.fillText(cfg.yFormat ? cfg.yFormat(v) : nf(v, 2), M.l + W + 6, y);
  }

  // shaded region (e.g. the live portion of a forward test)
  if (cfg.shadeFrom != null && cfg.shadeFrom < n - 1) {
    g.fillStyle = 'rgba(57,135,229,.07)';
    g.fillRect(X(cfg.shadeFrom), M.t, X(n - 1) - X(cfg.shadeFrom), H);
  }

  // baseline (starting equity)
  if (cfg.baseline != null) {
    g.strokeStyle = COLORS.axis;
    g.lineWidth = 1;
    g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(M.l, Y(cfg.baseline)); g.lineTo(M.l + W, Y(cfg.baseline)); g.stroke();
    g.setLineDash([]);
  }

  // x labels
  g.fillStyle = COLORS.muted;
  g.textBaseline = 'top';
  // Tick count follows available width so date labels never collide.
  const xt = Math.max(1, Math.min(6, n - 1, Math.floor(W / 100)));
  for (let k = 0; k <= xt; k++) {
    const i = Math.round((k / xt) * (n - 1));
    g.textAlign = k === 0 ? 'left' : k === xt ? 'right' : 'center';
    g.fillText(fmtTime(cfg.times[i], cfg.timeframe), X(i), M.t + H + 6);
  }

  // area fill (underwater / drawdown style)
  for (const s of cfg.series) {
    if (!s.fill) continue;
    g.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const v = s.values[i];
      if (v == null || !isFinite(v)) continue;
      if (!started) { g.moveTo(X(i), Y(cfg.baseline != null ? cfg.baseline : lo)); g.lineTo(X(i), Y(v)); started = true; }
      else g.lineTo(X(i), Y(v));
    }
    if (started) {
      g.lineTo(X(n - 1), Y(cfg.baseline != null ? cfg.baseline : lo));
      g.closePath();
      g.fillStyle = s.fill;
      g.fill();
    }
  }

  // lines — 2px, drawn in series order
  for (const s of cfg.series) {
    g.strokeStyle = s.color;
    g.lineWidth = s.width || 2;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    if (s.dash) g.setLineDash(s.dash);
    g.beginPath();
    let pen = false;
    for (let i = 0; i < n; i++) {
      const v = s.values[i];
      if (v == null || !isFinite(v)) { pen = false; continue; }
      if (!pen) { g.moveTo(X(i), Y(v)); pen = true; } else g.lineTo(X(i), Y(v));
    }
    g.stroke();
    g.setLineDash([]);
  }

  // trade markers — shape carries direction, so it never depends on color alone
  for (const m of (cfg.markers || [])) {
    const x = X(m.i), y = Y(m.price);
    const up = m.side === 'buy';
    const r = 5;
    g.beginPath();
    if (up) { g.moveTo(x, y - r - 3); g.lineTo(x - r, y + r - 3); g.lineTo(x + r, y + r - 3); }
    else { g.moveTo(x, y + r + 3); g.lineTo(x - r, y - r + 3); g.lineTo(x + r, y - r + 3); }
    g.closePath();
    g.fillStyle = up ? COLORS.buy : COLORS.sell;
    g.fill();
    g.strokeStyle = COLORS.surface; // 2px surface ring keeps overlapping marks readable
    g.lineWidth = 2;
    g.stroke();
  }

  // ---- crosshair + tooltip
  const tip = $('#tip');
  canvas._hover = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    if (px < M.l || px > M.l + W) return hideTip();
    const i = Math.round(((px - M.l) / W) * (n - 1));
    if (i < 0 || i >= n) return hideTip();

    // redraw is cheap enough; repaint base then overlay the crosshair
    drawChart(canvas, { ...cfg, _noHover: true });
    const g2 = canvas.getContext('2d');
    g2.setTransform(dpr, 0, 0, dpr, 0, 0);
    g2.strokeStyle = COLORS.axis;
    g2.lineWidth = 1;
    g2.setLineDash([2, 3]);
    g2.beginPath(); g2.moveTo(Math.round(X(i)) + 0.5, M.t); g2.lineTo(Math.round(X(i)) + 0.5, M.t + H); g2.stroke();
    g2.setLineDash([]);
    for (const s of cfg.series) {
      const v = s.values[i];
      if (v == null || !isFinite(v)) continue;
      g2.beginPath(); g2.arc(X(i), Y(v), 3.5, 0, Math.PI * 2);
      g2.fillStyle = s.color; g2.fill();
      g2.strokeStyle = COLORS.surface; g2.lineWidth = 2; g2.stroke();
    }

    const rows = cfg.series
      .filter((s) => s.values[i] != null && isFinite(s.values[i]))
      .map((s) => `<div><span class="swatch" style="display:inline-block;background:${s.color}"></span> <span class="tk">${esc(s.name)}</span> ${cfg.yFormat ? cfg.yFormat(s.values[i]) : nf(s.values[i])}</div>`);
    const hits = (cfg.markers || []).filter((m) => m.i === i)
      .map((m) => `<div style="color:${m.side === 'buy' ? COLORS.buy : COLORS.sell}">${m.side === 'buy' ? '▲ BUY' : '▼ SELL'} ${nf(m.qty, 0)} @ ${nf(m.price)}${m.reason ? ' · ' + esc(m.reason) : ''}</div>`);
    tip.innerHTML = `<div class="tk">${esc(fmtTime(cfg.times[i], cfg.timeframe))}</div>${rows.join('')}${hits.join('')}`;
    tip.style.display = 'block';
    const tw = tip.offsetWidth;
    tip.style.left = Math.min(ev.clientX + 14, window.innerWidth - tw - 10) + 'px';
    tip.style.top = Math.min(ev.clientY + 14, window.innerHeight - tip.offsetHeight - 10) + 'px';
  };

  function hideTip() { tip.style.display = 'none'; }

  if (!cfg._noHover && !canvas._bound) {
    canvas._bound = true;
    canvas.addEventListener('mousemove', (ev) => canvas._hover && canvas._hover(ev));
    canvas.addEventListener('mouseleave', () => { hideTip(); if (canvas._redraw) canvas._redraw(); });
  }
  canvas._redraw = () => drawChart(canvas, { ...cfg, _noHover: true });
}

// ------------------------------------------------------------------ rendering

function statTile(k, v, sub, klass) {
  return `<div class="stat"><div class="k">${esc(k)}</div><div class="v ${klass || ''}">${v}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>`;
}

function renderResult(r, bars, opts) {
  opts = opts || {};
  const s = r.stats;
  const host = opts.host || $('#resultsBody');

  const warnings = [];
  if (r.rejected && r.rejected.length) {
    warnings.push(`${r.rejected.length} order(s) not filled — ${r.rejected[0].reason_rejected}`);
  }
  if (s.numTrades === 0) {
    warnings.push('Strategy produced no completed round trips. Check your entry conditions, or whether indicators are still in warmup for most of the range.');
  }
  // Free-tier Alpha Vantage data is not split-adjusted, and an unadjusted split reads
  // as a real overnight move — worth flagging before you believe the P&L.
  if (r.meta && r.meta.suspectSplits && r.meta.suspectSplits.length) {
    const gaps = r.meta.suspectSplits.map((x) => `${nf(x.ratio, 2)}× on ${fmtTime(x.t, r.timeframe)}`).join(', ');
    warnings.push(r.meta.adjusted
      ? `Large single-bar gap: ${gaps}. This feed is split-adjusted, so it's more likely a real move, a corporate action, or a thin symbol — but check it before trusting the P&L.`
      : `Possible unadjusted split: price gapped ${gaps}. This feed is raw, not split-adjusted, so a split looks like a real overnight move and the backtest will book it as P&L.`);
  }

  // Max range with more history than the Max-bars cap loses its OLDEST bars — silently
  // turning "since inception" into "since whenever the cap happened to land".
  if (r.meta && r.meta.truncated) {
    const t = r.meta.truncated;
    warnings.push(
      `Only the newest ${t.limit.toLocaleString()} of ${t.availableBars.toLocaleString()} bars were tested — history before ` +
      `${fmtTime(t.keptFrom, r.timeframe)} was dropped by the Max bars cap (Settings), including ${fmtTime(t.droppedFrom, r.timeframe)}. ` +
      `Raise Max bars to test the full range.`);
  }
  if (r.meta && r.meta.clamped) {
    const c = r.meta.clamped;
    warnings.push(
      `${r.timeframe} history is capped at ${c.maxDays} days by the feed, so the start was clamped forward from ` +
      `${c.requested}${c.effectiveFrom ? ` to ${c.effectiveFrom}` : ''}.${c.note ? ' ' + c.note : ''} Use 1Day or longer for deep history.`);
  }

  const PROV_NAMES = { yahoo: 'Yahoo Finance', finnhub: 'Finnhub', alphavantage: 'Alpha Vantage' };
  const provName = (r.meta && PROV_NAMES[r.meta.provider]) || (r.meta && r.meta.provider) || 'provider';
  const maxNote = r.meta && r.meta.range === 'max'
    ? ` · Max range${r.meta.inception ? ` — ${esc(r.symbol || '')} first traded ${esc(r.meta.inception.slice(0, 10))}` : ''}`
    : '';
  const src = r.meta
    ? `<div class="banner info">Data: ${esc(provName)}${r.meta.assetClass ? ` (${esc(r.meta.assetClass)})` : ''} · ${r.meta.cached ? `served from local cache (fetched ${new Date(r.meta.fetchedAt).toLocaleString()}) — 0 requests spent` : `${r.meta.apiCalls} request${r.meta.apiCalls === 1 ? '' : 's'} spent`}${r.usage ? ` · ${r.usage.used}/${r.usage.limit} ${esc(r.usage.label)}` : ''}${maxNote}</div>`
    : '';

  host.innerHTML = `
    ${warnings.map((w) => `<div class="banner warn">${esc(w)}</div>`).join('')}
    ${src}
    <div class="stats">
      ${statTile('Total return', pct(s.totalReturn), money(s.finalEquity) + ' final', cls(s.totalReturn))}
      ${statTile('vs Buy & hold', pct(s.alpha), pct(s.buyHoldReturn) + ' B&H', cls(s.alpha))}
      ${statTile('CAGR', pct(s.cagr), null, cls(s.cagr))}
      ${statTile('Sharpe', nf(s.sharpe), 'ann. vol ' + nf(s.volatility, 1) + '%')}
      ${statTile('Sortino', nf(s.sortino))}
      ${statTile('Max drawdown', pct(s.maxDrawdown), s.maxDrawdownBars + ' bars', s.maxDrawdown < 0 ? 'neg' : '')}
      ${statTile('Trades', nf(s.numTrades, 0), s.numFills + ' fills')}
      ${statTile('Win rate', nf(s.winRate, 1) + '%', `${Math.round((s.winRate / 100) * s.numTrades)}W / ${s.numTrades - Math.round((s.winRate / 100) * s.numTrades)}L`)}
      ${statTile('Profit factor', isFinite(s.profitFactor) ? nf(s.profitFactor) : '∞')}
      ${statTile('Expectancy', money(s.expectancy), 'per trade', cls(s.expectancy))}
      ${statTile('Avg win / loss', money(s.avgWin), money(s.avgLoss) + ' avg loss')}
      ${statTile('Exposure', nf(s.exposure, 1) + '%', nf(s.avgBarsHeld, 1) + ' bars held')}
    </div>

    <div class="chart-card">
      <div class="chart-title">
        <h3>${esc(r.symbol || opts.symbol || '')} price &amp; trades</h3>
        <span class="sub">${esc(r.timeframe || '')} · ${s.numBars} bars · ${esc(fmtTime(s.start, r.timeframe))} → ${esc(fmtTime(s.end, r.timeframe))}</span>
        <div class="legend" id="legPrice"></div>
      </div>
      <canvas id="cvPrice"></canvas>
    </div>

    <div class="chart-card">
      <div class="chart-title">
        <h3>Equity curve</h3>
        <span class="sub">starting ${money(s.initialCash)}</span>
        <div class="legend"><span><i class="swatch" style="background:${COLORS.equity}"></i>Strategy equity</span><span><i class="swatch" style="background:${COLORS.axis}"></i>Starting cash</span></div>
      </div>
      <canvas id="cvEquity"></canvas>
    </div>

    <div class="chart-card">
      <div class="chart-title">
        <h3>Drawdown</h3>
        <span class="sub">% below the running peak</span>
      </div>
      <canvas id="cvDD"></canvas>
    </div>
  `;

  const times = bars.map((b) => b.t);
  const plotNames = Object.keys(r.plots || {}).slice(0, 4);

  const priceSeries = [
    { name: 'Close', values: bars.map((b) => b.c), color: COLORS.price, width: 1.5 },
    ...plotNames.map((nm, k) => ({ name: nm, values: r.plots[nm], color: COLORS.plots[k], width: 2 })),
  ];

  $('#legPrice').innerHTML =
    priceSeries.map((sr) => `<span><i class="swatch" style="background:${sr.color}"></i>${esc(sr.name)}</span>`).join('') +
    `<span><i class="swatch tri-up"></i>Buy</span><span><i class="swatch tri-down"></i>Sell</span>`;

  drawChart($('#cvPrice'), {
    n: bars.length, times, timeframe: r.timeframe, height: 260,
    series: priceSeries,
    markers: r.fills.map((f) => ({ i: f.i, price: f.price, side: f.side, qty: f.qty, reason: f.reason })),
    yFormat: (v) => nf(v, 2),
    shadeFrom: opts.shadeFrom,
  });

  drawChart($('#cvEquity'), {
    n: bars.length, times, timeframe: r.timeframe, height: 200,
    series: [{ name: 'Equity', values: r.equity, color: COLORS.equity, width: 2 }],
    baseline: s.initialCash,
    yFormat: axisMoney,
    shadeFrom: opts.shadeFrom,
  });

  let peak = -Infinity;
  const dd = r.equity.map((v) => { peak = Math.max(peak, v); return peak > 0 ? (v / peak - 1) * 100 : 0; });
  drawChart($('#cvDD'), {
    n: bars.length, times, timeframe: r.timeframe, height: 130,
    series: [{ name: 'Drawdown', values: dd, color: COLORS.sell, width: 1.5, fill: 'rgba(230,103,103,.13)' }],
    baseline: 0,
    yFormat: (v) => nf(v, 1) + '%',
    shadeFrom: opts.shadeFrom,
  });
}

function renderTrades(r) {
  const pane = $('#pane-trades');
  if (!r || !r.trades || !r.trades.length) { pane.innerHTML = '<div class="empty">No completed trades.</div>'; return; }
  const rows = r.trades.map((t, k) => `
    <tr>
      <td class="l">${k + 1}</td>
      <td class="l"><span class="tag ${t.stillOpen ? 'open' : t.side}">${t.stillOpen ? 'OPEN ' + t.side.toUpperCase() : t.side.toUpperCase()}</span></td>
      <td class="l">${esc(fmtTime(t.entryTime, r.timeframe))}</td>
      <td>${nf(t.entryPrice)}</td>
      <td class="l">${t.exitTime ? esc(fmtTime(t.exitTime, r.timeframe)) : '—'}</td>
      <td>${nf(t.exitPrice)}</td>
      <td>${nf(t.qty, 0)}</td>
      <td class="${cls(t.pnl)}">${money(t.pnl)}</td>
      <td class="${cls(t.pnlPct)}">${pct(t.pnlPct)}</td>
      <td>${nf(t.barsHeld, 0)}</td>
    </tr>`).join('');
  pane.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th class="l">#</th><th class="l">Side</th><th class="l">Entry</th><th>Price</th><th class="l">Exit</th><th>Price</th><th>Qty</th><th>P&amp;L</th><th>Return</th><th>Bars</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
  $('#tradeCount').textContent = r.trades.length;
}

function renderConsole(r) {
  const pane = $('#pane-console');
  const parts = [];
  if (r.error) {
    parts.push(`<span class="err">✗ ${esc(r.error.message)}</span>`);
    if (r.error.time) parts.push(`<span class="err">  at bar ${r.error.bar} — ${esc(fmtTime(r.error.time))}</span>`);
    if (r.error.traceback) parts.push(`<span class="err">${esc(r.error.traceback)}</span>`);
    parts.push('');
  }
  for (const l of (r.logs || [])) {
    parts.push(`<span class="t">${esc(fmtTime(l.t, r.timeframe))}</span>  ${esc(l.msg)}`);
  }
  if (r.stdout && r.stdout.trim()) parts.push('\n─── stdout ───\n' + esc(r.stdout.trim()));
  if (r.stderr && r.stderr.trim()) parts.push('\n─── stderr ───\n' + esc(r.stderr.trim()));
  if (!parts.length) parts.push('(no output — use ctx.log(...) to print here)');
  pane.innerHTML = `<pre class="console">${parts.join('\n')}</pre>`;
  $('#logCount').textContent = (r.logs || []).length || '';
}

// ------------------------------------------------------------- range selector

// Every preset resolves to explicit start/end dates in the browser, so the request the
// server sees is the same shape it has always been. "max" is the one exception: only the
// data provider knows when a symbol started trading, so it travels as range:'max' and
// comes back resolved in meta.inception.
const RANGES = {
  '1m': { label: '1 month', days: 30 },
  '3m': { label: '3 months', days: 91 },
  '6m': { label: '6 months', days: 182 },
  ytd: { label: 'YTD', ytd: true },
  '1y': { label: '1 year', days: 365 },
  '2y': { label: '2 years', days: 730 },
  '5y': { label: '5 years', days: 1826 },
  '10y': { label: '10 years', days: 3653 },
  '20y': { label: '20 years', days: 7305 },
  max: { label: 'Max', max: true },
  custom: { label: 'Custom', custom: true },
};

const iso = (d) => d.toISOString().slice(0, 10);

// Intraday history is capped server-side by every provider, so a long range on a 5Min
// timeframe silently becomes a short one. Say so before the run rather than after.
const INTRADAY_CAP_DAYS = { '1Min': 7, '5Min': 60, '15Min': 60, '30Min': 60, '1Hour': 730 };

function applyRange() {
  const key = $('#range').value;
  const spec = RANGES[key] || RANGES.custom;
  const today = new Date();

  if (!spec.custom) {
    $('#end').value = iso(today);
    if (spec.max) $('#start').value = '';
    else if (spec.ytd) $('#start').value = iso(new Date(Date.UTC(today.getUTCFullYear(), 0, 1)));
    else $('#start').value = iso(new Date(today.getTime() - spec.days * 86400e3));
  } else {
    // Coming from Max the Start box is empty; hand over an editable window rather than a
    // blank one that would quietly fall back to the provider's own default lookback.
    if (!$('#start').value) $('#start').value = iso(new Date(today.getTime() - 730 * 86400e3));
    if (!$('#end').value) $('#end').value = iso(today);
  }

  // Preset dates stay visible — you should be able to read the exact window that will
  // run — but only Custom lets you edit them.
  $('#start').disabled = !spec.custom;
  $('#end').disabled = !spec.custom;
  $('#fieldStart').style.opacity = spec.max ? '.45' : '1';

  updateRangeHint();
}

function updateRangeHint() {
  const key = $('#range').value;
  const spec = RANGES[key] || RANGES.custom;
  const hint = $('#rangeHint');
  const tf = $('#timeframe').value;
  const cap = INTRADAY_CAP_DAYS[tf];
  const notes = [];

  if (spec.max) {
    const inception = state.result && state.result.meta && state.result.meta.inception;
    notes.push(inception && state.result.symbol === $('#symbol').value.trim().toUpperCase()
      ? `since ${inception.slice(0, 10)} (first trade)`
      : 'since the first traded bar');
  }
  // Only warn when the requested span actually exceeds the cap.
  if (cap) {
    const startMs = $('#start').value ? new Date($('#start').value).getTime() : null;
    const spanDays = spec.max || startMs == null ? Infinity : (Date.now() - startMs) / 86400e3;
    if (spanDays > cap) notes.push(`${tf} history is capped at ${cap} days — start will be clamped`);
  }

  hint.textContent = notes.join(' · ');
  hint.hidden = !notes.length;
}

// What the server needs: 'max' resolves provider-side, everything else is already dates.
const activeRange = () => ($('#range').value === 'max' ? 'max' : '');

function setRange(key) {
  if (!key || !RANGES[key]) return;
  $('#range').value = key;
  applyRange();
}

// ------------------------------------------------------------------ actions

function readConfig() {
  return {
    initialCash: Number($('#initialCash').value) || 100000,
    defaultQty: Number($('#defaultQty').value) || 100,
    fillMode: $('#fillMode').value,
    slippageBps: Number($('#slippageBps').value) || 0,
    commission: Number($('#commission').value) || 0,
  };
}

function readParams() {
  const raw = $('#params').value.trim();
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch (e) { throw new Error('Params box is not valid JSON: ' + e.message); }
}

function busy(btn, on, label) {
  btn.disabled = on;
  btn.innerHTML = on ? `<span class="spin"></span> ${label || 'Running…'}` : btn.dataset.label;
}

async function runBacktest() {
  const btn = $('#btnRun');
  showTab('results');
  try {
    const params = readParams();
    busy(btn, true, 'Running…');
    $('#resultsBody').innerHTML = '<div class="empty">Fetching bars (or reading local cache) and running your strategy…</div>';

    const res = await api('/api/run', {
      language: $('#language').value,
      code: codeEl.value,
      symbol: $('#symbol').value.trim(),
      timeframe: $('#timeframe').value,
      start: $('#start').value,
      end: $('#end').value,
      range: activeRange(),
      params,
      config: readConfig(),
      maxBars: Number($('#maxBars').value) || 20000,
    });

    state.result = res;
    state.bars = res.bars;
    renderUsage(res.usage);

    if (!res.ok) {
      $('#resultsBody').innerHTML =
        `<div class="banner error"><b>${esc(res.error.message)}</b>${res.error.bar != null ? `\nat bar ${res.error.bar} (${esc(fmtTime(res.error.time))})` : ''}${res.error.traceback ? '\n\n' + esc(res.error.traceback) : ''}</div>`;
      renderConsole(res);
      $('#pane-trades').innerHTML = '<div class="empty">No trades — the strategy errored.</div>';
      showTab('results');
      return;
    }

    renderResult(res, res.bars);
    renderTrades(res);
    renderConsole(res);
    updateRangeHint(); // a Max run now knows the real inception date — show it
  } catch (e) {
    $('#resultsBody').innerHTML = `<div class="banner error">${esc(e.message)}</div>`;
  } finally {
    busy(btn, false);
  }
}

// ------------------------------------------------------------------ live mode

async function toggleLive() {
  const btn = $('#btnLive');
  if (state.live && state.live.running) {
    await api('/api/live/stop', {});
    stopLivePolling();
    btn.dataset.label = '◉ Go Live';
    busy(btn, false);
    refreshLive();
    return;
  }
  try {
    busy(btn, true, 'Starting…');
    // Poll cadence depends on the provider: Finnhub's limit is per-minute so it can go
    // fast; Alpha Vantage's 25/day means minutes, not seconds. Server clamps this too.
    await api('/api/live/start', {
      symbol: $('#symbol').value.trim(),
      timeframe: $('#timeframe').value,
      language: $('#language').value,
      code: codeEl.value,
      params: readParams(),
      config: readConfig(),
      start: $('#start').value,
      range: activeRange(),
      pollSeconds: state.provider === 'finnhub'
        ? (/Min/.test($('#timeframe').value) ? 30 : 120)
        : (/Min/.test($('#timeframe').value) ? 300 : 900),
    });
    btn.dataset.label = '■ Stop Live';
    busy(btn, false);
    showTab('live');
    startLivePolling();
  } catch (e) {
    busy(btn, false);
    showTab('live');
    $('#pane-live').innerHTML = `<div class="banner error">${esc(e.message)}</div>`;
  }
}

function startLivePolling() {
  stopLivePolling();
  refreshLive();
  state.liveTimer = setInterval(refreshLive, 5000);
}
function stopLivePolling() { if (state.liveTimer) clearInterval(state.liveTimer); state.liveTimer = null; }

async function refreshLive() {
  let st;
  try { st = await api('/api/live/state'); } catch { return; }
  state.live = st;
  $('#liveBadge').textContent = st.running ? '●' : '';
  $('#btnLive').dataset.label = st.running ? '■ Stop Live' : '◉ Go Live';
  if (!$('#btnLive').disabled) $('#btnLive').innerHTML = $('#btnLive').dataset.label;

  const pane = $('#pane-live');
  if (!st.running && !st.result) {
    pane.innerHTML = '<div class="empty">Not running. <b>Go Live</b> polls your data provider for fresh bars and runs your strategy forward with simulated fills — no orders are ever placed.</div>';
    return;
  }

  if (st.usage) renderUsage(st.usage);
  const secs = st.cfg ? st.cfg.pollSeconds : 0;
  const every = secs >= 60 ? `${Math.round(secs / 60)} min` : `${secs}s`;
  const head = `
    <div class="banner ${st.lastError ? 'error' : 'info'}">
      ${st.running ? '● LIVE' : '■ STOPPED'} · ${esc(st.cfg ? st.cfg.symbol + ' ' + st.cfg.timeframe : '')} · polling every ${every}
      · ${st.barCount} bars (${st.barsAdded} new since start) · tick ${st.ticks}
      ${st.lastPoll ? '· last ' + new Date(st.lastPoll).toLocaleTimeString() : ''}
      ${st.lastError ? '\n⚠ ' + esc(st.lastError) : ''}
      <br><span style="color:var(--text-muted)">Simulated fills only — no order is ever placed anywhere.
      Each tick spends one request (~${st.cfg ? st.cfg.perHour : '—'}/hour)${st.usage ? ` against a ${st.usage.limit}-${st.usage.label === 'today' ? 'per-day' : 'per-minute'} limit` : ''}.</span>
    </div>
    <div id="liveBody"></div>`;

  if (pane.dataset.stamp !== String(st.ticks) + String(st.running)) {
    pane.innerHTML = head;
    pane.dataset.stamp = String(st.ticks) + String(st.running);
    if (st.result && st.result.ok) {
      renderResult({ ...st.result, symbol: st.cfg.symbol, timeframe: st.cfg.timeframe }, st.bars, {
        host: $('#liveBody'), shadeFrom: st.liveStartIndex,
      });
    } else if (st.result && st.result.error) {
      $('#liveBody').innerHTML = `<div class="banner error">${esc(st.result.error.message)}</div>`;
    }
  }
}

// ------------------------------------------------------------------ status

function renderUsage(u) {
  if (!u) { $('#usagePill').hidden = true; return; }
  $('#usagePill').hidden = false;
  $('#usageText').textContent = `${u.used}/${u.limit} requests ${u.label}`;
  $('#usagePill').title = `Resets: ${u.resets}. Cached data costs nothing.`;
  // A per-minute budget refilling on its own isn't worth alarming about; a daily one is.
  const tight = u.label === 'today' ? 5 : 10;
  $('#usageDot').className = 'dot ' + (u.remaining <= 0 ? 'off' : u.remaining <= tight ? 'warn' : 'on');
}

function renderProviderPicker(list, selected) {
  if (!list || !list.length) return;
  state.providers = list;
  const sel = $('#provider');
  if (sel.options.length !== list.length) {
    sel.innerHTML = list.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
  }
  sel.value = selected || sel.value || list[0].id;
  const p = list.find((x) => x.id === sel.value) || list[0];
  // A keyless provider has no field to fill and no key page to visit — hide both rather
  // than showing an input that does nothing.
  $('#apiKey').placeholder = p.keyPlaceholder || '';
  $('#apiKey').disabled = !!p.keyless;
  $('#apiKey').hidden = !!p.keyless;
  $('#keyLink').innerHTML = p.keyless ? '' : `— <a href="${esc(p.keyUrl)}" target="_blank" rel="noreferrer">get one</a>`;
  $('#btnConnect').textContent = p.keyless ? 'Use Yahoo (no key)' : 'Connect';
  $('#provLimit').textContent = p.limitNote || '';
  $('#provWarn').innerHTML = p.warning ? esc(p.warning) : '';
  $('#provWarn').hidden = !p.warning;
}

async function refreshStatus() {
  try {
    const st = await api('/api/status');
    const dot = $('#connDot'), txt = $('#connText');
    if (st.connected) {
      dot.className = 'dot on';
      txt.textContent = `${st.providerLabel} · ${st.keyPreview}`;
      state.provider = st.provider;
    } else {
      dot.className = 'dot off';
      txt.textContent = 'no API key';
      // Only nag when a key is genuinely required; the default provider needs none.
      const dflt = (st.providers || []).find((p) => p.id === st.default);
      if (!dflt || !dflt.keyless) $('#keysModal').classList.add('open');
    }
    renderProviderPicker(st.providers, st.provider || st.default);
    renderUsage(st.usage);
  } catch {
    $('#connDot').className = 'dot off';
    $('#connText').textContent = 'server unreachable';
    $('#usagePill').hidden = true;
  }
}

async function loadLanguages() {
  const { languages } = await api('/api/languages');
  state.languages = languages;
  const sel = $('#language');
  sel.innerHTML = Object.values(languages)
    .map((l) => `<option value="${l.id}"${l.available ? '' : ' disabled'}>${esc(l.label)}${l.available ? '' : ' (not installed)'}</option>`)
    .join('');
  const first = Object.values(languages).find((l) => l.available);
  if (first) sel.value = first.id;
  $('#langPill').textContent = Object.values(languages).filter((l) => l.available).map((l) => l.label).join(' · ') || 'no runtimes';
  updateEntryHint();
}

function updateEntryHint() {
  const l = state.languages[$('#language').value];
  $('#entryHint').textContent = l ? l.entry : '';
}

// ------------------------------------------------------------------ tabs & modals

function showTab(name) {
  state.activeTab = name;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tabpane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + name));
}
$$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

const modal = (id, open) => $(id).classList.toggle('open', open);
$('#btnKeys').onclick = () => modal('#keysModal', true);
$('#btnKeysClose').onclick = () => modal('#keysModal', false);
$('#btnSettings').onclick = () => modal('#settingsModal', true);
$('#btnSettingsClose').onclick = () => modal('#settingsModal', false);
$('#btnApiRef').onclick = () => { $('#apiRefBody').textContent = API_REF; modal('#apiModal', true); };
$('#btnApiClose').onclick = () => modal('#apiModal', false);
$('#btnSaveClose').onclick = () => modal('#saveModal', false);
$('#btnLoadClose').onclick = () => modal('#loadModal', false);
$$('.modal-back').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('open'); }));

$('#provider').addEventListener('change', () => renderProviderPicker(state.providers, $('#provider').value));

$('#btnConnect').onclick = async () => {
  const msg = $('#keysMsg');
  const provId = $('#provider').value;
  const prov = state.providers.find((p) => p.id === provId);
  msg.innerHTML = `<div class="banner info">Verifying with ${esc(prov ? prov.label : provId)}…</div>`;
  try {
    const r = await api('/api/connect', { provider: provId, apiKey: $('#apiKey').value });
    msg.innerHTML = `<div class="banner info">Connected to ${esc(r.providerLabel)}. ${r.keyless ? 'No key needed.' : 'Key saved locally.'} Test quote: ${esc(r.quote.symbol)} @ ${nf(r.quote.price)}.</div>`;
    await refreshStatus();
    setTimeout(() => modal('#keysModal', false), 1200);
  } catch (e) {
    msg.innerHTML = `<div class="banner error">${esc(e.message)}</div>`;
  }
};
$('#btnDisconnect').onclick = async () => { await api('/api/disconnect', {}); $('#keysMsg').innerHTML = ''; $('#apiKey').value = ''; refreshStatus(); };

$('#btnTemplate').onclick = () => {
  const lang = $('#language').value;
  if (codeEl.value.trim() && !confirm('Replace the editor contents with the ' + lang + ' template?')) return;
  codeEl.value = TEMPLATES[lang] || '';
  syncGutter();
};

$('#btnSave').onclick = () => modal('#saveModal', true);
$('#btnSaveConfirm').onclick = async () => {
  const name = $('#saveName').value.trim();
  if (!name) return;
  await api('/api/strategies', {
    name, language: $('#language').value, code: codeEl.value,
    params: $('#params').value, symbol: $('#symbol').value, timeframe: $('#timeframe').value,
    range: $('#range').value, start: $('#start').value, end: $('#end').value,
    config: readConfig(),
  });
  modal('#saveModal', false);
};

$('#btnLoad').onclick = async () => {
  const { strategies } = await api('/api/strategies');
  $('#stratList').innerHTML = strategies.length
    ? strategies.map((s) => `<li>
        <span class="nm">${esc(s.name)}</span>
        <span class="meta">${esc(s.language)} · ${esc(new Date(s.savedAt).toLocaleDateString())}</span>
        <button data-open="${esc(s.file)}">Open</button>
        <button class="danger" data-del="${esc(s.file)}">✕</button></li>`).join('')
    : '<div class="empty">Nothing saved yet.</div>';
  modal('#loadModal', true);
};

$('#stratList').addEventListener('click', async (e) => {
  const open = e.target.dataset.open, del = e.target.dataset.del;
  if (open) {
    const s = await api('/api/strategies/load', { file: open });
    codeEl.value = s.code;
    $('#language').value = s.language;
    if (s.params) $('#params').value = typeof s.params === 'string' ? s.params : JSON.stringify(s.params);
    if (s.symbol) $('#symbol').value = s.symbol;
    if (s.timeframe) $('#timeframe').value = s.timeframe;
    // Older saves predate the range selector; they carry dates only, which is Custom.
    if (s.range) {
      if (s.range === 'custom') { $('#start').value = s.start || ''; $('#end').value = s.end || ''; }
      setRange(s.range);
    } else if (s.start || s.end) {
      $('#start').value = s.start || ''; $('#end').value = s.end || '';
      setRange('custom');
    }
    syncGutter(); updateEntryHint();
    modal('#loadModal', false);
  }
  if (del) { await api('/api/strategies/delete', { file: del }); $('#btnLoad').click(); }
});

$('#language').addEventListener('change', () => {
  updateEntryHint();
  const cur = codeEl.value.trim();
  const isTemplate = Object.values(TEMPLATES).some((t) => t.trim() === cur);
  if (!cur || isTemplate) { codeEl.value = TEMPLATES[$('#language').value] || ''; syncGutter(); }
});

$('#range').addEventListener('change', applyRange);
$('#timeframe').addEventListener('change', updateRangeHint);
$('#symbol').addEventListener('input', updateRangeHint);
// Typing a date is itself the request for a custom window — no need to pick Custom first.
for (const id of ['#start', '#end']) {
  $(id).addEventListener('change', () => { if ($('#range').value !== 'custom') setRange('custom'); else updateRangeHint(); });
}

$('#btnRun').dataset.label = '▶ Run Backtest';
$('#btnLive').dataset.label = '◉ Go Live';
$('#btnRun').onclick = runBacktest;
$('#btnLive').onclick = toggleLive;

let resizeT;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => {
    if (state.result && state.result.ok && state.activeTab === 'results') renderResult(state.result, state.bars);
    else if (state.activeTab === 'live' && state.live) { $('#pane-live').dataset.stamp = ''; refreshLive(); }
  }, 180);
});

// ------------------------------------------------------------------ boot

(function init() {
  applyRange(); // fills start/end from the default 2-year preset

  loadLanguages().then(() => {
    codeEl.value = TEMPLATES[$('#language').value] || TEMPLATES.python;
    syncGutter();
  });
  refreshStatus();
  refreshLive();
  setInterval(refreshStatus, 60000);
})();
