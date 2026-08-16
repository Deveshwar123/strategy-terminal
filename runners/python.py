#!/usr/bin/env python3
"""Python strategy harness.

Your code defines:   def on_bar(bar, ctx): ...
Optionally also:     def initialize(ctx): ...

Pure standard library -- no pandas/numpy required. The harness walks the bars,
hands you a ctx, and collects the orders you emit.
"""

import json
import math
import sys
import traceback

req_path, res_path = sys.argv[1], sys.argv[2]

with open(req_path) as f:
    req = json.load(f)

code = req["code"]
bars = req["bars"]
params = req.get("params") or {}
cfg = {
    "initialCash": 100000, "fillMode": "next_open", "commission": 0,
    "slippageBps": 0, "defaultQty": 100, "symbol": "", "timeframe": "",
}
cfg.update(req.get("config") or {})

N = len(bars)
closes = [b["c"] for b in bars]
opens = [b["o"] for b in bars]
highs = [b["h"] for b in bars]
lows = [b["l"] for b in bars]
volumes = [b["v"] for b in bars]

orders = []
logs = []
plots = {}

_cache = {}
_pivot_cache = {}
_sources = {"close": closes, "open": opens, "high": highs, "low": lows, "volume": volumes}

# Default half-width of a price level, as a fraction of the level's own price. "Did price
# come back to the same point" is never an exact float match, so every level comparison is
# a band: 0.2% either side by default.
TOL_DEFAULT = 0.002


def _pivot_marks(left, right):
    """Every swing point in the series, as (index, price, kind).

    A pivot at index j is not *knowable* until bar j+right — it takes that many later bars
    to prove nothing exceeded it. The whole array is precomputed for speed, exactly like
    the indicator series above, and every read is gated on that confirmation index so a
    strategy can never see a pivot the market hadn't confirmed yet.

    Ties are broken by comparing `>` on the left and `>=` on the right, which makes the
    LAST bar of a flat top the pivot. Arbitrary, but it has to be identical in all three
    runners or they stop agreeing.
    """
    key = (left, right)
    if key in _pivot_cache:
        return _pivot_cache[key]

    out = []
    for j in range(left, N - right):
        h, l = highs[j], lows[j]
        is_high = is_low = True
        for a in range(1, left + 1):
            if highs[j - a] > h:
                is_high = False
            if lows[j - a] < l:
                is_low = False
            if not is_high and not is_low:
                break
        if is_high or is_low:
            for b in range(1, right + 1):
                if highs[j + b] >= h:
                    is_high = False
                if lows[j + b] <= l:
                    is_low = False
        if is_high:
            out.append((j, h, "high"))
        if is_low:
            out.append((j, l, "low"))

    _pivot_cache[key] = out
    return out


def _series(kind, n, source):
    """Full causal indicator series. Index k only ever uses bars <= k, so
    precomputing the whole array cannot leak future data into a decision."""
    key = (kind, n, source)
    if key in _cache:
        return _cache[key]
    s = _sources.get(source, closes)
    out = [None] * N

    if kind == "sma":
        total = 0.0
        for k in range(N):
            total += s[k]
            if k >= n:
                total -= s[k - n]
            if k >= n - 1:
                out[k] = total / n
    elif kind == "ema":
        a = 2.0 / (n + 1)
        total = 0.0
        for k in range(N):
            total += s[k]
            if k == n - 1:
                out[k] = total / n
            elif k > n - 1:
                out[k] = s[k] * a + out[k - 1] * (1 - a)
    elif kind == "stdev":
        for k in range(n - 1, N):
            w = s[k - n + 1:k + 1]
            m = sum(w) / n
            out[k] = math.sqrt(sum((x - m) ** 2 for x in w) / n)
    elif kind == "highest":
        for k in range(n - 1, N):
            out[k] = max(highs[k - n + 1:k + 1])
    elif kind == "lowest":
        for k in range(n - 1, N):
            out[k] = min(lows[k - n + 1:k + 1])
    elif kind == "roc":
        for k in range(n, N):
            out[k] = (s[k] / s[k - n] - 1) * 100 if s[k - n] else None
    elif kind == "rsi":
        ag = al = 0.0
        for k in range(1, N):
            ch = closes[k] - closes[k - 1]
            g, l = (ch if ch > 0 else 0.0), (-ch if ch < 0 else 0.0)
            if k <= n:
                ag += g / n
                al += l / n
                if k == n:
                    out[k] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
            else:
                ag = (ag * (n - 1) + g) / n
                al = (al * (n - 1) + l) / n
                out[k] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    elif kind == "atr":
        tr = [0.0] * N
        for k in range(N):
            tr[k] = (highs[k] - lows[k]) if k == 0 else max(
                highs[k] - lows[k], abs(highs[k] - closes[k - 1]), abs(lows[k] - closes[k - 1]))
        total = 0.0
        for k in range(N):
            total += tr[k]
            if k == n - 1:
                out[k] = total / n
            elif k > n - 1:
                out[k] = (out[k - 1] * (n - 1) + tr[k]) / n

    _cache[key] = out
    return out


