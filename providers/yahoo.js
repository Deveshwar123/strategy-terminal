'use strict';
// Yahoo Finance data provider.
//
// The only provider here that needs no API key: the v8 chart endpoint is public.
// That makes it the default for backtesting, because the other two both gate the
// thing a backtest actually needs — Finnhub paywalled /stock/candle AND /crypto/candle,
// and Alpha Vantage allows 25 requests/day.
//
// Two things about this endpoint are easy to get wrong, and both silently corrupt a
// backtest rather than erroring:
//
//   1. `range=max` does NOT mean "max daily bars". Yahoo quietly coarsens the interval
//      to fit its own bar budget — asking for range=max&interval=1d returns ~168 bars
//      for 42 years, which looks like data but is roughly quarterly. Always send
//      explicit period1/period2 epochs; that returns the true ~252 bars/year.
//
//   2. The OHLC in `indicators.quote` is RAW, unadjusted. Only `adjclose` is adjusted.
//      Feeding raw prices to the engine books every split as a real overnight crash
//      (AAPL's first bar is 0.1244 raw vs 0.0951 adjusted across 5 splits). So each
//      bar's open/high/low/close is scaled by adjclose/close before it leaves here.
//
// Intraday history is capped by Yahoo and cannot be worked around: ~30d of 1m, 60d of
// 5m/15m/30m, 730d of 1h. Deep history is daily-and-up only.

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const HOST = 'query1.finance.yahoo.com';
const BASE = '/v8/finance/chart';
const DATA_DIR = path.join(__dirname, '..', 'data');

// Yahoo publishes no documented quota for the public chart endpoint. It does throttle
// abusive callers, so this tracks calls for display and to keep the header pill honest,
// but there is no hard budget to spend down like Alpha Vantage's 25/day.
const SOFT_LIMIT_PER_MIN = 60;

// `maxDays` is Yahoo's server-side cap on how far back that interval is available.
const TIMEFRAMES = {
  '1Min': { interval: '1m', intraday: true, maxDays: 30 },
  '5Min': { interval: '5m', intraday: true, maxDays: 60 },
  '15Min': { interval: '15m', intraday: true, maxDays: 60 },
  '30Min': { interval: '30m', intraday: true, maxDays: 60 },
  '1Hour': { interval: '1h', intraday: true, maxDays: 730 },
  '1Day': { interval: '1d', intraday: false, maxDays: null },
  '1Week': { interval: '1wk', intraday: false, maxDays: null },
  '1Month': { interval: '1mo', intraday: false, maxDays: null },
};

const TTL_MS = { intraday: 5 * 60 * 1000, daily: 12 * 60 * 60 * 1000 };

function ensureDirs() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

// ------------------------------------------------------------------- usage

const callLog = [];

function record(label) {
  const now = Date.now();
  callLog.push({ at: now, label });
  while (callLog.length && now - callLog[0].at > 60000) callLog.shift();
}

function usage() {
  const now = Date.now();
  while (callLog.length && now - callLog[0].at > 60000) callLog.shift();
  const used = callLog.length;
  return {
    provider: 'yahoo',
    label: 'per minute',
    used,
    limit: SOFT_LIMIT_PER_MIN,
    remaining: Math.max(0, SOFT_LIMIT_PER_MIN - used),
    resets: 'rolling 60s window (no published quota — courtesy limit)',
    recent: callLog.slice(-10).reverse().map((c) => ({ at: new Date(c.at).toISOString(), label: c.label })),
  };
}

// ------------------------------------------------------------------ fetching

