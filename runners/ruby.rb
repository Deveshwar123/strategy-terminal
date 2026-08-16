#!/usr/bin/env ruby
# Ruby strategy harness.
#
#   Your code defines:  def on_bar(bar, ctx) ... end
#   Optionally also:    def initialize_strategy(ctx) ... end
#
# Bars are hashes with string keys: bar['o'], bar['h'], bar['l'], bar['c'], bar['v'], bar['t'].

require 'json'

req_path, res_path = ARGV[0], ARGV[1]
req = JSON.parse(File.read(req_path))

CODE   = req['code']
BARS   = req['bars']
PARAMS = req['params'] || {}
CFG    = {
  'initialCash' => 100_000, 'fillMode' => 'next_open', 'commission' => 0,
  'slippageBps' => 0, 'defaultQty' => 100, 'symbol' => '', 'timeframe' => ''
}.merge(req['config'] || {})

N       = BARS.length
CLOSES  = BARS.map { |b| b['c'] }
OPENS   = BARS.map { |b| b['o'] }
HIGHS   = BARS.map { |b| b['h'] }
LOWS    = BARS.map { |b| b['l'] }
VOLUMES = BARS.map { |b| b['v'] }

ORDERS = []
LOGS   = []
PLOTS  = {}

CACHE   = {}
PIVOT_CACHE = {}
SOURCES = { 'close' => CLOSES, 'open' => OPENS, 'high' => HIGHS, 'low' => LOWS, 'volume' => VOLUMES }

# Default half-width of a price level, as a fraction of the level's own price. "Did price
# come back to the same point" is never an exact float match, so every level comparison is
# a band: 0.2% either side by default.
TOL_DEFAULT = 0.002

# Every swing point as [index, price, kind]. A pivot at j is not knowable until bar
# j+right -- it takes that many later bars to prove nothing exceeded it -- so reads are
# gated on that confirmation index. Ties compare `>` on the left and `>=` on the right,
# making the last bar of a flat top the pivot; arbitrary, but it has to be identical in
# all three runners or they stop agreeing.
def pivot_marks(left, right)
  key = [left, right]
  return PIVOT_CACHE[key] if PIVOT_CACHE.key?(key)

  out = []
  (left...(N - right)).each do |j|
    h = HIGHS[j]
    l = LOWS[j]
    is_high = true
    is_low  = true
    (1..left).each do |a|
      is_high = false if HIGHS[j - a] > h
      is_low  = false if LOWS[j - a] < l
      break if !is_high && !is_low
    end
    if is_high || is_low
      (1..right).each do |b|
        is_high = false if HIGHS[j + b] >= h
        is_low  = false if LOWS[j + b] <= l
      end
    end
    out << [j, h, 'high'] if is_high
    out << [j, l, 'low']  if is_low
  end

  PIVOT_CACHE[key] = out
  out
end

