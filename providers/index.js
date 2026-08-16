'use strict';
// Provider registry. Every provider exposes the same four functions, so server.js
// never branches on which one is active:
//
//   fetchBars({symbol, timeframe, start, end, limit, force}, apiKey) -> { bars, meta }
//   verifyKey(apiKey)                                               -> { symbol, price, ... }
//   latestQuote(symbol, apiKey)                                     -> { symbol, price, ... }
//   usage()                                                         -> { used, limit, remaining, label }
//
// To add a provider: write the module, add an entry below. Nothing else changes —
// engine.js and the runners have no idea providers exist.

// `keyless: true` means fetchBars ignores the apiKey argument entirely. server.js uses
// the flag to skip its credential gate; everything else about the contract is identical.

const yahoo = require('./yahoo');
const finnhub = require('./finnhub');
const alphavantage = require('./alphavantage');

const PROVIDERS = {
  yahoo: {
    id: 'yahoo',
    label: 'Yahoo Finance',
    module: yahoo,
    keyless: true,
    keyUrl: '',
    keyPlaceholder: '',
    limitNote: 'No API key and no daily quota. 40+ years of split-adjusted daily bars.',
    warning:
      'Intraday history is capped by Yahoo and cannot be extended: ~30 days of 1Min, 60 days of ' +
      '5–30Min, 730 days of 1Hour. Deep history is 1Day and up. This is an undocumented public ' +
      'endpoint — free and reliable in practice, but not a contract Yahoo owes you.',
  },
  finnhub: {
    id: 'finnhub',
    label: 'Finnhub',
    module: finnhub,
    keyUrl: 'https://finnhub.io/dashboard',
    keyPlaceholder: 'e.g. cq3k9h1r01qm8p9v2mtg',
    limitNote: '60 requests/minute on the free tier.',
    warning:
      'Finnhub keeps historical candles behind a PAID plan — free keys get HTTP 403 on /stock/candle AND ' +
      '/crypto/candle (verified 2026-08-15; crypto used to be free and no longer is). That blocks backtesting ' +
      'outright on a free key. Use Yahoo Finance instead — no key required.',
  },
  alphavantage: {
    id: 'alphavantage',
    label: 'Alpha Vantage',
    module: alphavantage,
    keyUrl: 'https://www.alphavantage.co/support/#api-key',
    keyPlaceholder: 'e.g. J8KD91MZQ4RTVX02',
    limitNote: '25 requests/day on the free tier — responses are cached so re-runs are free.',
    warning:
      'Free daily bars are NOT split-adjusted (the adjusted endpoint is premium), so a split reads as a real ' +
      'overnight move. The terminal flags gaps beyond ±40%.',
  },
};

// Yahoo is the default because it is the only one that works without a key or a quota.
const DEFAULT = 'yahoo';

function get(id) {
  const p = PROVIDERS[id || DEFAULT];
  if (!p) throw new Error(`Unknown data provider "${id}". Available: ${Object.keys(PROVIDERS).join(', ')}`);
  return p;
}

function list() {
  return Object.values(PROVIDERS).map(({ module, ...rest }) => ({
    ...rest,
    timeframes: Object.keys(module.TIMEFRAMES),
  }));
}

module.exports = { PROVIDERS, DEFAULT, get, list };
