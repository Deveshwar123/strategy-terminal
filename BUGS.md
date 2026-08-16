# Bug log

Tickets opened and closed against Strategy Terminal. Newest first.

---

## ST-10 — Removed Finnhub, Alpha Vantage and the whole API-key mechanism · DONE 2026-08-16

**Not a defect — a deliberate change**, logged here because ST-5 and ST-8 reference these
providers and this closes that thread.

**Decision.** Yahoo Finance is the only data feed, permanently and by default. Everything
that existed to support *choosing* a feed or *authenticating* to one is gone.

**Why.** Neither alternative could actually run a backtest on a free tier: Finnhub
paywalled `/stock/candle` **and** `/crypto/candle` (ST-5), and Alpha Vantage allows 25
requests/day with unadjusted free daily bars. Every real run for the past week went through
Yahoo. The key machinery was carrying weight for two providers nobody could use.

**Removed.** `providers/finnhub.js`, `providers/alphavantage.js`; `.credentials.json`
read/write, `requireCreds`, the 401 credential gate, `POST /api/connect`,
`POST /api/disconnect`, `verifyKey`, the `keyless` flag, the API Keys dialog, the provider
picker, and the Alpha-Vantage daily-quota logic in live mode.

**Kept, deliberately.** `providers/index.js` is still a registry rather than a bare
`require('./yahoo')` — it is the seam that let this project move Alpaca → Alpha Vantage →
Finnhub → Yahoo without the engine or runners ever changing. A future feed is one module
plus one entry. Also kept: `.credentials*` in `.gitignore`, so an old key sitting on disk
can never be committed by accident (see ST-6).

**Replaced with.** `POST /api/check` and a **Test feed** button — one real request for one
AAPL bar, answering "is it me or is it Yahoo" without pretending to verify anything.

**Left on disk, not deleted.** `.credentials.json` and `.credentials.finnhub.bak.json` are
no longer read by anything. Deleting them is the user's call; one holds a real (now
useless) Finnhub key.

**Verification.** `selftest.js` 31/31. Live start/poll/stop works with no credentials
present. SPY Max still returns 8,443 bars from 1993-01-29 with 16 trades — unchanged from
before the removal, which is the point: nothing about the data path moved.

---

## ST-9 — One backtick broke the entire UI; "terminal not getting data" · CLOSED 2026-08-16

**Symptom.** Reported as the terminal no longer fetching data. It was worse than that:
**nothing on the page worked at all** — no dropdowns, no buttons, no charts. The server was
healthy the whole time and served bars correctly on request.

**Root cause.** Mine, shipped in `f6172dd`. Documenting the new level API in the in-editor
`API_REF` string, I wrote `` `right` `` around a parameter name — inside a **backtick-delimited
template literal**. That closed the literal early and `public/app.js` failed to parse.
A script that does not parse never executes a single line, so the page rendered as static
HTML with dead controls. "Not getting data" was the visible symptom of a total front-end
failure, which is why the backend looked fine under every test.

**Fix.** Single quotes instead of backticks in that string (`public/app.js:168`).

**Why it shipped.** This is the real defect. `selftest.js` had 29 checks and **not one of them
loaded `public/app.js`** — every check exercised the engine and runners through Node, so the
entire test suite passed with a completely broken UI. ST-1 through ST-4 were all UI bugs found
by eyeballing the browser, and the same blind spot was still there.

**Fix for that.** Two new checks in `selftest.js`:

- `public/app.js parses` — compiles the file with `vm.Script`.
- `all 63 app.js selectors resolve` — every `$('#id')` in `app.js` must match an `id` in
  `index.html` or one the script builds itself. A selector returning null throws at load and
  takes the whole page down, which looks identical to this bug from the outside.

**Verification.** Negative control: reintroducing the backtick makes the suite fail with
`✗ public/app.js parses — Unexpected identifier 'right'`. Restored, 31/31 pass, and a default
backtest returns 500 bars / 9 trades through the running server.

**Lesson worth keeping.** A green test suite that never loads the front-end says nothing about
whether the app works. Backend health checks actively mislead here — every one of them passed
while the page was dead.

---

## ST-8 — 1Min timeframe errored on any start date older than 8 days · CLOSED 2026-08-16

**Symptom.** Found while testing the new Max range against every timeframe: `1Min` threw
`Only 8 days worth of 1m granularity data are allowed to be fetched per request` instead of
returning bars. Reproducible without Max — any 1Min run with a start date more than ~8 days
back failed the same way, so this predates today's work.

**Root cause.** `TIMEFRAMES['1Min'].maxDays` was set to `30`, conflating two different Yahoo
limits: it *stores* ~30 days of 1-minute bars but *serves* at most 8 days per request. The
clamp therefore "fixed" the start date to a value the endpoint still refuses.

**Fix.** `maxDays: 7` for 1Min, with a `note` field explaining the stored-vs-served
distinction; the note is surfaced in the results warning so the cap does not read as
arbitrary. Chunking multiple requests to reach the full 30 days was deliberately not built —
it is a different feature, not a bug fix.

**Verification.** `1Min` Max now returns 1,951 bars over the last 7 days. 5Min (3,121),
1Hour (3,484), 1Week (2,385), 1Month (501) all return bars. `selftest.js` 20/20.

---

## ST-7 — Intraday clamp landed exactly on Yahoo's boundary and was rejected · CLOSED 2026-08-16

**Symptom.** `5Min` with a start date older than the 60-day cap returned
`5m data not available for startTime=… The requested range must be within the last 60 days`
rather than the clamped range the code intended to request.

**Root cause.** The clamp computed `now - maxDays*86400` — precisely Yahoo's boundary. By the
time the request was served, that instant was marginally outside the window, and the endpoint
rejects an out-of-range request outright instead of trimming it. The clamp existed exactly to
prevent this error and was landing one second inside the failure.

**Fix.** Clamp to `now - maxDays*86400 + 6h` in `providers/yahoo.js`. Costs at most one
partial session at the far edge; the alternative is a hard error. `clamped.effectiveFrom` now
reports where the window actually starts, not just what was asked for.

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