function get(symbol, params) {
  const url = new URL(`https://${HOST}${BASE}/${encodeURIComponent(symbol)}`);
  for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') url.searchParams.set(k, v);

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      // Yahoo returns 403 to clients with no browser-ish User-Agent.
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      timeout: 30000,
    }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch {}

        // Yahoo reports symbol/param problems inside chart.error with a real HTTP code.
        const chartErr = json && json.chart && json.chart.error;
        if (chartErr) {
          const code = chartErr.code || 'error';
          if (/not\s*found/i.test(code) || res.statusCode === 404) {
            return reject(new Error(
              `Yahoo has no data for "${symbol}".\n\n` +
              `Symbols are Yahoo-style: US equities are bare tickers (AAPL, SPY), indices carry a caret ` +
              `(^GSPC), crypto uses a dash pair (BTC-USD), forex uses =X (EURUSD=X).\n\n` +
              `Yahoo said: ${chartErr.description || code}`));
          }
          return reject(new Error(`Yahoo: ${chartErr.description || code}`));
        }

        if (res.statusCode === 429) {
          const e = new Error('Yahoo is throttling requests. Wait a minute and retry — cached ranges still work offline.');
          e.status = 429;
          e.rateLimited = true;
          return reject(e);
        }
        if (res.statusCode >= 400) {
          return reject(new Error(`Yahoo HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        if (!json) return reject(new Error(`Yahoo returned non-JSON: ${body.slice(0, 200)}`));
        resolve(json);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Yahoo request timed out')));
    req.on('error', reject);
    req.end();
  });
}

// -------------------------------------------------------------------- cache

function cachePath(key) {
  return path.join(DATA_DIR, `yahoo_${String(key).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

async function getCached(cacheKey, symbol, params, ttl, { force = false } = {}) {
  ensureDirs();
  const p = cachePath(cacheKey);
  if (!force) {
    try {
      const c = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Date.now() - new Date(c.fetchedAt).getTime() < ttl) {
        return { payload: c.payload, cached: true, fetchedAt: c.fetchedAt };
      }
    } catch {}
  }
  const payload = await get(symbol, params);
  record(`${symbol} ${params.interval}`);
  const fetchedAt = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify({ fetchedAt, payload }));
  return { payload, cached: false, fetchedAt };
}

// ------------------------------------------------------------------- public

// Yahoo nests parallel arrays under chart.result[0]. Bars with null OHLC are holidays
// and halts — dropped rather than interpolated, because inventing a price is worse than
// a gap. Every bar is scaled to the adjusted close so splits don't read as P&L.
function parseChart(payload) {
  const result = payload && payload.chart && payload.chart.result && payload.chart.result[0];
  if (!result) return { bars: [], adjusted: false, meta: {} };

  const ts = result.timestamp || [];
  const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const adjArr = result.indicators && result.indicators.adjclose && result.indicators.adjclose[0]
    && result.indicators.adjclose[0].adjclose;
  const rmeta = result.meta || {};
  const gmtoffset = Number(rmeta.gmtoffset || 0);
  const isDaily = ['1d', '1wk', '1mo'].includes(rmeta.dataGranularity);

  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = Number(q.open?.[i]), h = Number(q.high?.[i]), l = Number(q.low?.[i]), c = Number(q.close?.[i]);
    if (![o, h, l, c].every(Number.isFinite)) continue;

    // adjclose/close is the cumulative split+dividend factor for that bar.
    const adj = adjArr && Number.isFinite(Number(adjArr[i])) ? Number(adjArr[i]) : null;
    const k = adj != null && c !== 0 ? adj / c : 1;

    // Daily+ bars get a clean date label in the exchange's own day, so a bar stamped
    // 14:30Z doesn't drift to the previous date for anyone reading it.
    const t = isDaily
      ? new Date((ts[i] + gmtoffset) * 1000).toISOString().slice(0, 10) + 'T00:00:00.000Z'
      : new Date(ts[i] * 1000).toISOString();

    bars.push({
      t,
      o: o * k, h: h * k, l: l * k, c: c * k,
      v: Number(q.volume?.[i] != null ? q.volume[i] : 0),
    });
  }
  bars.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));

  const splits = (result.events && result.events.splits) || {};
  return {
    bars,
    adjusted: !!adjArr,
    meta: {
      currency: rmeta.currency,
      exchange: rmeta.exchangeName,
      instrumentType: rmeta.instrumentType,
      granularity: rmeta.dataGranularity,
      splitCount: Object.keys(splits).length,
    },
  };
}

function epochOf(dateStr, endOfDay) {
  return Math.floor(new Date(dateStr + (endOfDay ? 'T23:59:59Z' : 'T00:00:00Z')).getTime() / 1000);
}