# Full causal indicator series: index k only uses bars <= k, so precomputing the
# whole array cannot leak future data into a decision.
def series(kind, n, source)
  key = [kind, n, source]
  return CACHE[key] if CACHE.key?(key)

  s = SOURCES[source] || CLOSES
  out = Array.new(N)

  case kind
  when 'sma'
    total = 0.0
    (0...N).each do |k|
      total += s[k]
      total -= s[k - n] if k >= n
      out[k] = total / n if k >= n - 1
    end
  when 'ema'
    a = 2.0 / (n + 1)
    total = 0.0
    (0...N).each do |k|
      total += s[k]
      if k == n - 1 then out[k] = total / n
      elsif k > n - 1 then out[k] = s[k] * a + out[k - 1] * (1 - a)
      end
    end
  when 'stdev'
    (n - 1...N).each do |k|
      w = s[(k - n + 1)..k]
      m = w.sum / n.to_f
      out[k] = Math.sqrt(w.map { |x| (x - m)**2 }.sum / n)
    end
  when 'highest'
    (n - 1...N).each { |k| out[k] = HIGHS[(k - n + 1)..k].max }
  when 'lowest'
    (n - 1...N).each { |k| out[k] = LOWS[(k - n + 1)..k].min }
  when 'roc'
    (n...N).each { |k| out[k] = s[k - n] != 0 ? (s[k] / s[k - n].to_f - 1) * 100 : nil }
  when 'rsi'
    ag = 0.0
    al = 0.0
    (1...N).each do |k|
      ch = CLOSES[k] - CLOSES[k - 1]
      g = ch > 0 ? ch : 0.0
      l = ch < 0 ? -ch : 0.0
      if k <= n
        ag += g / n
        al += l / n
        out[k] = (al.zero? ? 100.0 : 100 - 100 / (1 + ag / al)) if k == n
      else
        ag = (ag * (n - 1) + g) / n
        al = (al * (n - 1) + l) / n
        out[k] = al.zero? ? 100.0 : 100 - 100 / (1 + ag / al)
      end
    end
  when 'atr'
    tr = Array.new(N, 0.0)
    (0...N).each do |k|
      tr[k] = k.zero? ? HIGHS[k] - LOWS[k] : [HIGHS[k] - LOWS[k], (HIGHS[k] - CLOSES[k - 1]).abs, (LOWS[k] - CLOSES[k - 1]).abs].max
    end
    total = 0.0
    (0...N).each do |k|
      total += tr[k]
      if k == n - 1 then out[k] = total / n
      elsif k > n - 1 then out[k] = (out[k - 1] * (n - 1) + tr[k]) / n
      end
    end
  end

  CACHE[key] = out
  out
end

