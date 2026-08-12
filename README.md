# Strategy Terminal

A local terminal for testing trading strategies against **Alpha Vantage** data. Paste a
strategy in **Python, JavaScript, or Ruby**, pick the language from a dropdown, and run
it over historical bars — or forward-test it on live bars with simulated fills.

Zero npm dependencies. Nothing leaves your machine except the calls to Alpha Vantage.

```bash
node server.js          # → http://localhost:4477
node selftest.js        # runs the same strategy through every runtime and checks they agree
```

## How it works

```
browser UI  ──▶  server.js  ──▶  alphavantage.js  ──▶  Alpha Vantage
                    │                  └─ disk cache + daily quota counter
                    ├──▶  runners/python.py    ─┐
                    ├──▶  runners/javascript.js ├─ your code, in a subprocess
                    └──▶  runners/ruby.rb      ─┘   emits ORDERS only
                    │
                    └──▶  engine.js  — fills, portfolio accounting, statistics
```

The split matters: **a runner only turns bars into orders.** Every dollar of the
simulation — fill prices, slippage, commissions, position accounting, equity, stats —
happens in `engine.js`. That's why the same strategy gives byte-identical results in
all three languages, and why adding a language can't quietly change your numbers.

The data provider is isolated in `alphavantage.js` behind `fetchBars()`. Swapping
providers doesn't touch the engine or the runners — when this project moved from Alpaca
to Alpha Vantage, all 20 self-test checks kept passing untouched.

The browser can't reliably call a data API directly, and a key in a static HTML file is
a key sitting in plaintext — hence the local server. It binds to `127.0.0.1` only.

## The quota is the constraint

Alpha Vantage's free tier allows **25 requests per day.** The whole data layer is built
around not wasting them:

- **Every response is cached to `data/`.** Re-running a backtest over a range you've
  already pulled costs **zero** requests. The results header tells you which happened.
- **A local counter** tracks the day's usage (`data/usage.json`) and shows it in the
  header. Cache hits don't count.
- **Daily/weekly/monthly** history comes back in one request going back 20+ years.
  Prefer these.
- **Intraday** (`1Min`–`1Hour`) returns ~30 days in one request. Older intraday needs
  one request *per calendar month*, so the server refuses ranges that would cost more
  than ~6 requests rather than silently draining your quota.
- **Live mode** spends one request per tick, so it polls every 5–15 minutes, not
  seconds, and stops itself when the quota runs out.

### Free-tier data is not split-adjusted

`TIME_SERIES_DAILY_ADJUSTED` is a premium endpoint, so daily bars come back raw. A 2:1
split looks like a 50% overnight crash, and a backtest will happily book it as a real
loss. The terminal scans for single-bar gaps beyond ±40% and warns you above the
results. **Take that warning seriously** — it's the difference between a strategy that
works and one that "made 200%" off a reverse split.

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

**Go Live** warms up on history, then polls Alpha Vantage for new bars and re-runs your
strategy forward. Fills are **simulated** — no order is placed anywhere. The live
portion of the run is shaded on the charts.

On the free tier this is quota-bound: each tick is one request, so a 5-minute poll gives
you about two hours before the day's 25 are gone. The session stops itself rather than
failing silently, and the panel shows how long you have left.

## Adding a language

1. Write `runners/<lang>.<ext>` — read the request JSON (argv[1]), walk the bars calling
   the user's entry point, write `{ok, orders, logs, plots}` to argv[2].
2. Add one line to `LANGUAGES` in `engine.js`.
3. Add a starter template to `TEMPLATES` in `public/app.js`.
4. Run `node selftest.js` — it will pick the new runtime up and check it agrees with the others.

Use `runners/python.py` as the reference; it's pure stdlib and the easiest to port.

## Notes

- Timeframes: `1Min 5Min 15Min 30Min 1Hour 1Day 1Week 1Month`.
- `.credentials.json` holds your API key at chmod 600 and is gitignored. Never commit it.
- `data/` (cached bars + the usage counter) is gitignored too — delete it any time to
  force fresh fetches, at the cost of requests.
- Backtest results are not predictions. Optimising params until the curve looks good is
  how you overfit; treat the numbers as a way to reject bad ideas, not confirm good ones.