class Ctx(object):
    def __init__(self):
        self.i = 0
        self._pos = 0.0
        self._avg = 0.0
        self._cash = float(cfg["initialCash"])
        self._pending = []

    # ---- current bar / meta
    @property
    def bar(self):
        return bars[self.i]

    @property
    def index(self):
        return self.i

    @property
    def length(self):
        return N

    @property
    def symbol(self):
        return cfg["symbol"]

    @property
    def timeframe(self):
        return cfg["timeframe"]

    # ---- portfolio state
    @property
    def position(self):
        return self._pos

    @property
    def avg_price(self):
        return 0.0 if self._pos == 0 else self._avg

    @property
    def is_long(self):
        return self._pos > 0

    @property
    def is_short(self):
        return self._pos < 0

    @property
    def is_flat(self):
        return self._pos == 0

    @property
    def cash(self):
        return self._cash

    @property
    def equity(self):
        return self._cash + self._pos * closes[self.i]

    @property
    def unrealized(self):
        return 0.0 if self._pos == 0 else self._pos * (closes[self.i] - self._avg)

    # ---- history (never includes future bars)
    @property
    def closes(self):
        return closes[:self.i + 1]

    @property
    def opens(self):
        return opens[:self.i + 1]

    @property
    def highs(self):
        return highs[:self.i + 1]

    @property
    def lows(self):
        return lows[:self.i + 1]

    @property
    def volumes(self):
        return volumes[:self.i + 1]

    def _at(self, arr, back=0):
        k = self.i - back
        return arr[k] if 0 <= k < N else None

    def close_(self, back=0):
        return self._at(closes, back)

    def open_(self, back=0):
        return self._at(opens, back)

    def high_(self, back=0):
        return self._at(highs, back)

    def low_(self, back=0):
        return self._at(lows, back)

    # ---- orders
    def _emit(self, side, qty, reason=""):
        q = abs(float(qty))
        if q == 0 or not math.isfinite(q):
            return
        o = {"i": self.i, "side": side, "qty": q, "reason": reason}
        orders.append(o)
        self._pending.append(o)

    def buy(self, qty=None, reason=""):
        self._emit("buy", cfg["defaultQty"] if qty is None else qty, reason)

    def sell(self, qty=None, reason=""):
        self._emit("sell", cfg["defaultQty"] if qty is None else qty, reason)

    def close(self, reason="close"):
        if self._pos > 0:
            self._emit("sell", self._pos, reason)
        elif self._pos < 0:
            self._emit("buy", -self._pos, reason)

    def target(self, qty, reason=""):
        d = qty - self._pos
        if d > 0:
            self._emit("buy", d, reason)
        elif d < 0:
            self._emit("sell", -d, reason)

    def _apply_fill(self, side, qty, price):
        q = qty if side == "buy" else -qty
        d = 1 if side == "buy" else -1
        px = price * (1 + (d * cfg["slippageBps"]) / 10000.0)
        self._cash -= q * px + cfg["commission"]
        if self._pos == 0:
            self._avg, self._pos = px, q
        elif (q > 0) == (self._pos > 0):
            self._avg = (self._avg * abs(self._pos) + px * abs(q)) / (abs(self._pos) + abs(q))
            self._pos += q
        else:
            before = self._pos
            self._pos += q
            if self._pos != 0 and (self._pos > 0) != (before > 0):
                self._avg = px

    # ---- indicators (back=1 gives the previous bar's value)
    def sma(self, n, back=0, source="close"):
        return self._at(_series("sma", n, source), back)

    def ema(self, n, back=0, source="close"):
        return self._at(_series("ema", n, source), back)

    def rsi(self, n=14, back=0):
        return self._at(_series("rsi", n, "close"), back)

    def atr(self, n=14, back=0):
        return self._at(_series("atr", n, "close"), back)

    def stdev(self, n, back=0, source="close"):
        return self._at(_series("stdev", n, source), back)

    def highest(self, n, back=0):
        return self._at(_series("highest", n, "high"), back)

    def lowest(self, n, back=0):
        return self._at(_series("lowest", n, "low"), back)

    def roc(self, n, back=0, source="close"):
        return self._at(_series("roc", n, source), back)

    # ---- price levels: "has price been here before, and is it here again?"
    def _tol(self, tol):
        return TOL_DEFAULT if tol is None else float(tol)

    def window(self, n, source="close"):
        """Last n values of a series as a plain list, oldest first. Never includes a
        future bar, so slicing it is safe."""
        s = _sources.get(source, closes)
        k = self.i + 1
        return s[max(0, k - n):k]

    def touched(self, level, tol=None, back=0):
        """Did that bar's range reach this price? back=1 asks about yesterday."""
        if level is None:
            return False
        try:
            lv = float(level)
        except (TypeError, ValueError):
            return False
        if not math.isfinite(lv):
            return False
        k = self.i - back
        if k < 0 or k >= N:
            return False
        t = self._tol(tol) * abs(lv)
        return lows[k] <= lv + t and highs[k] >= lv - t

    def count_touches(self, level, lookback=250, tol=None):
        """How many earlier bars reached this price. Excludes the current bar, so it
        answers 'how well established is this level' before you act on today."""
        if level is None:
            return 0
        try:
            lv = float(level)
        except (TypeError, ValueError):
            return 0
        if not math.isfinite(lv):
            return 0
        t = self._tol(tol) * abs(lv)
        c = 0
        for k in range(max(0, self.i - lookback), self.i):
            if lows[k] <= lv + t and highs[k] >= lv - t:
                c += 1
        return c

    def pivots(self, left=2, right=2, lookback=250, kind="both"):
        """Confirmed swing highs/lows within lookback, oldest first."""
        out = []
        lo = self.i - lookback
        for (j, price, k) in _pivot_marks(left, right):
            if j + right > self.i:
                break  # marks are index-ordered, so nothing later is confirmed either
            if j < lo:
                continue
            if kind != "both" and k != kind:
                continue
            out.append({"price": price, "i": j, "kind": k, "bars_ago": self.i - j})
        return out

    def levels(self, tol=None, left=2, right=2, lookback=250, min_touches=1):
        """Swing points collapsed into price levels: pivots within tol of each other are
        the same level, and `touches` is how many times price turned there. Sorted by
        touches desc, so levels()[0] is the most respected one in view."""
        t = self._tol(tol)
        clusters = []
        for p in self.pivots(left, right, lookback, "both"):
            hit = None
            for c in clusters:
                if abs(p["price"] - c["price"]) <= t * abs(c["price"]):
                    hit = c
                    break
            if hit is None:
                clusters.append({
                    "price": p["price"], "_sum": p["price"], "touches": 1,
                    "highs": 1 if p["kind"] == "high" else 0,
                    "lows": 1 if p["kind"] == "low" else 0,
                    "last_i": p["i"],
                })
            else:
                hit["_sum"] += p["price"]
                hit["touches"] += 1
                hit["price"] = hit["_sum"] / hit["touches"]
                if p["kind"] == "high":
                    hit["highs"] += 1
                else:
                    hit["lows"] += 1
                if p["i"] > hit["last_i"]:
                    hit["last_i"] = p["i"]

        out = []
        for c in clusters:
            if c["touches"] < min_touches:
                continue
            kind = "high" if c["highs"] > c["lows"] else ("low" if c["lows"] > c["highs"] else "both")
            out.append({"price": c["price"], "kind": kind, "touches": c["touches"],
                        "last_i": c["last_i"], "bars_ago": self.i - c["last_i"]})
        # Third sort key only exists to make ties total — two runners disagreeing on the
        # order of equal-ranked levels would silently diverge their trades.
        out.sort(key=lambda x: (-x["touches"], x["price"], x["last_i"]))
        return out

    def retest(self, tol=None, left=2, right=2, lookback=250, min_touches=1):
        """The level today's bar is revisiting, or None. Most-touched level wins."""
        for lv in self.levels(tol, left, right, lookback, min_touches):
            if lv["last_i"] < self.i and self.touched(lv["price"], tol):
                return lv
        return None

    # ---- misc
    def param(self, name, default=None):
        return params.get(name, default)

    def log(self, *args):
        logs.append({"i": self.i, "t": bars[self.i]["t"],
                     "msg": " ".join(json.dumps(a) if isinstance(a, (dict, list)) else str(a) for a in args)})

    def plot(self, name, value):
        if name not in plots:
            plots[name] = [None] * N
        try:
            v = float(value)
            plots[name][self.i] = v if math.isfinite(v) else None
        except (TypeError, ValueError):
            plots[name][self.i] = None


