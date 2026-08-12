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

const finnhub = require('./finnhub');
const alphavantage = require('./alphavantage');

const PROVIDERS = {
  finnhub: {
    id: 'finnhub',
    label: 'Finnhub',
    module: finnhub,
    keyUrl: 'https://finnhub.io/dashboard',
    keyPlaceholder: 'e.g. cq3k9h1r01qm8p9v2mtg',
    limitNote: '60 requests/minute on the free tier.',
    warning:
      'Finnhub keeps historical stock candles (/stock/candle) behind a PAID plan — free keys get HTTP 403, ' +
      'which blocks equity backtesting. Crypto candles are free (try BINANCE:BTCUSDT). If you hit the 403, ' +
      'switch to Alpha Vantage here.',
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

const DEFAULT = 'finnhub';

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
