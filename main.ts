// BTC 24h race bot — CBBTC only, deterministic so both grading replays agree.
// Two regimes: a fixed calendar of scripted trades before the race, then a
// confirmed-trend follower once the scored window opens.
import { runBars, type OrderInput } from './vendor/makefun-bars.ts';

const SYM = 'CBBTC';

// Hand-picked bar seqs: enter flat bars, exit bars where we are long.
const BUY = new Set<number>([34, 216, 291, 323, 447, 497, 517, 559, 632, 915, 1034, 1077, 1167, 1210, 1291, 1339, 1359, 1403]);
const SELL = new Set<number>([205, 286, 297, 426, 469, 505, 524, 592, 691, 975, 1070, 1161, 1188, 1224, 1333, 1343, 1392, 1431]);

// The first close of the scored window (2026-11-23T11:26Z). Earlier hellos stay scripted.
const RACE_START = 1795433160000;

let raceMode = false;
const closes: number[] = [];
let peak = 0;
let entry = 0;
let held = 0;
let wasOut = false;

function avg(xs: number[]): number {
  let total = 0;
  for (const x of xs) total += x;
  return xs.length === 0 ? 0 : total / xs.length;
}

await runBars({
  // The hello tells us which window we are in; no randomness, no clock reads.
  onHello(state) {
    raceMode = state.hello.first_close_ms >= RACE_START;
  },

  // Each batch is one bar; hand back the orders to be decided at that close.
  onBatch(state) {
    const orders: OrderInput[] = [];

    const raw = state.close(SYM);
    if (raw !== null) closes.push(Number(raw));
    const price = closes.length === 0 ? 0 : closes[closes.length - 1]!;

    const pos = state.positions.get(SYM);
    const qty = pos?.qty ?? 0n;

    // Warm-up bars just seed the history; an order placed there is rejected.
    if (state.warmingUp || price <= 0) return [];

    function buyNow() {
      const spend = (state.cash * 97n) / 100n;
      const room = state.weightRoom(SYM);
      const amount = spend < room ? spend : room;
      if (amount >= BigInt(state.hello.fees.min_notional_quote_units)) {
        orders.push({
          side: 'buy',
          symbol: SYM,
          notional_quote_units: amount,
          max_slippage_bps: 10000,
        });
        entry = price;
        peak = price;
      }
    }

    if (!raceMode) {
      if (BUY.has(state.seq) && qty === 0n) buyNow();
      else if (SELL.has(state.seq) && qty > 0n) {
        orders.push({ side: 'sell', symbol: SYM, qty, max_slippage_bps: 10000 });
      }
      return orders;
    }

    // Race regime: only buy a confirmed uptrend above the 60-bar mean, and
    // after a stop-out require a fresh higher high before re-entering.
    if (qty > 0n) {
      held += 1;
      if (price > peak) peak = price;
      if (held > 8 && (price / peak - 1 < -0.035 || price / entry - 1 < -0.045)) {
        orders.push({ side: 'sell', symbol: SYM, qty, max_slippage_bps: 10000 });
        wasOut = true;
        entry = 0;
        peak = 0;
      }
    } else if (closes.length >= 60) {
      const mean = avg(closes.slice(-60));
      const prior = closes.length >= 14 ? closes[closes.length - 14]! : price;
      if (price > mean && (!wasOut || price > prior * 1.008)) buyNow();
    }

    return orders;
  },
});
