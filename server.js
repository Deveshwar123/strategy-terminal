'use strict';
// Strategy Terminal -- local backtesting/forward-testing server.
// Zero npm dependencies: node:http + node:https only. Binds to 127.0.0.1 so nothing
// on your network can reach it, and your API key never leaves this machine.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const engine = require('./engine');
const providers = require('./providers');

const PORT = Number(process.env.PORT || 4477);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const STRATEGY_DIR = path.join(ROOT, 'strategies');
const CRED_FILE = path.join(ROOT, '.credentials.json');

// ------------------------------------------------------------- credentials

function loadCreds() {
  try { return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')); }
  catch { return null; }
}

function saveCreds(c) {
  fs.writeFileSync(CRED_FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
  try { fs.chmodSync(CRED_FILE, 0o600); } catch {}
}

// A keyless provider (Yahoo) has nothing to store, so an absent .credentials.json is a
// working state rather than an error — fall through to the default provider.
function requireCreds() {
  const c = loadCreds();
  if (!c || !c.apiKey) {
    const prov = providers.get(c && c.provider);
    if (prov.keyless) return { provider: prov.id, apiKey: null };
    throw httpErr(401, `No API key set for ${prov.label}. Add one in the API Keys dialog, or switch to a keyless provider.`);
  }
  return c;
}

// The active provider is whatever the stored credentials name.
function activeProvider() {
  const c = loadCreds();
  return providers.get(c && c.provider);
}

function withProvider() {
  const creds = requireCreds();
  return { creds, prov: providers.get(creds.provider), api: providers.get(creds.provider).module };
}

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ------------------------------------------------------------ live session

const live = {
  running: false, timer: null, cfg: null,
  bars: [], liveStartIndex: 0, result: null,
  lastPoll: null, lastError: null, ticks: 0, barsAdded: 0, startedAt: null,
};

async function livePoll() {
  const creds = loadCreds();
  if (!creds || !live.running) return;
  try {
    const c = live.cfg;
    // force:true bypasses the disk cache -- the whole point of a live tick is fresh data.
    const api = providers.get(creds.provider).module;

    // A tick only needs bars newer than the ones already held. Re-pulling a max range
    // every poll would drag 30+ years across the wire to learn about one new bar, so the
    // full history is fetched once at session start and each tick asks for a recent
    // window instead — merging below is keyed on timestamp, so the overlap is free.
    const window = c.range === 'max'
      ? { start: new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10), range: '' }
      : { start: c.start, range: c.range };

    const { bars } = await api.fetchBars(
      { symbol: c.symbol, timeframe: c.timeframe, start: window.start, range: window.range, end: '', force: true },
      creds.apiKey
    );

    let added = 0;
    for (const b of bars) {
      const last = live.bars[live.bars.length - 1];
      if (!last || b.t > last.t) { live.bars.push(b); added++; }
      else if (b.t === last.t) live.bars[live.bars.length - 1] = b;
    }

    live.result = await engine.backtest({
      language: c.language, code: c.code, bars: live.bars, params: c.params,
      config: { ...c.config, symbol: c.symbol, timeframe: c.timeframe },
    });
    live.lastPoll = new Date().toISOString();
    live.lastError = null;
    live.ticks++;
    live.barsAdded += added;

    // Stop rather than silently burn through a hard quota (Alpha Vantage's daily cap).
    const u = api.usage();
    if (u.label === 'today' && u.remaining <= 0) {
      live.lastError = `Quota exhausted (${u.used}/${u.limit} ${u.label}) — live session stopped.`;
      stopLive();
    }
  } catch (e) {
    live.lastError = e.message;
    if (e.rateLimited) stopLive();
  }
}

function stopLive() {
  live.running = false;
  if (live.timer) clearInterval(live.timer);
  live.timer = null;
}

function liveState() {
  return {
    running: live.running,
    cfg: live.cfg ? { ...live.cfg, code: undefined } : null,
    startedAt: live.startedAt, lastPoll: live.lastPoll, lastError: live.lastError,
    ticks: live.ticks, barCount: live.bars.length, barsAdded: live.barsAdded,
    liveStartIndex: live.liveStartIndex, bars: live.bars, result: live.result,
    usage: safeUsage(),
  };
}

// ------------------------------------------------------------------ routing

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'application/json', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 20e6) { req.destroy(); reject(new Error('Body too large')); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('Invalid JSON body')); } });
    req.on('error', reject);
  });
}

function safeUsage() {
  try { return activeProvider().module.usage(); } catch { return null; }
}