def fail(message, tb=None, bar_index=None):
    err = {"message": message}
    if tb:
        err["traceback"] = tb
    if bar_index is not None:
        err["bar"] = bar_index
        err["time"] = bars[bar_index]["t"]
    with open(res_path, "w") as fh:
        json.dump({"ok": False, "error": err, "logs": logs, "plots": plots}, fh)
    sys.exit(0)


ctx = Ctx()
ns = {"__name__": "strategy", "ctx": ctx, "params": params}

try:
    exec(compile(code, "strategy.py", "exec"), ns)
except Exception:
    fail("Syntax/load error: %s" % sys.exc_info()[1], traceback.format_exc(limit=6))

on_bar = ns.get("on_bar") or ns.get("onBar")
initialize = ns.get("initialize") or ns.get("init")

if not callable(on_bar):
    fail("No on_bar function found. Define:  def on_bar(bar, ctx):")

try:
    if callable(initialize):
        initialize(ctx)
except Exception:
    fail("Error in initialize(): %s" % sys.exc_info()[1], traceback.format_exc(limit=6))

fill_at_close = cfg["fillMode"] == "close"

for idx in range(N):
    ctx.i = idx
    # Fills from the previous bar's signals land at this bar's open, before you see the bar.
    if not fill_at_close and ctx._pending:
        for o in ctx._pending:
            ctx._apply_fill(o["side"], o["qty"], opens[idx])
        ctx._pending = []
    try:
        on_bar(bars[idx], ctx)
    except Exception:
        fail("Error in on_bar() at bar %d: %s" % (idx, sys.exc_info()[1]),
             traceback.format_exc(limit=6), idx)
    if fill_at_close and ctx._pending:
        for o in ctx._pending:
            ctx._apply_fill(o["side"], o["qty"], closes[idx])
        ctx._pending = []

with open(res_path, "w") as fh:
    json.dump({"ok": True, "orders": orders, "logs": logs, "plots": plots}, fh)
