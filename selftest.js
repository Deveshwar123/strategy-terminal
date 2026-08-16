'use strict';
// Self-test: no Alpaca keys needed. Generates synthetic bars, runs the same MA-crossover
// strategy through every installed runtime, and asserts they emit identical orders and
// identical backtest stats.  Run with:  node selftest.js

const engine = require('./engine');

// Deterministic random walk with a couple of regime changes, so a crossover strategy
// actually trades instead of sitting flat.
function makeBars(n) {
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const bars = [];
  let price = 100;
  const t0 = Date.UTC(2023, 0, 3, 14, 30);
  for (let i = 0; i < n; i++) {
    const drift = i < n / 3 ? 0.06 : i < (2 * n) / 3 ? -0.05 : 0.04;
    price = Math.max(5, price + drift + (rnd() - 0.5) * 1.6);
    const o = price + (rnd() - 0.5) * 0.4;
    const c = price + (rnd() - 0.5) * 0.4;
    bars.push({
      t: new Date(t0 + i * 86400000).toISOString(),
      o: +o.toFixed(2), c: +c.toFixed(2),
      h: +(Math.max(o, c) + rnd() * 0.5).toFixed(2),
      l: +(Math.min(o, c) - rnd() * 0.5).toFixed(2),
      v: Math.round(1e6 + rnd() * 5e5),
    });
  }
  return bars;
}

const STRATS = {
  javascript: `
function onBar(bar, ctx) {
  const f = ctx.sma(10), s = ctx.sma(30);
  const fp = ctx.sma(10, 1), sp = ctx.sma(30, 1);
  if (f == null || s == null || fp == null || sp == null) return;
  ctx.plot('fast', f);
  if (fp <= sp && f > s && ctx.isFlat) ctx.buy(100, 'cross up');
  else if (fp >= sp && f < s && ctx.isLong) ctx.close('cross down');
}`,
  python: `
def on_bar(bar, ctx):
    f, s = ctx.sma(10), ctx.sma(30)
    fp, sp = ctx.sma(10, 1), ctx.sma(30, 1)
    if None in (f, s, fp, sp):
        return
    ctx.plot('fast', f)
    if fp <= sp and f > s and ctx.is_flat:
        ctx.buy(100, 'cross up')
    elif fp >= sp and f < s and ctx.is_long:
        ctx.close('cross down')
`,
  ruby: `
def on_bar(bar, ctx)
  f, s = ctx.sma(10), ctx.sma(30)
  fp, sp = ctx.sma(10, 1), ctx.sma(30, 1)
  return if [f, s, fp, sp].any?(&:nil?)
  ctx.plot('fast', f)
  if fp <= sp && f > s && ctx.flat?
    ctx.buy(100, 'cross up')
  elsif fp >= sp && f < s && ctx.long?
    ctx.close('cross down')
  end
end
`,
};

// Level retests: pivots, clustering and tolerance bands are ~80 lines of hand-ported
// logic in each runner, and a one-character difference in a tie-break would show up as a
// silently different trade list rather than an error. Same strategy, all three languages.
const LEVEL_STRATS = {
  javascript: `
function onBar(bar, ctx) {
  if (ctx.i === 300) ctx.log('levels=' + ctx.levels(0.004).length + ' pivots=' + ctx.pivots(2, 2, 250).length +
    ' touches=' + ctx.countTouches(ctx.high_(1), 250, 0.004));
  const lv = ctx.retest(0.004, 2, 2, 250, 2);
  if (!lv) return;
  if (lv.kind === 'low' && ctx.isFlat) ctx.buy(100, 'retest support');
  else if (lv.kind === 'high' && ctx.isLong) ctx.close('retest resistance');
}`,
  python: `
def on_bar(bar, ctx):
    if ctx.i == 300:
        ctx.log('levels=%d pivots=%d touches=%d' % (
            len(ctx.levels(0.004)), len(ctx.pivots(2, 2, 250)),
            ctx.count_touches(ctx.high_(1), 250, 0.004)))
    lv = ctx.retest(0.004, 2, 2, 250, 2)
    if lv is None:
        return
    if lv['kind'] == 'low' and ctx.is_flat:
        ctx.buy(100, 'retest support')
    elif lv['kind'] == 'high' and ctx.is_long:
        ctx.close('retest resistance')
`,
  ruby: `
def on_bar(bar, ctx)
  if ctx.index == 300
    ctx.log("levels=#{ctx.levels(0.004).length} pivots=#{ctx.pivots(2, 2, 250).length} " \\
            "touches=#{ctx.count_touches(ctx.high_(1), 250, 0.004)}")
  end
  lv = ctx.retest(0.004, 2, 2, 250, 2)
  return if lv.nil?

  if lv['kind'] == 'low' && ctx.flat?
    ctx.buy(100, 'retest support')
  elsif lv['kind'] == 'high' && ctx.long?
    ctx.close('retest resistance')
  end
end
`,
};

