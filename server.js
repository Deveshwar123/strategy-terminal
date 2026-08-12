'use strict';
// Strategy Terminal -- local backtesting/forward-testing server.
// Zero npm dependencies: node:http + node:https only. Binds to 127.0.0.1 so nothing
// on your network can reach it, and your API key never leaves this machine.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const engine = require('./engine');
const av = require('./alphavantage');

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

function requireCreds() {
  const c = loadCreds();
  if (!c || !c.apiKey) throw httpErr(401, 'No Alpha Vantage API key set. Add it first.');
  return c;
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
    const { bars } = await av.fetchBars(
      { symbol: c.symbol, timeframe: c.timeframe, start: c.start, end: '', force: true },
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

    // Stop rather than silently burn the rest of the daily quota.
    if (av.usage().remaining <= 0) {
      live.lastError = 'Daily Alpha Vantage quota exhausted — live session stopped.';
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
    usage: av.usage(),
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

const routes = {
  'GET /api/languages': async () => ({ languages: engine.probeLanguages() }),

  'GET /api/usage': async () => av.usage(),

  'GET /api/status': async () => {
    const creds = loadCreds();
    if (!creds || !creds.apiKey) return { connected: false, usage: av.usage() };
    return {
      connected: true,
      provider: 'Alpha Vantage',
      keyPreview: creds.apiKey.slice(0, 4) + '…' + creds.apiKey.slice(-3),
      verifiedAt: creds.verifiedAt,
      usage: av.usage(),
      timeframes: Object.keys(av.TIMEFRAMES),
    };
  },

  'POST /api/connect': async (body) => {
    const apiKey = (body.apiKey || '').trim();
    if (!apiKey) throw httpErr(400, 'API key is required.');
    const quote = await av.verifyKey(apiKey); // costs one request
    saveCreds({ provider: 'alphavantage', apiKey, verifiedAt: new Date().toISOString() });
    return { connected: true, quote, usage: av.usage() };
  },

  'POST /api/disconnect': async () => {
    try { fs.unlinkSync(CRED_FILE); } catch {}
    return { connected: false };
  },

  'POST /api/bars': async (body) => {
    const creds = requireCreds();
    const { bars, meta } = await av.fetchBars(body, creds.apiKey);
    return { symbol: String(body.symbol).toUpperCase(), timeframe: body.timeframe, count: bars.length, bars, meta };
  },

  'POST /api/quote': async (body) => {
    const creds = requireCreds();
    return av.latestQuote(body.symbol, creds.apiKey);
  },

  'POST /api/run': async (body) => {
    const creds = requireCreds();
    const { language, code, symbol, timeframe, start, end, params, config } = body;
    if (!code || !code.trim()) throw httpErr(400, 'No strategy code.');
    if (!symbol) throw httpErr(400, 'No symbol.');

    const { bars, meta } = await av.fetchBars(
      { symbol, timeframe, start, end, limit: body.maxBars, force: body.force },
      creds.apiKey
    );

    if (bars.length < 2) {
      throw httpErr(422,
        `Alpha Vantage returned ${bars.length} bars for ${String(symbol).toUpperCase()} ${timeframe} in that date range` +
        (meta.availableBars ? ` (${meta.availableBars} bars exist outside it — earliest is ${meta.earliest || 'unknown'}).` : '.') +
        `\n\nCheck the symbol and widen the dates. Intraday timeframes only go back ~30 days without per-month requests.`);
    }

    const result = await engine.backtest({
      language, code, bars, params,
      config: { ...(config || {}), symbol: String(symbol).toUpperCase(), timeframe },
    });
    return { ...result, bars, meta, usage: av.usage(), symbol: String(symbol).toUpperCase(), timeframe, language };
  },

  'POST /api/live/start': async (body) => {
    const creds = requireCreds();
    if (live.running) throw httpErr(409, 'A live session is already running.');

    const pollSeconds = Math.max(60, Number(body.pollSeconds) || 900);
    const perHour = Math.ceil(3600 / pollSeconds);
    const u = av.usage();
    if (u.remaining < 3) {
      throw httpErr(429, `Only ${u.remaining} Alpha Vantage requests left today — not enough to run a live session. Resets at midnight UTC.`);
    }

    const c = {
      symbol: String(body.symbol || '').toUpperCase(),
      timeframe: body.timeframe || '5Min',
      language: body.language, code: body.code,
      params: body.params || {}, config: body.config || {},
      start: body.start, pollSeconds, perHour,
    };
    if (!c.symbol || !c.code) throw httpErr(400, 'Symbol and code are required.');

    const { bars } = await av.fetchBars({ symbol: c.symbol, timeframe: c.timeframe, start: c.start, end: '' }, creds.apiKey);
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
  const u = av.usage();
  console.log('');
  console.log('  Strategy Terminal');
  console.log(`  →  http://localhost:${PORT}`);
  console.log(`  runtimes: ${ready.join(', ') || 'none found'}`);
  console.log(`  data:     Alpha Vantage — ${loadCreds() ? 'key loaded' : 'no key yet, add it in the UI'}`);
  console.log(`  quota:    ${u.used}/${u.limit} requests used today`);
  console.log('');
});

process.on('SIGINT', () => { stopLive(); process.exit(0); });
