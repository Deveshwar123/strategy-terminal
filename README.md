# Strategy Terminal

A local terminal for testing trading strategies. Paste a strategy in **Python,
JavaScript, or Ruby**, pick the language from a dropdown, pick the data provider from
another, and run it over historical bars — or forward-test it on live bars with
simulated fills.

Zero npm dependencies. Nothing leaves your machine except the calls to your data provider.

```bash
node server.js          # → http://localhost:4477
node selftest.js        # runs the same strategy through every runtime and checks they agree
```

## How it works

```
browser UI  ──▶  server.js  ──▶  providers/finnhub.js       ─┐
                    │            providers/alphavantage.js  ─┴─ pick one in the UI
                    │                  └─ disk cache + usage counter
                    ├──▶  runners/python.py    ─┐
                    ├──▶  runners/javascript.js ├─ your code, in a subprocess
                    └──▶  runners/ruby.rb      ─┘   emits ORDERS only
                    │
                    └──▶  engine.js  — fills, portfolio accounting, statistics
```

Two pluggable axes, same idea both times: **languages** in `runners/`, **data providers**
in `providers/`. Neither knows the other exists, and `engine.js` knows about neither.

The split matters: **a runner only turns bars into orders.** Every dollar of the
simulation — fill prices, slippage, commissions, position accounting, equity, stats —
happens in `engine.js`. That's why the same strategy gives byte-identical results in
all three languages, and why adding a language can't quietly change your numbers.

Each provider is isolated behind four functions (`fetchBars`, `verifyKey`, `latestQuote`,
`usage`), registered in `providers/index.js`. Swapping providers doesn't touch the engine
or the runners — this project has now moved Alpaca → Alpha Vantage → Finnhub, and all 20
self-test checks kept passing untouched each time.

The browser can't reliably call a data API directly, and a key in a static HTML file is
a key sitting in plaintext — hence the local server. It binds to `127.0.0.1` only.

## Providers

| | free limit | catch |
|---|---|---|
| **Finnhub** (default) | 60 req/**minute** | **`/stock/candle` is a PAID endpoint.** Free keys get HTTP 403 on equity history — which is exactly what a backtest needs. Crypto (`BINANCE:BTCUSDT`) and forex (`OANDA:EUR_USD`) candles are free. |
| **Alpha Vantage** | 25 req/**day** | Free daily bars are not split-adjusted. |

Switch in the **API Keys** dialog; the key is stored per provider. Symbols route by
prefix on Finnhub: a bare ticker is an equity, `VENUE:PAIR` goes to crypto or forex.

**If Finnhub 403s you, that's the paywall, not a bug** — the error says so and points you
at the alternatives. Alpha Vantage is the free fallback for equity daily bars.

### Both providers cache

Every response is cached to `data/`; re-running a backtest over a range you've already
pulled costs **zero** requests, and the results header tells you which happened. The
header pill shows usage against whichever limit applies. Specifically for Alpha Vantage's
much tighter budget:

- **Daily/weekly/monthly** history comes back in one request going back 20+ years.
  Prefer these.
- **Intraday** (`1Min`–`1Hour`) returns ~30 days in one request. Older intraday needs
  one request *per calendar month*, so the server refuses ranges that would cost more
  than ~6 requests rather than silently draining your quota.
- **Live mode** spends one request per tick. On Alpha Vantage it polls every 5–15
  minutes and stops itself when the quota runs out; on Finnhub it can poll every 30s.

### Watch for unadjusted splits

Alpha Vantage's `TIME_SERIES_DAILY_ADJUSTED` is premium, so its free daily bars come back
raw. A 2:1 split looks like a 50% overnight crash, and a backtest will happily book it as
a real loss. The terminal scans for single-bar gaps beyond ±40% and warns above the
results (wording adapts to whether the feed is adjusted). **Take that warning seriously**
— it's the difference between a strategy that works and one that "made 200%" off a
reverse split.

## Writing a strategy

| | entry point | optional setup |
|---|---|---|
| Python | `def on_bar(bar, ctx):` | `def initialize(ctx):` |
| JavaScript | `function onBar(bar, ctx)` | `function initialize(ctx)` |
| Ruby | `def on_bar(bar, ctx)` | `def initialize_strategy(ctx)` |

Same `ctx` concepts everywhere — snake_case in Python/Ruby, camelCase in JavaScript.
The **API** button in the UI has the full list.

```python
def on_bar(bar, ctx):
    fast, slow = ctx.sma(10), ctx.sma(30)
    if fast is None or slow is None:      # warmup
        return
    if fast > slow and ctx.is_flat:
        ctx.buy(100, "cross up")
    elif fast < slow and ctx.is_long:
        ctx.close("cross down")
```

**Orders:** `buy(qty, reason)` · `sell(qty, reason)` · `close(reason)` · `target(qty, reason)`
**Position:** `position` `avg_price` `is_long` `is_short` `is_flat` `cash` `equity` `unrealized`
**History:** `closes` `opens` `highs` `lows` `volumes`, and `close_(n)` for n bars back
**Indicators:** `sma ema rsi atr stdev highest lowest roc`, each taking `(length, back=0)`
**Output:** `ctx.log(...)` → Console tab · `ctx.plot(name, value)` → overlays the price chart
**Params:** `ctx.param('fast', 10)` reads the Params JSON box, so you can tune without editing code

### Two rules worth internalising

**No lookahead.** `ctx` never exposes a bar past the current one. Indicators are
precomputed for speed, but every formula is causal — index *k* only ever depends on
bars ≤ *k* — so precomputing can't leak the future.

**Fills are pessimistic by default.** A signal on bar *i* fills at the **open of bar
i+1**, the earliest price you could realistically have transacted at. Settings can
switch to same-bar close, but that flatters results — it assumes you saw the close
and traded at it. Add slippage and commission there too; a strategy that only works
at 0 bps isn't a strategy.

## Live mode

**Go Live** warms up on history, then polls your provider for new bars and re-runs your
strategy forward. Fills are **simulated** — no order is placed anywhere. The live
portion of the run is shaded on the charts.

Cadence follows the provider's limit shape: Finnhub's per-minute budget allows a 30s
poll, while Alpha Vantage's 25/day forces 5–15 minutes and the session stops itself
when the quota runs out rather than failing silently.

## Adding a provider

Write `providers/<name>.js` exporting `fetchBars({symbol, timeframe, start, end, limit,
force}, apiKey) -> {bars, meta}`, plus `verifyKey`, `latestQuote`, `usage`, and
`TIMEFRAMES`. Register it in `providers/index.js`. Nothing else changes.

## Adding a language

1. Write `runners/<lang>.<ext>` — read the request JSON (argv[1]), walk the bars calling
   the user's entry point, write `{ok, orders, logs, plots}` to argv[2].
2. Add one line to `LANGUAGES` in `engine.js`.
3. Add a starter template to `TEMPLATES` in `public/app.js`.
4. Run `node selftest.js` — it will pick the new runtime up and check it agrees with the others.

Use `runners/python.py` as the reference; it's pure stdlib and the easiest to port.

## Notes

- Timeframes: `1Min 5Min 15Min 30Min 1Hour 1Day 1Week 1Month`.
- `.credentials.json` holds your API key and the chosen provider at chmod 600, gitignored.
- `data/` (cached bars + the usage counter) is gitignored too — delete it any time to
  force fresh fetches, at the cost of requests.
- Backtest results are not predictions. Optimising params until the curve looks good is
  how you overfit; treat the numbers as a way to reject bad ideas, not confirm good ones.
