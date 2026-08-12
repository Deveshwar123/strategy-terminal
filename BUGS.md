# Bug log

Tickets opened and closed against Strategy Terminal. Newest first.

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
