'use strict';
// Finnhub data provider.
//
// Rate limit is 60 calls/minute on the free tier — generous compared to Alpha Vantage's
// 25/day — so this tracks a rolling one-minute window rather than a daily budget.
//
// IMPORTANT: Finnhub moved /stock/candle (historical OHLC for US equities) behind a paid
// plan. Free keys get HTTP 403 on it. Crypto and forex candles remain free. The 403 is
// surfaced verbatim rather than dressed up, because it is the difference between this
// terminal working and not working.

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const HOST = 'finnhub.io';
const BASE = '/api/v1';
const DATA_DIR = path.join(__dirname, '..', 'data');

const RATE_LIMIT_PER_MIN = 60;

const TIMEFRAMES = {
  '1Min': { res: '1', intraday: true },
  '5Min': { res: '5', intraday: true },
  '15Min': { res: '15', intraday: true },
  '30Min': { res: '30', intraday: true },
  '1Hour': { res: '60', intraday: true },
  '1Day': { res: 'D', intraday: false },
  '1Week': { res: 'W', intraday: false },
  '1Month': { res: 'M', intraday: false },
};

const TTL_MS = { intraday: 5 * 60 * 1000, daily: 12 * 60 * 60 * 1000 };

// Symbols are routed by prefix: bare tickers are equities, EXCHANGE:PAIR goes to the
// crypto or forex endpoint depending on the venue.
const CRYPTO_VENUES = new Set(['BINANCE', 'COINBASE', 'KRAKEN', 'BITFINEX', 'HUOBI', 'GEMINI', 'POLONIEX', 'BITTREX', 'KUCOIN', 'OKEX', 'BYBIT']);
const FOREX_VENUES = new Set(['OANDA', 'FXCM', 'FOREX.COM', 'IC MARKETS', 'PEPPERSTONE', 'SAXO']);

function classify(symbol) {
  const s = String(symbol || '').trim().toUpperCase();
  if (!s.includes(':')) return { assetClass: 'stock', endpoint: '/stock/candle', symbol: s };
  const venue = s.split(':')[0];
  if (CRYPTO_VENUES.has(venue)) return { assetClass: 'crypto', endpoint: '/crypto/candle', symbol: s };
  if (FOREX_VENUES.has(venue)) return { assetClass: 'forex', endpoint: '/forex/candle', symbol: s };
  return { assetClass: 'crypto', endpoint: '/crypto/candle', symbol: s };
}

function ensureDirs() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

// ------------------------------------------------------------------- usage

// Rolling one-minute window, kept in memory. Restarting the server clears it, which is
// fine — the limit is per minute, so a restart has already let the window drain.
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
    provider: 'finnhub',
    label: 'per minute',
    used,
    limit: RATE_LIMIT_PER_MIN,
    remaining: Math.max(0, RATE_LIMIT_PER_MIN - used),
    resets: 'rolling 60s window',
    recent: callLog.slice(-10).reverse().map((c) => ({ at: new Date(c.at).toISOString(), label: c.label })),
  };
}

// ------------------------------------------------------------------ fetching

function get(endpoint, params, apiKey) {
  const url = new URL(`https://${HOST}${BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') url.searchParams.set(k, v);

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers: { 'X-Finnhub-Token': apiKey, Accept: 'application/json', 'User-Agent': 'strategy-terminal' },
      timeout: 30000,
    }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch {}

        if (res.statusCode === 401 || res.statusCode === 403) {
          const detail = (json && (json.error || json.message)) || body.slice(0, 200);
          if (res.statusCode === 403 || /don't have access|premium/i.test(detail)) {
            const e = new Error(
              `Finnhub returned 403 for ${endpoint}.\n\n` +
              `Historical stock candles (/stock/candle) are a PAID Finnhub feature — free keys can't ` +
              `pull US equity OHLC history, which is exactly what a backtest needs.\n\n` +
              `Your options:\n` +
              `  • Switch the provider back to Alpha Vantage in the API Keys dialog (free daily bars, 25 req/day)\n` +
              `  • Upgrade the Finnhub plan\n` +
              `  • Test on crypto instead — /crypto/candle is free, e.g. symbol BINANCE:BTCUSDT\n\n` +
              `Finnhub said: ${detail}`);
            e.status = 403;
            e.premiumGated = true;
            return reject(e);
          }
          const e = new Error(`Finnhub rejected the API key (HTTP ${res.statusCode}): ${detail}`);
          e.status = 401;
          return reject(e);
        }

        if (res.statusCode === 429) {
          const e = new Error(`Finnhub rate limit hit (${RATE_LIMIT_PER_MIN}/minute on the free tier). Wait a moment and retry.`);
          e.status = 429;
          e.rateLimited = true;
          return reject(e);
        }

        if (res.statusCode >= 400) {
          return reject(new Error(`Finnhub HTTP ${res.statusCode}: ${(json && (json.error || json.message)) || body.slice(0, 200)}`));
        }
        if (!json) return reject(new Error(`Finnhub returned non-JSON: ${body.slice(0, 200)}`));
        if (json.error) return reject(new Error(`Finnhub: ${json.error}`));
        resolve(json);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Finnhub request timed out')));
    req.on('error', reject);
    req.end();
  });
}

