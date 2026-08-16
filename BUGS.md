# Bug log

Tickets opened and closed against Strategy Terminal. Newest first.

---

## ST-6 — `.gitignore` would not have caught a credentials backup · CLOSED 2026-08-15

**Symptom.** Found while making a backup of `.credentials.json` before switching
providers: the backup was **not** ignored and would have been committed — with a live
API key in it.

**Root cause.** `.gitignore` listed the exact filename `.credentials.json`. Any variant
(`.credentials.finnhub.bak.json`, `.credentials.local.json`) fell straight through.

**Fix.** Pattern widened to `.credentials*` in `.gitignore`. Verified with
`git check-ignore -v` against both the real file and a backup before anything was staged.

**Note.** Caught before any commit — no key was ever exposed. Nothing to rotate.

---

## ST-5 — Finnhub paywalled crypto candles; documented fallback was dead · CLOSED 2026-08-15

**Symptom.** No backtest could fetch data on any provider. Finnhub returned HTTP 403 for
`/stock/candle` (known, documented) **and** for `/crypto/candle` (new). The 403 handler
and the README both told the user to "test on crypto instead — `/crypto/candle` is free",
which was advice into a wall.

**Root cause.** Not our code — an upstream policy change at Finnhub. The bug is that the
error message and docs asserted a third-party's pricing as fact and went stale silently.
Alpha Vantage had no key stored, and Stooq (the obvious keyless fallback) now serves a
JavaScript proof-of-work bot wall, so every data path was blocked at once.

**Fix.** Added `providers/yahoo.js` — keyless, no quota, 40+ years of split-adjusted daily
bars — and made it the registry default. Introduced a `keyless: true` provider flag so
`server.js` skips its credential gate. Corrected the stale crypto claim in the Finnhub
registry warning and the README.

**Verification.** First end-to-end run against real market data in this project's history:
Python 50/200 SMA crossover on `SPY`, 8,443 daily bars, 1993-01-29 → 2026-08-14, 16 trades,
CAGR 9.57%, Sharpe 0.74, max DD -33.7%. `node selftest.js` still 20/20.

**Lesson worth keeping.** Two Yahoo behaviours corrupt a backtest *silently* rather than
erroring, and both are now handled and commented in the provider: `range=max` coarsens the
interval (~168 bars for 42 years instead of ~10,500), and the shipped OHLC is raw while
only `adjclose` is adjusted.

---

## ST-4 — Hidden status pills still rendered as empty chips · CLOSED 2026-08-12

**Symptom.** With no API keys connected, two blank pills sat next to the connection
badge in the header.

**Root cause.** `#acctPill` / `#clockPill` are toggled with the `hidden` attribute,
but `.pill` sets `display: inline-flex`, which is a more specific declaration than the
UA stylesheet's `[hidden] { display: none }` — so `hidden` had no effect.

**Fix.** Added `[hidden] { display: none !important; }` in `public/styles.css`.

---

## ST-3 — Every equity-curve y-axis label read "$100k" · CLOSED 2026-08-12

**Symptom.** All five y-axis ticks on the equity chart showed the same label, making
the axis useless.

**Root cause.** The formatter abbreviated with `(v/1000).toFixed(0) + 'k'`. An equity
curve moving between $98,780 and $100,114 rounds to `100k` at every tick — the
abbreviation threw away exactly the precision the axis exists to show.

**Fix.** New `axisMoney()` in `public/app.js` prints full dollars with separators and
only abbreviates above $1M. Right margin widened 58→66px to fit.

---

## ST-2 — X-axis date labels overlapped · CLOSED 2026-08-12

**Symptom.** On narrower panes the last two date labels collided ("Sep 7, 24Oct 27, 24").

**Root cause.** Tick count was hardcoded to 6 regardless of chart width.

**Fix.** Tick count now derives from available width (`Math.floor(W / 100)`, capped at 6).

---

## ST-1 — Line-number gutter rendered horizontally, hiding the editor · CLOSED 2026-08-12

**Symptom.** The gutter showed `1 2 3 4 5 …` across one line and expanded to fill the
pane, leaving the code textarea almost entirely obscured.

**Root cause.** The gutter is a `<div>` whose `textContent` is line numbers joined by
`\n`. Default `white-space: normal` collapses newlines to spaces, so every number
landed on one line and the div grew to match.

**Fix.** `white-space: pre` on `.gutter` in `public/styles.css`.

---

All four were found by rendering the UI in a browser and looking at it, not by tests —
the self-test covers the engine and runners, which have no visual surface.