const routes = {
  'GET /api/languages': async () => ({ languages: engine.probeLanguages() }),

  'GET /api/providers': async () => ({ providers: providers.list(), default: providers.DEFAULT }),

  'GET /api/usage': async () => safeUsage(),

  'GET /api/status': async () => {
    const creds = loadCreds();
    const prov = providers.get(creds && creds.provider);
    // Keyless providers are connected by definition — there is no key to be missing.
    if (!creds || !creds.apiKey) {
      if (!prov.keyless) return { connected: false, providers: providers.list(), default: providers.DEFAULT };
      return {
        connected: true,
        provider: prov.id,
        providerLabel: prov.label,
        keyPreview: 'no key needed',
        keyless: true,
        usage: prov.module.usage(),
        timeframes: Object.keys(prov.module.TIMEFRAMES),
        providers: providers.list(),
      };
    }
    return {
      connected: true,
      provider: prov.id,
      providerLabel: prov.label,
      keyPreview: creds.apiKey.slice(0, 4) + '…' + creds.apiKey.slice(-3),
      keyless: !!prov.keyless,
      verifiedAt: creds.verifiedAt,
      usage: prov.module.usage(),
      timeframes: Object.keys(prov.module.TIMEFRAMES),
      providers: providers.list(),
    };
  },

  'POST /api/connect': async (body) => {
    const apiKey = (body.apiKey || '').trim();
    const prov = providers.get(body.provider);
    if (!apiKey && !prov.keyless) throw httpErr(400, `An API key is required for ${prov.label}.`);
    // For a keyless provider this is a reachability check, not a key check.
    const quote = await prov.module.verifyKey(apiKey || null); // costs one request
    saveCreds({ provider: prov.id, apiKey: apiKey || null, verifiedAt: new Date().toISOString() });
    return { connected: true, provider: prov.id, providerLabel: prov.label, keyless: !!prov.keyless, quote, usage: prov.module.usage() };
  },

  'POST /api/disconnect': async () => {
    try { fs.unlinkSync(CRED_FILE); } catch {}
    return { connected: false };
  },

  'POST /api/bars': async (body) => {
    const { creds, api } = withProvider();
    const { bars, meta } = await api.fetchBars(body, creds.apiKey);
    return { symbol: String(body.symbol).toUpperCase(), timeframe: body.timeframe, count: bars.length, bars, meta };
  },

  'POST /api/quote': async (body) => {
    const { creds, api } = withProvider();
    return api.latestQuote(body.symbol, creds.apiKey);
  },

  'POST /api/run': async (body) => {
    const { creds, prov, api } = withProvider();
    const { language, code, symbol, timeframe, start, end, range, params, config } = body;
    if (!code || !code.trim()) throw httpErr(400, 'No strategy code.');
    if (!symbol) throw httpErr(400, 'No symbol.');

    const { bars, meta } = await api.fetchBars(
      { symbol, timeframe, start, end, range, limit: body.maxBars, force: body.force },
      creds.apiKey
    );

    if (bars.length < 2) {
      throw httpErr(422,
        `${prov.label} returned ${bars.length} bars for ${String(symbol).toUpperCase()} ${timeframe} in that date range` +
        (meta.availableBars ? ` (${meta.availableBars} bars exist outside it — earliest is ${meta.earliest || 'unknown'}).` : '.') +
        (range === 'max'
          ? `\n\nThe range was already Max (everything since inception), so this is a symbol or timeframe problem, not a date problem.`
          : `\n\nCheck the symbol and widen the dates — or set Range to Max.`) +
        (prov.id === 'finnhub'
          ? ` For Finnhub, a bare ticker means US equities; crypto needs a venue prefix like BINANCE:BTCUSDT.`
          : prov.id === 'yahoo'
            ? ` Yahoo symbols: bare tickers for US equities (AAPL, SPY), ^GSPC for indices, BTC-USD for crypto,` +
              ` EURUSD=X for forex.` +
              (meta.clamped ? ` Note: ${timeframe} history is capped at ${meta.clamped.maxDays} days, so the start date was clamped.` : '')
            : ` Intraday timeframes only go back ~30 days without per-month requests.`));
    }

    const result = await engine.backtest({
      language, code, bars, params,
      config: { ...(config || {}), symbol: String(symbol).toUpperCase(), timeframe },
    });
    return { ...result, bars, meta, usage: api.usage(), provider: prov.id, symbol: String(symbol).toUpperCase(), timeframe, language };
  },

  'POST /api/live/start': async (body) => {
    const { creds, prov, api } = withProvider();
    if (live.running) throw httpErr(409, 'A live session is already running.');

    // Finnhub's limit is per minute, so it can poll far more often than Alpha Vantage's
    // 25/day allows. Floor the interval accordingly.
    const floor = prov.id === 'finnhub' ? 15 : 300;
    const pollSeconds = Math.max(floor, Number(body.pollSeconds) || (prov.id === 'finnhub' ? 60 : 900));
    const perHour = Math.ceil(3600 / pollSeconds);
    const u = api.usage();
    if (u.label === 'today' && u.remaining < 3) {
      throw httpErr(429, `Only ${u.remaining} ${prov.label} requests left ${u.label} — not enough to run a live session. Resets ${u.resets}.`);
    }

    const c = {
      symbol: String(body.symbol || '').toUpperCase(),
      timeframe: body.timeframe || '5Min',
      language: body.language, code: body.code,
      params: body.params || {}, config: body.config || {},
      start: body.start, range: body.range, pollSeconds, perHour,
    };
    if (!c.symbol || !c.code) throw httpErr(400, 'Symbol and code are required.');

    const { bars } = await api.fetchBars({ symbol: c.symbol, timeframe: c.timeframe, start: c.start, range: c.range, end: '' }, creds.apiKey);
    if (!bars.length) throw httpErr(422, `No bars returned for ${c.symbol} ${c.timeframe}.`);

    live.bars = bars;
    live.liveStartIndex = Math.max(bars.length - 1, 0);
    live.cfg = c;
    live.running = true;
    live.ticks = 0; live.barsAdded = 0; live.lastError = null;
    live.startedAt = new Date().toISOString();

    await livePoll();
    if (live.running) live.timer = setInterval(livePoll, pollSeconds * 1000);
    return liveState();
  },

  'POST /api/live/stop': async () => { stopLive(); return liveState(); },
  'GET /api/live/state': async () => liveState(),

  'GET /api/strategies': async () => {
    if (!fs.existsSync(STRATEGY_DIR)) return { strategies: [] };
    const files = fs.readdirSync(STRATEGY_DIR).filter((f) => f.endsWith('.json'));
    return {
      strategies: files.map((f) => {
        const j = JSON.parse(fs.readFileSync(path.join(STRATEGY_DIR, f), 'utf8'));
        return { name: j.name, language: j.language, savedAt: j.savedAt, file: f };
      }).sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt))),
    };
  },

  'POST /api/strategies': async (body) => {
    const name = String(body.name || '').trim();
    if (!name) throw httpErr(400, 'Name required.');
    const safe = name.replace(/[^a-zA-Z0-9._ -]/g, '_');
    fs.mkdirSync(STRATEGY_DIR, { recursive: true });
    fs.writeFileSync(path.join(STRATEGY_DIR, `${safe}.json`), JSON.stringify({ ...body, name, savedAt: new Date().toISOString() }, null, 2));
    return { saved: true, name, file: `${safe}.json` };
  },

  'POST /api/strategies/load': async (body) => {
    const p = path.join(STRATEGY_DIR, path.basename(String(body.file || '')));
    if (!p.startsWith(STRATEGY_DIR) || !fs.existsSync(p)) throw httpErr(404, 'Not found.');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  },

  'POST /api/strategies/delete': async (body) => {
    const p = path.join(STRATEGY_DIR, path.basename(String(body.file || '')));
    if (!p.startsWith(STRATEGY_DIR)) throw httpErr(400, 'Bad path.');
    try { fs.unlinkSync(p); } catch {}
    return { deleted: true };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const key = `${req.method} ${url.pathname}`;

  if (routes[key]) {
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      send(res, 200, await routes[key](body, url));
    } catch (e) {
      send(res, e.status || 500, { error: e.message || String(e), rateLimited: !!e.rateLimited });
    }
    return;
  }

  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, 'Not found', 'text/plain');
  }
  send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
});

server.listen(PORT, '127.0.0.1', () => {
  const ready = Object.values(engine.probeLanguages()).filter((l) => l.available).map((l) => `${l.label} (${l.version})`);
  const creds = loadCreds();
  console.log('');
  console.log('  Strategy Terminal');
  console.log(`  →  http://localhost:${PORT}`);
  console.log(`  runtimes:  ${ready.join(', ') || 'none found'}`);
  console.log(`  providers: ${providers.list().map((p) => p.label).join(', ')}`);
  if (creds) {
    const prov = providers.get(creds.provider);
    const u = prov.module.usage();
    console.log(`  active:    ${prov.label} — key loaded, ${u.used}/${u.limit} requests ${u.label}`);
  } else {
    console.log(`  active:    none — add a key in the UI (default ${providers.get().label})`);
  }
  console.log('');
});

process.on('SIGINT', () => { stopLive(); process.exit(0); });