// A strategy that reads ctx.position / ctx.cash mid-run, to confirm the harnesses'
// mirrored portfolio state matches the engine's authoritative accounting.
const STATE_STRATS = {
  javascript: `
function onBar(bar, ctx) {
  if (ctx.i === 50) ctx.buy(10, 'open');
  if (ctx.i === 60) ctx.log('pos=' + ctx.position + ' avg=' + ctx.avgPrice.toFixed(4) + ' cash=' + ctx.cash.toFixed(4));
  if (ctx.i === 70) ctx.close('flat');
}`,
  python: `
def on_bar(bar, ctx):
    if ctx.i == 50:
        ctx.buy(10, 'open')
    if ctx.i == 60:
        ctx.log('pos=%s avg=%.4f cash=%.4f' % (ctx.position, ctx.avg_price, ctx.cash))
    if ctx.i == 70:
        ctx.close('flat')
`,
  ruby: `
def on_bar(bar, ctx)
  ctx.buy(10, 'open') if ctx.index == 50
  ctx.log(format('pos=%s avg=%.4f cash=%.4f', ctx.position, ctx.avg_price, ctx.cash)) if ctx.index == 60
  ctx.close('flat') if ctx.index == 70
end
`,
};

const CONFIG = { initialCash: 100000, defaultQty: 100, fillMode: 'next_open', commission: 1, slippageBps: 5, symbol: 'TEST', timeframe: '1Day' };

let failures = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failures++;
}