// -------------------------------------------------------------------- cache

function cachePath(key) {
  return path.join(DATA_DIR, `finnhub_${String(key).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

async function getCached(cacheKey, endpoint, params, apiKey, ttl, { force = false } = {}) {
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
  const payload = await get(endpoint, params, apiKey);
  record(`${endpoint} ${params.symbol} ${params.resolution || ''}`);
  const fetchedAt = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify({ fetchedAt, payload }));
  return { payload, cached: false, fetchedAt };
}

// ------------------------------------------------------------------- public

// Finnhub candles arrive as parallel arrays: c/h/l/o/t/v plus a status field.
function parseCandles(payload) {
  if (!payload || payload.s === 'no_data') return [];
  if (payload.s && payload.s !== 'ok') throw new Error(`Finnhub candle status: ${payload.s}`);
  const { o, h, l, c, v, t } = payload;
  if (!Array.isArray(t) || !Array.isArray(c)) throw new Error('Unexpected Finnhub candle payload — missing t/c arrays.');

  const bars = [];
  for (let i = 0; i < t.length; i++) {
    const bar = {
      t: new Date(t[i] * 1000).toISOString(),
      o: Number(o[i]), h: Number(h[i]), l: Number(l[i]), c: Number(c[i]),
      v: Number(v && v[i] != null ? v[i] : 0),
    };
    if ([bar.o, bar.h, bar.l, bar.c].every(Number.isFinite)) bars.push(bar);
  }
  bars.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return bars;
}

async function fetchBars({ symbol, timeframe, start, end, limit, force }, apiKey) {
  const tf = TIMEFRAMES[timeframe];
  if (!tf) throw new Error(`Unsupported timeframe "${timeframe}". Finnhub supports: ${Object.keys(TIMEFRAMES).join(', ')}`);

  const routed = classify(symbol);
  if (!routed.symbol) throw new Error('No symbol.');

  const from = Math.floor((start ? new Date(start + 'T00:00:00Z').getTime() : Date.now() - 730 * 86400e3) / 1000);
  const to = Math.floor((end ? new Date(end + 'T23:59:59Z').getTime() : Date.now()) / 1000);
  if (from >= to) throw new Error('Start date must be before end date.');

  const params = { symbol: routed.symbol, resolution: tf.res, from, to };
  const cacheKey = `${routed.symbol}_${tf.res}_${from}_${to}`;
  const r = await getCached(cacheKey, routed.endpoint, params, apiKey, tf.intraday ? TTL_MS.intraday : TTL_MS.daily, { force });

  let bars = parseCandles(r.payload);
  const availableBars = bars.length;
  if (limit && bars.length > limit) bars = bars.slice(-limit);

  // Finnhub equity candles are split-adjusted, but a corporate action or a thin symbol
  // can still produce a wild gap — worth flagging rather than silently booking as P&L.
  const suspectSplits = [];
  for (let i = 1; i < bars.length; i++) {
    const ratio = bars[i].o / bars[i - 1].c;
    if (ratio > 0 && (ratio < 0.6 || ratio > 1.7)) suspectSplits.push({ t: bars[i].t, ratio: +ratio.toFixed(3) });
  }

  return {
    bars,
    meta: {
      provider: 'finnhub',
      assetClass: routed.assetClass,
      cached: r.cached,
      fetchedAt: r.fetchedAt,
      apiCalls: r.cached ? 0 : 1,
      availableBars,
      earliest: bars.length ? bars[0].t : null,
      adjusted: routed.assetClass === 'stock',
      suspectSplits: suspectSplits.slice(0, 5),
    },
  };
}

async function verifyKey(apiKey) {
  // /quote is on the free tier, so this validates the key without needing candle access.
  const json = await get('/quote', { symbol: 'AAPL' }, apiKey);
  record('/quote AAPL (key check)');
  if (json.c == null) throw new Error('Key accepted but no quote returned — double-check the key.');
  return { symbol: 'AAPL', price: json.c, change: json.d, changePercent: json.dp, tradingDay: new Date((json.t || Date.now() / 1000) * 1000).toISOString().slice(0, 10) };
}

async function latestQuote(symbol, apiKey) {
  const sym = String(symbol).toUpperCase();
  const json = await get('/quote', { symbol: sym }, apiKey);
  record(`/quote ${sym}`);
  return { symbol: sym, price: json.c, change: json.d, changePercent: json.dp, high: json.h, low: json.l, open: json.o, prevClose: json.pc };
}

module.exports = { fetchBars, verifyKey, latestQuote, usage, TIMEFRAMES, classify, parseCandles };
