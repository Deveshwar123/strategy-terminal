'use strict';
// Strategy Terminal -- local backtesting/forward-testing server.
// Zero npm dependencies: node:http + node:https only. Binds to 127.0.0.1 so nothing
// on your network can reach it, and your Alpaca keys never leave this machine.

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const engine = require('./engine');

const PORT = Number(process.env.PORT || 4477);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const STRATEGY_DIR = path.join(ROOT, 'strategies');
const CRED_FILE = path.join(ROOT, '.credentials.json');

const DATA_HOST = 'data.alpaca.markets';
const PAPER_HOST = 'paper-api.alpaca.markets';
const LIVE_HOST = 'api.alpaca.markets';

// ------------------------------------------------------------- credentials

function loadCreds() {
  try { return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')); }
  catch { return null; }
}

function saveCreds(c) {
  fs.writeFileSync(CRED_FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
  try { fs.chmodSync(CRED_FILE, 0o600); } catch {}
}

// ------------------------------------------------------------- alpaca client

function alpacaGet(host, pathname, query, creds) {
  const url = new URL(`https://${host}${pathname}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: {
          'APCA-API-KEY-ID': creds.keyId,
          'APCA-API-SECRET-KEY': creds.secretKey,
          'Accept': 'application/json',
        },
        timeout: 30000,
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(body); } catch {}
          if (res.statusCode >= 400) {
            const msg = (json && (json.message || json.error)) || body.slice(0, 300) || `HTTP ${res.statusCode}`;
            const err = new Error(msg);
            err.status = res.statusCode;
            return reject(err);
          }
          resolve(json);
        });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('Alpaca request timed out')); });
    req.on('error', reject);
    req.end();
  });
}

// Alpaca caps each page at 10k bars; follow next_page_token until the range is covered.
async function fetchBars({ symbol, timeframe, start, end, feed, adjustment, limit }, creds) {
  const out = [];
  let token = null;
  let pages = 0;
  const maxBars = Number(limit) || 50000;

  do {
    const res = await alpacaGet(DATA_HOST, '/v2/stocks/bars', {
      symbols: symbol.toUpperCase(),
      timeframe,
      start,
      end,
      limit: 10000,
      adjustment: adjustment || 'split',
      feed: feed || 'iex',
      sort: 'asc',
      page_token: token,
    }, creds);

    const got = (res.bars && res.bars[symbol.toUpperCase()]) || [];
    out.push(...got);
    token = res.next_page_token;
    pages++;
  } while (token && out.length < maxBars && pages < 40);

  return out.slice(0, maxBars).map((b) => ({
    t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, n: b.n, vw: b.vw,
  }));
}

// ------------------------------------------------------------ live session

const live = {
  running: false,
  timer: null,
  cfg: null,
  bars: [],
  liveStartIndex: 0,
  result: null,
  lastPoll: null,
  lastError: null,
  ticks: 0,
  startedAt: null,
};

async function livePoll() {
  const creds = loadCreds();
  if (!creds || !live.running) return;
  try {
    const c = live.cfg;
    // Refetch a trailing window and merge; Alpaca can revise the most recent bar.
    const lookbackMs = tfMillis(c.timeframe) * 5;
    const since = new Date(Date.now() - Math.max(lookbackMs, 15 * 60 * 1000)).toISOString();
    const fresh = await fetchBars(
      { symbol: c.symbol, timeframe: c.timeframe, start: since, end: '', feed: c.feed, adjustment: c.adjustment },
      creds
    );

    let added = 0;
    for (const b of fresh) {
      const last = live.bars[live.bars.length - 1];
      if (!last || new Date(b.t) > new Date(last.t)) { live.bars.push(b); added++; }
      else if (new Date(b.t).getTime() === new Date(last.t).getTime()) { live.bars[live.bars.length - 1] = b; }
    }

    live.result = await engine.backtest({
      language: c.language,
      code: c.code,
      bars: live.bars,
      params: c.params,
      config: { ...c.config, symbol: c.symbol, timeframe: c.timeframe },
    });
    live.lastPoll = new Date().toISOString();
    live.lastError = null;
    live.ticks++;
    live.barsAdded = (live.barsAdded || 0) + added;
  } catch (e) {
    live.lastError = e.message;
  }
}

function tfMillis(tf) {
  const m = /^(\d+)(Min|Hour|Day|Week|Month)$/.exec(tf);
  if (!m) return 60000;
  const n = Number(m[1]);
  const unit = { Min: 60e3, Hour: 3600e3, Day: 86400e3, Week: 604800e3, Month: 2592000e3 }[m[2]];
  return n * unit;
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
    req.on('data', (d) => {
      b += d;
      if (b.length > 20e6) { req.destroy(); reject(new Error('Body too large')); }
    });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(new Error('Invalid JSON body')); } });
    req.on('error', reject);
  });
}

const routes = {
  'GET /api/languages': async () => ({ languages: engine.probeLanguages() }),

  'GET /api/status': async () => {
    const creds = loadCreds();
    if (!creds) return { connected: false };
    try {
      const host = creds.paper === false ? LIVE_HOST : PAPER_HOST;
      const [acct, clock] = await Promise.all([
        alpacaGet(host, '/v2/account', {}, creds),
        alpacaGet(host, '/v2/clock', {}, creds),
      ]);
      return {
        connected: true,
        paper: creds.paper !== false,
        feed: creds.feed || 'iex',
        keyPreview: creds.keyId.slice(0, 6) + '…' + creds.keyId.slice(-4),
        account: {
          status: acct.status,
          equity: Number(acct.equity),
          cash: Number(acct.cash),
          buyingPower: Number(acct.buying_power),
          currency: acct.currency,
        },
        clock: { isOpen: clock.is_open, nextOpen: clock.next_open, nextClose: clock.next_close, now: clock.timestamp },
      };
    } catch (e) {
      return { connected: false, error: e.message, keyPreview: creds.keyId.slice(0, 6) + '…' };
    }
  },

  'POST /api/connect': async (body) => {
    const keyId = (body.keyId || '').trim();
    const secretKey = (body.secretKey || '').trim();
    if (!keyId || !secretKey) throw httpErr(400, 'Both API key ID and secret are required.');
    const paper = body.paper !== false;
    const creds = { keyId, secretKey, paper, feed: body.feed || 'iex' };
    const host = paper ? PAPER_HOST : LIVE_HOST;
    const acct = await alpacaGet(host, '/v2/account', {}, creds); // verify before saving
    saveCreds(creds);
    return { connected: true, accountStatus: acct.status, paper };
  },

  'POST /api/disconnect': async () => {
    try { fs.unlinkSync(CRED_FILE); } catch {}
    return { connected: false };
  },

  'POST /api/bars': async (body) => {
    const creds = requireCreds();
    const bars = await fetchBars({ ...body, feed: body.feed || creds.feed }, creds);
    return { symbol: body.symbol.toUpperCase(), timeframe: body.timeframe, count: bars.length, bars };
  },

  'POST /api/run': async (body) => {
    const creds = requireCreds();
    const { language, code, symbol, timeframe, start, end, params, config } = body;
    if (!code || !code.trim()) throw httpErr(400, 'No strategy code.');
    if (!symbol) throw httpErr(400, 'No symbol.');

    const bars = await fetchBars(
      { symbol, timeframe, start, end, feed: body.feed || creds.feed, adjustment: body.adjustment, limit: body.maxBars },
      creds
    );
    if (bars.length < 2) {
      throw httpErr(422, `Alpaca returned ${bars.length} bars for ${symbol.toUpperCase()} in that range. ` +
        `Check the dates, or try the "iex" feed limits — free accounts have no SIP data and no data older than the account's plan allows.`);
    }

    const result = await engine.backtest({
      language, code, bars, params,
      config: { ...(config || {}), symbol: symbol.toUpperCase(), timeframe },
    });
    return { ...result, bars, symbol: symbol.toUpperCase(), timeframe, language };
  },

  'POST /api/live/start': async (body) => {
    requireCreds();
    if (live.running) throw httpErr(409, 'A live session is already running.');
    const creds = loadCreds();
    const c = {
      symbol: (body.symbol || '').toUpperCase(),
      timeframe: body.timeframe || '1Min',
      language: body.language,
      code: body.code,
      params: body.params || {},
      config: body.config || {},
      feed: body.feed || creds.feed,
      adjustment: body.adjustment,
      pollSeconds: Math.max(5, Number(body.pollSeconds) || 30),
    };
    if (!c.symbol || !c.code) throw httpErr(400, 'Symbol and code are required.');

    // Warm up with history so indicators are primed the moment we go live.
    const warmupMs = tfMillis(c.timeframe) * (Number(body.warmupBars) || 300);
    const warmStart = new Date(Date.now() - Math.max(warmupMs, 2 * 86400e3)).toISOString();
    live.bars = await fetchBars(
      { symbol: c.symbol, timeframe: c.timeframe, start: warmStart, end: '', feed: c.feed, adjustment: c.adjustment },
      creds
    );
    live.liveStartIndex = Math.max(live.bars.length - 1, 0);
    live.cfg = c;
    live.running = true;
    live.ticks = 0;
    live.barsAdded = 0;
    live.lastError = null;
    live.startedAt = new Date().toISOString();

    await livePoll();
    live.timer = setInterval(livePoll, c.pollSeconds * 1000);
    return liveState();
  },

  'POST /api/live/stop': async () => {
    live.running = false;
    if (live.timer) clearInterval(live.timer);
    live.timer = null;
    return liveState();
  },

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
    const payload = { ...body, name, savedAt: new Date().toISOString() };
    fs.mkdirSync(STRATEGY_DIR, { recursive: true });
    fs.writeFileSync(path.join(STRATEGY_DIR, `${safe}.json`), JSON.stringify(payload, null, 2));
    return { saved: true, name, file: `${safe}.json` };
  },

  'POST /api/strategies/load': async (body) => {
    const file = path.basename(String(body.file || ''));
    const p = path.join(STRATEGY_DIR, file);
    if (!p.startsWith(STRATEGY_DIR) || !fs.existsSync(p)) throw httpErr(404, 'Not found.');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  },

  'POST /api/strategies/delete': async (body) => {
    const file = path.basename(String(body.file || ''));
    const p = path.join(STRATEGY_DIR, file);
    if (!p.startsWith(STRATEGY_DIR)) throw httpErr(400, 'Bad path.');
    try { fs.unlinkSync(p); } catch {}
    return { deleted: true };
  },
};

