'use strict';
// Alpha Vantage data provider.
//
// The free tier allows 25 requests PER DAY, so this module is built around not
// spending them: every response is cached to disk, cache hits cost nothing, and a
// local counter tracks the day's usage so the UI can show what's left.

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const HOST = 'www.alphavantage.co';
const DATA_DIR = path.join(__dirname, '..', 'data');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');

const FREE_DAILY_LIMIT = 25;

// Our internal timeframe vocabulary → Alpha Vantage function + interval.
// Keeping our own names means engine.js and the runners never learn about the provider.
const TIMEFRAMES = {
  '1Min': { fn: 'TIME_SERIES_INTRADAY', interval: '1min', intraday: true, key: 'Time Series (1min)' },
  '5Min': { fn: 'TIME_SERIES_INTRADAY', interval: '5min', intraday: true, key: 'Time Series (5min)' },
  '15Min': { fn: 'TIME_SERIES_INTRADAY', interval: '15min', intraday: true, key: 'Time Series (15min)' },
  '30Min': { fn: 'TIME_SERIES_INTRADAY', interval: '30min', intraday: true, key: 'Time Series (30min)' },
  '1Hour': { fn: 'TIME_SERIES_INTRADAY', interval: '60min', intraday: true, key: 'Time Series (60min)' },
  '1Day': { fn: 'TIME_SERIES_DAILY', intraday: false, key: 'Time Series (Daily)' },
  '1Week': { fn: 'TIME_SERIES_WEEKLY', intraday: false, key: 'Weekly Time Series' },
  '1Month': { fn: 'TIME_SERIES_MONTHLY', intraday: false, key: 'Monthly Time Series' },
};

// Cache lifetimes. Intraday goes stale fast; a finished daily bar never changes.
const TTL_MS = { intraday: 10 * 60 * 1000, daily: 12 * 60 * 60 * 1000, archived: Infinity };

function ensureDirs() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

// ------------------------------------------------------------------- usage

function today() { return new Date().toISOString().slice(0, 10); }

function readUsage() {
  try {
    const u = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    if (u.date === today()) return u;
  } catch {}
  return { date: today(), count: 0, calls: [] };
}

function bumpUsage(label) {
  ensureDirs();
  const u = readUsage();
  u.count++;
  u.calls = (u.calls || []).concat([{ at: new Date().toISOString(), label }]).slice(-40);
  fs.writeFileSync(USAGE_FILE, JSON.stringify(u));
  return u;
}

function usage() {
  const u = readUsage();
  return {
    provider: 'alphavantage',
    label: 'today',
    date: u.date,
    used: u.count,
    limit: FREE_DAILY_LIMIT,
    remaining: Math.max(0, FREE_DAILY_LIMIT - u.count),
    resets: 'midnight UTC',
    recent: (u.calls || []).slice(-10).reverse(),
  };
}

// ------------------------------------------------------------------ fetching

function get(params) {
  const url = new URL(`https://${HOST}/query`);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);

  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers: { 'User-Agent': 'strategy-terminal' }, timeout: 30000 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(body); }
        catch { return reject(new Error(`Alpha Vantage returned non-JSON (HTTP ${res.statusCode}): ${body.slice(0, 200)}`)); }

        // Alpha Vantage signals every failure with HTTP 200 and a prose field.
        if (json['Error Message']) return reject(new Error(`Alpha Vantage: ${json['Error Message']}`));
        if (json['Note']) return reject(rateErr(json['Note']));
        if (json['Information']) {
          const info = json['Information'];
          if (/premium/i.test(info)) return reject(new Error(`This endpoint needs a premium Alpha Vantage plan.\n${info}`));
          return reject(rateErr(info));
        }
        resolve(json);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Alpha Vantage request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function rateErr(msg) {
  const e = new Error(`Alpha Vantage rate limit reached — ${FREE_DAILY_LIMIT} requests/day on the free tier.\n${msg}`);
  e.status = 429;
  e.rateLimited = true;
  return e;
}

// ------------------------------------------------------------------- cache

function cachePath(params) {
  const name = [params.symbol, params.function, params.interval, params.month, params.outputsize]
    .filter(Boolean).join('_').replace(/[^A-Za-z0-9._-]/g, '');
  return path.join(DATA_DIR, `${name}.json`);
}

function readCache(p, ttl) {
  try {
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (ttl === Infinity || Date.now() - new Date(c.fetchedAt).getTime() < ttl) return c;
  } catch {}
  return null;
}