class Ctx
  attr_accessor :i

  def initialize
    @i = 0
    @pos = 0.0
    @avg = 0.0
    @cash = CFG['initialCash'].to_f
    @pending = []
  end

  def bar;       BARS[@i];         end
  def index;     @i;               end
  def length;    N;                end
  def symbol;    CFG['symbol'];    end
  def timeframe; CFG['timeframe']; end

  def position;   @pos;                                    end
  def avg_price;  @pos.zero? ? 0.0 : @avg;                 end
  def long?;      @pos > 0;                                end
  def short?;     @pos < 0;                                end
  def flat?;      @pos.zero?;                              end
  def is_long;    @pos > 0;                                end
  def is_short;   @pos < 0;                                end
  def is_flat;    @pos.zero?;                              end
  def cash;       @cash;                                   end
  def equity;     @cash + @pos * CLOSES[@i];               end
  def unrealized; @pos.zero? ? 0.0 : @pos * (CLOSES[@i] - @avg); end

  def closes;  CLOSES[0..@i];  end
  def opens;   OPENS[0..@i];   end
  def highs;   HIGHS[0..@i];   end
  def lows;    LOWS[0..@i];    end
  def volumes; VOLUMES[0..@i]; end

  def at(arr, back = 0)
    k = @i - back
    k >= 0 && k < N ? arr[k] : nil
  end

  def close_(back = 0); at(CLOSES, back); end
  def open_(back = 0);  at(OPENS, back);  end
  def high_(back = 0);  at(HIGHS, back);  end
  def low_(back = 0);   at(LOWS, back);   end

  def emit(side, qty, reason = '')
    q = qty.to_f.abs
    return if q.zero? || !q.finite?

    o = { 'i' => @i, 'side' => side, 'qty' => q, 'reason' => reason }
    ORDERS << o
    @pending << o
  end
  private :emit

  def buy(qty = nil, reason = '');  emit('buy',  qty.nil? ? CFG['defaultQty'] : qty, reason); end
  def sell(qty = nil, reason = ''); emit('sell', qty.nil? ? CFG['defaultQty'] : qty, reason); end

  def close(reason = 'close')
    if @pos > 0 then emit('sell', @pos, reason)
    elsif @pos < 0 then emit('buy', -@pos, reason)
    end
  end

  def target(qty, reason = '')
    d = qty - @pos
    if d > 0 then emit('buy', d, reason)
    elsif d < 0 then emit('sell', -d, reason)
    end
  end

  def pending; @pending; end

  def apply_fill(side, qty, price)
    q = side == 'buy' ? qty : -qty
    d = side == 'buy' ? 1 : -1
    px = price * (1 + (d * CFG['slippageBps']) / 10_000.0)
    @cash -= q * px + CFG['commission']
    if @pos.zero?
      @avg = px
      @pos = q
    elsif (q > 0) == (@pos > 0)
      @avg = (@avg * @pos.abs + px * q.abs) / (@pos.abs + q.abs)
      @pos += q
    else
      before = @pos
      @pos += q
      @avg = px if !@pos.zero? && ((@pos > 0) != (before > 0))
    end
  end

  def clear_pending; @pending = []; end

  # back: 1 gives the previous bar's value
  def sma(n, back = 0, source = 'close');   at(series('sma', n, source), back);   end
  def ema(n, back = 0, source = 'close');   at(series('ema', n, source), back);   end
  def rsi(n = 14, back = 0);                at(series('rsi', n, 'close'), back);  end
  def atr(n = 14, back = 0);                at(series('atr', n, 'close'), back);  end
  def stdev(n, back = 0, source = 'close'); at(series('stdev', n, source), back); end
  def highest(n, back = 0);                 at(series('highest', n, 'high'), back); end
  def lowest(n, back = 0);                  at(series('lowest', n, 'low'), back);   end
  def roc(n, back = 0, source = 'close');   at(series('roc', n, source), back);   end

  # ---- price levels: "has price been here before, and is it here again?"
  def tol_or_default(tol); tol.nil? ? TOL_DEFAULT : tol.to_f; end
  private :tol_or_default

  # Last n values of a series, oldest first. Never includes a future bar.
  def window(n, source = 'close')
    s = SOURCES[source] || CLOSES
    k = @i + 1
    s[[0, k - n].max...k]
  end

  # Did that bar's range reach this price? back=1 asks about yesterday.
  def touched(level, tol = nil, back = 0)
    return false if level.nil?

    lv = level.to_f
    return false unless lv.finite?

    k = @i - back
    return false if k.negative? || k >= N

    t = tol_or_default(tol) * lv.abs
    LOWS[k] <= lv + t && HIGHS[k] >= lv - t
  end

  # How many EARLIER bars reached this price. Excludes the current bar, so it answers
  # "how established is this level" before you act on today.
  def count_touches(level, lookback = 250, tol = nil)
    return 0 if level.nil?

    lv = level.to_f
    return 0 unless lv.finite?

    t = tol_or_default(tol) * lv.abs
    c = 0
    ([0, @i - lookback].max...@i).each do |k|
      c += 1 if LOWS[k] <= lv + t && HIGHS[k] >= lv - t
    end
    c
  end

  # Confirmed swing highs/lows within lookback, oldest first.
  def pivots(left = 2, right = 2, lookback = 250, kind = 'both')
    out = []
    lo = @i - lookback
    pivot_marks(left, right).each do |(j, price, k)|
      break if j + right > @i # index-ordered, so nothing later is confirmed either
      next if j < lo
      next if kind != 'both' && k != kind

      out << { 'price' => price, 'i' => j, 'kind' => k, 'bars_ago' => @i - j }
    end
    out
  end

  # Swing points collapsed into price levels: pivots within tol of each other are the same
  # level, and `touches` counts how many times price turned there. Sorted by touches desc,
  # so levels[0] is the most respected level in view.
  def levels(tol = nil, left = 2, right = 2, lookback = 250, min_touches = 1)
    t = tol_or_default(tol)
    clusters = []
    pivots(left, right, lookback, 'both').each do |p|
      hit = clusters.find { |c| (p['price'] - c['price']).abs <= t * c['price'].abs }
      if hit.nil?
        clusters << {
          'price' => p['price'], 'sum' => p['price'], 'touches' => 1,
          'highs' => p['kind'] == 'high' ? 1 : 0, 'lows' => p['kind'] == 'low' ? 1 : 0,
          'last_i' => p['i']
        }
      else
        hit['sum'] += p['price']
        hit['touches'] += 1
        hit['price'] = hit['sum'] / hit['touches']
        if p['kind'] == 'high' then hit['highs'] += 1 else hit['lows'] += 1 end
        hit['last_i'] = p['i'] if p['i'] > hit['last_i']
      end
    end

    out = clusters.reject { |c| c['touches'] < min_touches }.map do |c|
      kind = if c['highs'] > c['lows'] then 'high'
             elsif c['lows'] > c['highs'] then 'low'
             else 'both'
             end
      { 'price' => c['price'], 'kind' => kind, 'touches' => c['touches'],
        'last_i' => c['last_i'], 'bars_ago' => @i - c['last_i'] }
    end
    # The third sort key only exists to make ties total -- sort_by is not stable in Ruby,
    # and two runners disagreeing on equal-ranked levels would silently diverge trades.
    out.sort_by { |x| [-x['touches'], x['price'], x['last_i']] }
  end

  # The level today's bar is revisiting, or nil. Most-touched level wins.
  def retest(tol = nil, left = 2, right = 2, lookback = 250, min_touches = 1)
    levels(tol, left, right, lookback, min_touches).each do |lv|
      return lv if lv['last_i'] < @i && touched(lv['price'], tol)
    end
    nil
  end

  def param(name, default = nil); PARAMS.fetch(name.to_s, default); end

  def log(*args)
    LOGS << { 'i' => @i, 't' => BARS[@i]['t'], 'msg' => args.map(&:to_s).join(' ') }
  end

  def plot(name, value)
    PLOTS[name] ||= Array.new(N)
    v = value.to_f
    PLOTS[name][@i] = v.finite? ? v : nil
  rescue StandardError
    PLOTS[name][@i] = nil
  end
