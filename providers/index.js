'use strict';
// Provider registry. Every provider exposes the same three functions, so server.js never
// branches on which one is active:
//
//   fetchBars({symbol, timeframe, start, end, limit, force, range}, ) -> { bars, meta }
//   latestQuote(symbol)                                               -> { symbol, price, ... }
//   usage()                                                           -> { used, limit, remaining, label }
//
// `range: 'max'` overrides `start` and means "from inception". Resolve it however the feed
// allows — Yahoo reads meta.firstTradeDate — and report the resolved window in
// meta.inception / meta.requestedFrom. If `limit` clips bars, say so in meta.truncated.
//
// Yahoo is the only provider, permanently and by choice. Finnhub (paywalled candles on the
// free tier, 403 on both /stock/candle and /crypto/candle) and Alpha Vantage (25 requests
// a day, and free daily bars are not split-adjusted) were both removed on 2026-08-16
// together with the whole API-key mechanism — see ST-10 in BUGS.md. Their modules are in
// git history at commit e1facd9 if a paid plan ever makes one worth reviving.
//
// This table is still here, rather than server.js requiring ./yahoo directly, because it
// is the seam: a new feed is a new module plus one entry, and nothing else changes.

const yahoo = require('./yahoo');

const PROVIDERS = {
  yahoo: {
    id: 'yahoo',
    label: 'Yahoo Finance',
    module: yahoo,
    limitNote: 'No API key and no daily quota. 40+ years of split-adjusted daily bars.',
    warning:
      'Intraday history is capped by Yahoo and cannot be extended: 8 days per request for 1Min, 60 days of ' +
      '5–30Min, 730 days of 1Hour. Deep history is 1Day and up. This is an undocumented public ' +
      'endpoint — free and reliable in practice, but not a contract Yahoo owes you.',
  },
};

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