// One network call, cached. Returns { payload, cached, fetchedAt }.
async function getCached(params, apiKey, ttl, { force = false } = {}) {
  ensureDirs();
  const p = cachePath(params);
  if (!force) {
    const hit = readCache(p, ttl);
    if (hit) return { payload: hit.payload, cached: true, fetchedAt: hit.fetchedAt };
  }

  const u = readUsage();
  if (u.count >= FREE_DAILY_LIMIT) {
    const e = new Error(
      `Daily Alpha Vantage quota spent (${u.count}/${FREE_DAILY_LIMIT}). Cached symbols still work — ` +
      `pick one you've already loaded, or wait for the counter to reset at midnight UTC.`);
    e.status = 429;
    e.rateLimited = true;
    throw e;
  }

  const payload = await get({ ...params, apikey: apiKey });
  bumpUsage(`${params.function} ${params.symbol}${params.interval ? ' ' + params.interval : ''}${params.month ? ' ' + params.month : ''}`);
  const fetchedAt = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify({ fetchedAt, params: { ...params, apikey: undefined }, payload }));
  return { payload, cached: false, fetchedAt };
}

// -------------------------------------------------------------- timestamps

function tzOffsetMinutes(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((a, p) => (p.type === 'literal' ? a : (a[p.type] = p.value, a)), {});
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return (asUTC - date.getTime()) / 60000;
}

// Intraday stamps are US/Eastern wall-clock with no offset attached; daily and above
// are bare dates, which we pin to 21:00Z so they render on the right calendar day.
function toISO(stamp) {
  const [d, t] = stamp.split(' ');
  if (!t) return `${d}T21:00:00.000Z`;
  const naive = new Date(`${d}T${t}Z`);
  const off = tzOffsetMinutes(naive, 'America/New_York');
  return new Date(naive.getTime() - off * 60000).toISOString();
}

// ---------------------------------------------------------------- parsing

function parseSeries(payload, seriesKey) {
  const series = payload[seriesKey];
  if (!series) {
    const keys = Object.keys(payload).join(', ');
    throw new Error(`Unexpected Alpha Vantage response — no "${seriesKey}" field. Got: ${keys}`);
  }
  const bars = [];
  for (const [stamp, v] of Object.entries(series)) {
    const o = parseFloat(v['1. open']), h = parseFloat(v['2. high']);
    const l = parseFloat(v['3. low']), c = parseFloat(v['4. close']);
    const vol = parseFloat(v['5. volume'] ?? v['6. volume'] ?? 0);
    if (![o, h, l, c].every(Number.isFinite)) continue;
    bars.push({ t: toISO(stamp), o, h, l, c, v: Number.isFinite(vol) ? vol : 0 });
  }
  bars.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return bars;
}

function monthsBetween(start, end) {
  const out = [];
  const s = new Date(start + 'T00:00:00Z');
  const e = new Date(end + 'T00:00:00Z');
  const cur = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), 1));
  while (cur <= e && out.length < 120) {
    out.push(`${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, '0')}`);
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}

// ------------------------------------------------------------------- public