function liveState() {
  return {
    running: live.running,
    cfg: live.cfg ? { ...live.cfg, code: undefined } : null,
    startedAt: live.startedAt,
    lastPoll: live.lastPoll,
    lastError: live.lastError,
    ticks: live.ticks,
    barCount: live.bars.length,
    barsAdded: live.barsAdded || 0,
    liveStartIndex: live.liveStartIndex,
    bars: live.bars,
    result: live.result,
  };
}

function requireCreds() {
  const c = loadCreds();
  if (!c) throw httpErr(401, 'Not connected to Alpaca. Add your API keys first.');
  return c;
}

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const key = `${req.method} ${url.pathname}`;

  if (routes[key]) {
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      send(res, 200, await routes[key](body, url));
    } catch (e) {
      send(res, e.status || 500, { error: e.message || String(e) });
    }
    return;
  }

  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });

  // static files
  let rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, 'Not found', 'text/plain');
  }
  send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
});

server.listen(PORT, '127.0.0.1', () => {
  const langs = engine.probeLanguages();
  const ready = Object.values(langs).filter((l) => l.available).map((l) => `${l.label} (${l.version})`);
  console.log('');
  console.log('  Strategy Terminal');
  console.log(`  →  http://localhost:${PORT}`);
  console.log(`  runtimes: ${ready.join(', ') || 'none found'}`);
  console.log(`  keys:     ${loadCreds() ? 'loaded from .credentials.json' : 'not set — add them in the UI'}`);
  console.log('');
});

process.on('SIGINT', () => { if (live.timer) clearInterval(live.timer); process.exit(0); });