end

def fail_out(res_path, message, tb = nil, bar_index = nil)
  err = { 'message' => message }
  err['traceback'] = tb if tb
  if bar_index
    err['bar'] = bar_index
    err['time'] = BARS[bar_index]['t']
  end
  File.write(res_path, JSON.generate({ 'ok' => false, 'error' => err, 'logs' => LOGS, 'plots' => PLOTS }))
  exit 0
end

ctx = Ctx.new

begin
  eval(CODE, TOPLEVEL_BINDING, 'strategy.rb')
rescue Exception => e
  fail_out(res_path, "Syntax/load error: #{e.message}", e.backtrace&.first(6)&.join("\n"))
end

unless respond_to?(:on_bar, true)
  fail_out(res_path, 'No on_bar method found. Define:  def on_bar(bar, ctx)')
end

begin
  send(:initialize_strategy, ctx) if respond_to?(:initialize_strategy, true)
rescue Exception => e
  fail_out(res_path, "Error in initialize_strategy(): #{e.message}", e.backtrace&.first(6)&.join("\n"))
end

fill_at_close = CFG['fillMode'] == 'close'

(0...N).each do |idx|
  ctx.i = idx
  # Fills from the previous bar's signals land at this bar's open, before you see the bar.
  if !fill_at_close && !ctx.pending.empty?
    ctx.pending.each { |o| ctx.apply_fill(o['side'], o['qty'], OPENS[idx]) }
    ctx.clear_pending
  end
  begin
    send(:on_bar, BARS[idx], ctx)
  rescue Exception => e
    fail_out(res_path, "Error in on_bar() at bar #{idx}: #{e.message}", e.backtrace&.first(6)&.join("\n"), idx)
  end
  if fill_at_close && !ctx.pending.empty?
    ctx.pending.each { |o| ctx.apply_fill(o['side'], o['qty'], CLOSES[idx]) }
    ctx.clear_pending
  end
end

File.write(res_path, JSON.generate({ 'ok' => true, 'orders' => ORDERS, 'logs' => LOGS, 'plots' => PLOTS }))