async function fetchBars({ symbol, timeframe, start, end, limit, force }, _apiKey) {
  const tf = TIMEFRAMES[timeframe];
  if (!tf) throw new Error(`Unsupported timeframe "${timeframe}". Yahoo supports: ${Object.keys(TIMEFRAMES).join(', ')}`);

  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym) throw new Error('No symbol.');

  // Default lookback: 20 years of daily is free here, so there is no reason to be shy.
  const to = end ? epochOf(end, true) : Math.floor(Date.now() / 1000);
  let from = start ? epochOf(start, false) : to - 20 * 365 * 86400;
  if (from >= to) throw new Error('Start date must be before end date.');

  // Clamp intraday to Yahoo's server-side window instead of letting it return an empty
  // series that would look like "your strategy found no bars".
  let clamped = null;
  if (tf.maxDays) {
    const earliest = Math.floor(Date.now() / 1000) - tf.maxDays * 86400;
    if (from < earliest) {
      clamped = { requested: new Date(from * 1000).toISOString().slice(0, 10), maxDays: tf.maxDays };
      from = earliest;
    }
  }

  const params = { period1: from, period2: to, interval: tf.interval, events: 'div,split', includeAdjustedClose: 'true' };
  const cacheKey = `${sym}_${tf.interval}_${from}_${to}`;
  const r = await getCached(cacheKey, sym, params, tf.intraday ? TTL_MS.intraday : TTL_MS.daily, { force });

  const parsed = parseChart(r.payload);
  let bars = parsed.bars;
  const availableBars = bars.length;
  if (limit && bars.length > limit) bars = bars.slice(-limit);

  // Prices are adjusted above, so a surviving gap is real news, not a corporate action.
  // Still surfaced — a 40% single-bar move is worth a human look either way.
  const suspectSplits = [];
  for (let i = 1; i < bars.length; i++) {
    const ratio = bars[i].o / bars[i - 1].c;
    if (ratio > 0 && (ratio < 0.6 || ratio > 1.7)) suspectSplits.push({ t: bars[i].t, ratio: +ratio.toFixed(3) });
  }

  return {
    bars,
    meta: {
      provider: 'yahoo',
      assetClass: parsed.meta.instrumentType ? String(parsed.meta.instrumentType).toLowerCase() : 'stock',
      cached: r.cached,
      fetchedAt: r.fetchedAt,
      apiCalls: r.cached ? 0 : 1,
      availableBars,
      earliest: bars.length ? bars[0].t : null,
      adjusted: parsed.adjusted,
      splitCount: parsed.meta.splitCount,
      currency: parsed.meta.currency,
      exchange: parsed.meta.exchange,
      clamped,
      suspectSplits: suspectSplits.slice(0, 5),
    },
  };
}

// No key to verify. Still hits the network, so "Connect" proves the endpoint is
// reachable from this machine rather than just claiming success.
async function verifyKey(_apiKey) {
  const json = await get('AAPL', { range: '5d', interval: '1d' });
  record('AAPL (reachability check)');
  const { bars } = parseChart(json);
  if (!bars.length) throw new Error('Yahoo reachable but returned no bars for AAPL — try again shortly.');
  const last = bars[bars.length - 1];
  return { symbol: 'AAPL', price: last.c, tradingDay: last.t.slice(0, 10), keyless: true };
}

async function latestQuote(symbol, _apiKey) {
  const sym = String(symbol).toUpperCase();
  const json = await get(sym, { range: '5d', interval: '1d' });
  record(`${sym} quote`);
  const { bars } = parseChart(json);
  if (!bars.length) throw new Error(`No recent bars for ${sym}.`);
  const last = bars[bars.length - 1];
  const prev = bars.length > 1 ? bars[bars.length - 2] : null;
  const change = prev ? last.c - prev.c : 0;
  return {
    symbol: sym,
    price: last.c,
    change,
    changePercent: prev && prev.c ? (change / prev.c) * 100 : 0,
    high: last.h, low: last.l, open: last.o,
    prevClose: prev ? prev.c : null,
  };
}

module.exports = { fetchBars, verifyKey, latestQuote, usage, TIMEFRAMES, parseChart };