// Returns { bars, meta } where meta explains where the data came from and what it cost.
async function fetchBars({ symbol, timeframe, start, end, limit, force, maxCalls = 6 }, apiKey) {
  const tf = TIMEFRAMES[timeframe];
  if (!tf) throw new Error(`Unsupported timeframe "${timeframe}". Alpha Vantage supports: ${Object.keys(TIMEFRAMES).join(', ')}`);

  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym) throw new Error('No symbol.');

  const startMs = start ? new Date(start + 'T00:00:00Z').getTime() : -Infinity;
  const endMs = end ? new Date(end + 'T23:59:59Z').getTime() : Infinity;

  const meta = { provider: 'alphavantage', cached: true, apiCalls: 0, requests: [], adjusted: false };
  let bars = [];

  if (!tf.intraday) {
    const params = { function: tf.fn, symbol: sym, outputsize: 'full' };
    const r = await getCached(params, apiKey, TTL_MS.daily, { force });
    meta.cached = r.cached;
    meta.fetchedAt = r.fetchedAt;
    if (!r.cached) meta.apiCalls++;
    meta.requests.push({ fn: tf.fn, cached: r.cached });
    bars = parseSeries(r.payload, tf.key);
  } else {
    // Intraday: `outputsize=full` covers roughly the last 30 days. Anything older has
    // to be pulled one calendar month at a time — at 25 requests/day that adds up fast,
    // so refuse loudly rather than silently draining the quota.
    const thirtyDaysAgo = Date.now() - 31 * 86400e3;
    const needsArchive = startMs !== -Infinity && startMs < thirtyDaysAgo;

    if (!needsArchive) {
      const params = { function: tf.fn, symbol: sym, interval: tf.interval, outputsize: 'full' };
      const r = await getCached(params, apiKey, TTL_MS.intraday, { force });
      meta.cached = r.cached;
      meta.fetchedAt = r.fetchedAt;
      if (!r.cached) meta.apiCalls++;
      meta.requests.push({ fn: tf.fn, interval: tf.interval, cached: r.cached });
      bars = parseSeries(r.payload, tf.key);
    } else {
      const months = monthsBetween(start, end || today());
      const uncached = months.filter((m) => !readCache(cachePath({ function: tf.fn, symbol: sym, interval: tf.interval, month: m }), TTL_MS.archived));
      const remaining = usage().remaining;

      if (uncached.length > maxCalls) {
        throw Object.assign(new Error(
          `That range needs ${uncached.length} separate Alpha Vantage requests (one per month of ${tf.interval} history), ` +
          `and the free tier only allows ${FREE_DAILY_LIMIT}/day.\n\n` +
          `Either shorten the range to about ${maxCalls} month${maxCalls === 1 ? '' : 's'}, or switch the timeframe to 1Day — ` +
          `daily history comes back 20+ years in a single request.`), { status: 429 });
      }
      if (uncached.length > remaining) {
        throw Object.assign(new Error(
          `That range needs ${uncached.length} requests but only ${remaining} remain in today's quota (${usage().used}/${FREE_DAILY_LIMIT} used).`),
          { status: 429, rateLimited: true });
      }

      const seen = new Map();
      for (const m of months) {
        const params = { function: tf.fn, symbol: sym, interval: tf.interval, month: m, outputsize: 'full' };
        const r = await getCached(params, apiKey, TTL_MS.archived, { force });
        if (!r.cached) { meta.apiCalls++; meta.cached = false; }
        meta.requests.push({ fn: tf.fn, interval: tf.interval, month: m, cached: r.cached });
        for (const b of parseSeries(r.payload, tf.key)) seen.set(b.t, b);
      }
      bars = Array.from(seen.values()).sort((a, b) => (a.t < b.t ? -1 : 1));
    }
  }

  const total = bars.length;
  bars = bars.filter((b) => {
    const ms = new Date(b.t).getTime();
    return ms >= startMs && ms <= endMs;
  });
  meta.availableBars = total;
  meta.earliest = total ? bars[0] && bars[0].t : null;

  if (limit && bars.length > limit) bars = bars.slice(-limit);

  // Free-tier daily data is NOT split-adjusted; a 2:1 split shows up as a 50% overnight
  // gap that a backtest will happily book as a real loss. Flag it rather than hide it.
  meta.suspectSplits = [];
  for (let i = 1; i < bars.length; i++) {
    const r = bars[i].o / bars[i - 1].c;
    if (r > 0 && (r < 0.6 || r > 1.7)) meta.suspectSplits.push({ t: bars[i].t, ratio: +r.toFixed(3) });
  }
  meta.suspectSplits = meta.suspectSplits.slice(0, 5);

  return { bars, meta };
}

async function verifyKey(apiKey) {
  const json = await get({ function: 'GLOBAL_QUOTE', symbol: 'IBM', apikey: apiKey });
  bumpUsage('GLOBAL_QUOTE IBM (key check)');
  const q = json['Global Quote'];
  if (!q || !Object.keys(q).length) throw new Error('Key accepted but no quote returned — double-check the key.');
  return { symbol: q['01. symbol'], price: parseFloat(q['05. price']), tradingDay: q['07. latest trading day'] };
}

async function latestQuote(symbol, apiKey) {
  const json = await get({ function: 'GLOBAL_QUOTE', symbol: String(symbol).toUpperCase(), apikey: apiKey });
  bumpUsage(`GLOBAL_QUOTE ${symbol}`);
  const q = json['Global Quote'] || {};
  return {
    symbol: q['01. symbol'], price: parseFloat(q['05. price']),
    change: parseFloat(q['09. change']), changePercent: q['10. change percent'],
    tradingDay: q['07. latest trading day'], volume: parseFloat(q['06. volume']),
  };
}

module.exports = { fetchBars, verifyKey, latestQuote, usage, TIMEFRAMES, FREE_DAILY_LIMIT };