(async () => {
  const bars = makeBars(400);
  const langs = engine.probeLanguages();
  const available = Object.values(langs).filter((l) => l.available).map((l) => l.id);

  console.log('\nRuntimes detected:');
  for (const l of Object.values(langs)) console.log(`  ${l.available ? '✓' : '·'} ${l.label.padEnd(11)} ${l.version || 'not installed'}`);
  if (!available.length) { console.error('\nNo runtimes available — nothing to test.'); process.exit(1); }

  console.log(`\nCross-language determinism (${bars.length} synthetic bars, MA 10/30):`);
  const results = {};
  for (const id of available) {
    const r = await engine.backtest({ language: id, code: STRATS[id], bars, params: {}, config: CONFIG });
    if (!r.ok) { console.log(`  ✗ ${id} errored: ${r.error.message}\n${r.error.traceback || ''}`); failures++; continue; }
    results[id] = r;
    console.log(`  · ${id.padEnd(11)} ${String(r.stats.numTrades).padStart(3)} trades  ` +
      `return ${r.stats.totalReturn.toFixed(2).padStart(7)}%  sharpe ${r.stats.sharpe.toFixed(2).padStart(6)}  ` +
      `maxDD ${r.stats.maxDrawdown.toFixed(2).padStart(7)}%  ${String(r.elapsedMs).padStart(4)}ms`);
  }

  const ids = Object.keys(results);
  if (ids.length > 1) {
    const base = results[ids[0]];
    const sig = (r) => JSON.stringify(r.fills.map((f) => [f.i, f.side, f.qty, +f.price.toFixed(6)]));
    for (const id of ids.slice(1)) {
      check(`${id} fills identical to ${ids[0]}`, sig(results[id]) === sig(base), 'fill sequences diverge');
      check(`${id} equity identical to ${ids[0]}`,
        Math.abs(results[id].stats.finalEquity - base.stats.finalEquity) < 1e-6,
        `${results[id].stats.finalEquity} vs ${base.stats.finalEquity}`);
    }
  }
  check('strategy actually traded', base_trades(results, ids) > 3, 'too few trades to be a meaningful test');

  // ---- price levels agree across languages
  console.log('\nLevel retests (pivots, clustering, tolerance bands):');
  const levelResults = {};
  for (const id of available) {
    const r = await engine.backtest({ language: id, code: LEVEL_STRATS[id], bars, params: {}, config: CONFIG });
    if (!r.ok) { check(`${id} level strategy runs`, false, r.error.message); continue; }
    levelResults[id] = r;
    const seen = (r.logs[0] || {}).msg || '';
    console.log(`  · ${id.padEnd(11)} ${String(r.stats.numTrades).padStart(3)} trades  ${seen}`);
  }
  const lids = Object.keys(levelResults);
  if (lids.length) {
    const first = levelResults[lids[0]];
    // A level strategy that never fires would pass every equality check below by doing
    // nothing at all, so prove it actually found levels and traded on them.
    check('levels found and traded', first.stats.numTrades > 0 && /levels=[1-9]/.test((first.logs[0] || {}).msg || ''),
      `${first.stats.numTrades} trades, log: ${(first.logs[0] || {}).msg || 'none'}`);
    check('pivots confirmed, not clairvoyant', /pivots=[1-9]/.test((first.logs[0] || {}).msg || ''),
      (first.logs[0] || {}).msg || 'no log');
    const sig = (r) => JSON.stringify(r.fills.map((f) => [f.i, f.side, f.qty, +f.price.toFixed(6)]));
    for (const id of lids.slice(1)) {
      check(`${id} level fills identical to ${lids[0]}`, sig(levelResults[id]) === sig(first), 'level trade lists diverge');
      check(`${id} level counts identical to ${lids[0]}`,
        ((levelResults[id].logs[0] || {}).msg || '') === ((first.logs[0] || {}).msg || ''),
        `${(levelResults[id].logs[0] || {}).msg} vs ${(first.logs[0] || {}).msg}`);
    }
  }

  // ---- portfolio state parity between harness and engine
  console.log('\nHarness portfolio state vs engine accounting:');
  for (const id of available) {
    const r = await engine.backtest({ language: id, code: STATE_STRATS[id], bars, params: {}, config: CONFIG });
    if (!r.ok) { check(`${id} state strategy runs`, false, r.error.message); continue; }
    const logged = (r.logs[0] || {}).msg || '';
    const m = /pos=([\d.]+) avg=([\d.]+) cash=([-\d.]+)/.exec(logged);
    if (!m) { check(`${id} reported state`, false, 'no log captured: ' + logged); continue; }
    // Engine's own view at bar 60: one buy of 10 filled at bar 51's open + slippage.
    const fill = r.fills[0];
    const expectedCash = CONFIG.initialCash - 10 * fill.price - CONFIG.commission;
    check(`${id} position`, Number(m[1]) === 10, `got ${m[1]}`);
    check(`${id} avg price matches fill`, Math.abs(Number(m[2]) - fill.price) < 1e-3, `${m[2]} vs ${fill.price}`);
    check(`${id} cash matches engine`, Math.abs(Number(m[3]) - expectedCash) < 1e-3, `${m[3]} vs ${expectedCash}`);
  }

  // ---- no-lookahead guard: a strategy that only ever sees the past cannot see the future
  console.log('\nLookahead guard:');
  const peek = await engine.backtest({
    language: available[0],
    code: available[0] === 'python'
      ? 'def on_bar(bar, ctx):\n    if ctx.i == 10:\n        ctx.log("len=%d last=%s" % (len(ctx.closes), ctx.closes[-1]))\n'
      : available[0] === 'ruby'
        ? "def on_bar(bar, ctx)\n  ctx.log(\"len=#{ctx.closes.length} last=#{ctx.closes.last}\") if ctx.index == 10\nend\n"
        : 'function onBar(bar, ctx){ if (ctx.i === 10) ctx.log("len=" + ctx.closes.length + " last=" + ctx.closes[ctx.closes.length-1]); }',
    bars, params: {}, config: CONFIG,
  });
  const pm = /len=(\d+) last=([\d.]+)/.exec((peek.logs[0] || {}).msg || '');
  check('history length == bar index + 1', pm && Number(pm[1]) === 11, pm ? `got ${pm[1]}` : 'no log');
  check('last visible close == current bar close', pm && Math.abs(Number(pm[2]) - bars[10].c) < 1e-9, pm ? `${pm[2]} vs ${bars[10].c}` : 'no log');

  // Pivots are the one place lookahead could hide: confirming a swing high genuinely
  // requires bars AFTER it, and the whole pivot array is precomputed over the full series.
  // If that precomputation leaked, the view at bar 300 would improve when bars 301+ exist.
  // Truncating the series to end at 300 must therefore change nothing.
  const probe = available[0];
  const levelPeek = probe === 'python'
    ? "def on_bar(bar, ctx):\n    if ctx.i == 300:\n        L = ctx.levels(0.004)\n        ctx.log('p=%d l=%d top=%.4f' % (len(ctx.pivots(2, 2, 250)), len(L), L[0]['price'] if L else 0))\n"
    : probe === 'ruby'
      ? "def on_bar(bar, ctx)\n  if ctx.index == 300\n    l = ctx.levels(0.004)\n    ctx.log(format('p=%d l=%d top=%.4f', ctx.pivots(2, 2, 250).length, l.length, l.empty? ? 0 : l[0]['price']))\n  end\nend\n"
      : "function onBar(bar, ctx){ if (ctx.i === 300) { const L = ctx.levels(0.004); ctx.log('p=' + ctx.pivots(2,2,250).length + ' l=' + L.length + ' top=' + (L[0] ? L[0].price.toFixed(4) : '0')); } }";
  const seeAll = await engine.backtest({ language: probe, code: levelPeek, bars, params: {}, config: CONFIG });
  const seeSome = await engine.backtest({ language: probe, code: levelPeek, bars: bars.slice(0, 301), params: {}, config: CONFIG });
  const msgAll = (seeAll.logs[0] || {}).msg || '';
  const msgSome = (seeSome.logs[0] || {}).msg || '';
  check('pivot view at bar 300 ignores bars 301+', !!msgAll && msgAll === msgSome, `${msgAll} vs ${msgSome}`);

  // ---- error surfacing
  console.log('\nError handling:');
  const broken = await engine.backtest({
    language: available[0],
    code: available[0] === 'python' ? 'def on_bar(bar, ctx):\n    return 1 / 0\n'
      : available[0] === 'ruby' ? 'def on_bar(bar, ctx)\n  raise "boom"\nend\n'
        : 'function onBar(bar, ctx){ throw new Error("boom"); }',
    bars, params: {}, config: CONFIG,
  });
  check('runtime error reported, not swallowed', broken.ok === false && !!broken.error.message, JSON.stringify(broken).slice(0, 120));
  check('error names the offending bar', broken.ok === false && broken.error.bar === 0, `bar=${broken.error && broken.error.bar}`);

  const missing = await engine.backtest({
    language: available[0],
    code: available[0] === 'javascript' ? '// no entry point here' : '# no entry point here',
    bars, params: {}, config: CONFIG,
  });
  check('missing entry point reported', missing.ok === false && /on_?bar/i.test(missing.error.message), missing.error && missing.error.message);

  console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nAll checks passed.\n');
  process.exit(failures ? 1 : 0);
})();

function base_trades(results, ids) { return ids.length ? results[ids[0]].stats.numTrades : 0; }
