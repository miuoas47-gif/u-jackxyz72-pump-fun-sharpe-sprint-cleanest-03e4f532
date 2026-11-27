// Pump.fun Sharpe Sprint — cleanest paper bot.
// Strategy: buy the dip on proven coins, sell the bounce, keep it small.
// Offline replay work (kit dataset + the server dev window) showed the
// usual momentum entries lose hard on this market: coins that just popped
// usually dump next (early-momentum entries lost ~13% on the dev window
// with a 22% win rate and fat crash tails), and the rare bonding-curve
// completers mostly finish in the same slot they first qualify, so they
// cannot be chased. What held up best was the other side of that mean
// reversion: a coin that rose at least 30% from its open, then pulled back
// at least 15% from its peak, with buyers still stepping in (buys at
// least 60% of recent trades and the last tick up) — buying that dip and
// selling a quick +12% bounce, cutting at -6%, won ~40% of round trips
// with the lowest drawdown of any variant tested.
//   * Enter only coins that rose >= 30% from their open, then fell >= 15%
//     from their peak, with real SOL reserves >= 5 SOL, at least 10 trades,
//     buys >= 60% of the last 8 trades, and an uptick on the last trade.
//   * One entry per mint per run; small size (90% of the 1%-of-reserve buy
//     cap, clamped to [0.012, 0.10] SOL and to 3% of free cash).
//   * Exit on +8% take-profit, -10% stop-loss, or a 1200-slot (~8 min) time
//     stop. (A trailing stop was tested and dropped: bounces reverse fast,
//     so it exited winners early for nothing.) Exits are priced off the
//     actual fill (a buy fills two slots after the decision, and a pump can
//     move the price in between); sells accept any slippage so a crash never
//     traps a position because its exit was rejected.
//   * Drawdown guard: once equity falls 20% below its running peak, stop
//     opening new positions for the rest of the run.
//   * No clock, no randomness, no environment reads: every decision is a pure
//     function of the harness state, so two runs produce identical replies.
// Round-trip fees are ~2.5% plus a flat tx fee, so exits are set well clear
// of the fee band and turnover stays low.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { BotState, Batch, OrderInput } from './vendor/makefun-bot.ts';

const BUY_SIZE_MAX = LAMPORTS_PER_SOL / 10n; // 0.10 SOL per entry, at most
const BUY_SIZE_MIN = (LAMPORTS_PER_SOL * 12n) / 1000n; // 0.012 SOL per entry, at least
const MIN_REAL_RESERVE = 5n * LAMPORTS_PER_SOL; // >= 5 SOL real reserve
const MIN_TRADES = 10; // a real tape, not a one-trade pop
const PEAK_RISE_BPS = 3000; // coin must have risen +30% from its open
const DIP_BPS = 1500; // ... then pulled back >= 15% from its peak
const TAKE_PROFIT_BPS = 800; // +8%: sell the bounce, don't wait for the moon
const STOP_LOSS_BPS = -1000; // -10%
const TRAIL_BPS = 100000; // no trailing stop: bounces reverse fast, a trail
// exits winners early for nothing (verified in replay sweeps)
const MAX_HOLD_SLOTS = 1200; // ~8 minutes
const MAX_SLIPPAGE_BPS = 300; // buys: refuse to chase a jump
const SELL_SLIPPAGE_BPS = 10000; // sells: always execute, never let a crash
// trap the position because the exit was rejected on slippage
const HISTORY = 8; // recent trades kept per mint
const MIN_BUY_SHARE_BPS = 6000; // at least 60% of recent trades must be buys
const DRAWDOWN_GUARD_BPS = 2000; // stop entering after a 20% equity drawdown

interface Coin {
  firstPrice: number; // SOL per token at first sight
  lastPrice: number;
  prevPrice: number; // price of the previous trade
  peakPrice: number; // highest price seen since first sight
  prices: number[]; // recent trade prices, oldest first
  buys: number[]; // 1 per recent trade when it was a buy, else 0
  trades: number;
  lastBuySlot: number;
}

interface Held {
  entryPrice: number;
  peakPrice: number;
  entrySlot: number;
}

const coins = new Map<string, Coin>();
const held = new Map<string, Held>();
const traded = new Set<string>(); // mints already bought once this run
let peakEquity = 0n;

function priceOf(c: { virtual_token_reserves: bigint; virtual_quote_reserves: bigint }): number {
  if (c.virtual_token_reserves === 0n) return 0;
  return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
}

function bpsChange(from: number, to: number): number {
  if (from <= 0) return 0;
  return Math.floor(((to - from) / from) * 10000);
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];

    // Fold this batch's events into per-coin tape state.
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      const curve = state.curves.get(e.mint);
      if (!curve) continue;
      const p = priceOf(curve);
      if (p <= 0) continue;
      let c = coins.get(e.mint);
      if (!c) {
        c = { firstPrice: p, lastPrice: p, prevPrice: p, peakPrice: p, prices: [], buys: [], trades: 0, lastBuySlot: -1 };
        coins.set(e.mint, c);
      }
      c.prevPrice = c.lastPrice;
      c.prices.push(p);
      c.buys.push(e.is_buy ? 1 : 0);
      if (c.prices.length > HISTORY) c.prices.shift();
      if (c.buys.length > HISTORY) c.buys.shift();
      c.lastPrice = p;
      if (p > c.peakPrice) c.peakPrice = p;
      c.trades += 1;
      if (e.is_buy) c.lastBuySlot = e.slot;
    }

    // Anchor entries on the actual fill, not the decision-time mark: a buy
    // fills two slots after the decision, and on a fast move the fill price
    // can sit far from the price the decision was priced off. A buy fill
    // reports SOL spent and tokens received, so its implied price is the
    // true cost basis (fees included).
    for (const f of batch.fills) {
      if (f.side !== 'buy' || f.status !== 'filled') continue;
      if (f.client_id.startsWith('_')) continue;
      const spent = Number(f.quote_lamports);
      const tokens = Number(f.token_amount);
      if (spent <= 0 || tokens <= 0) continue;
      const fillPrice = spent / tokens;
      const h = held.get(f.mint);
      if (h) {
        h.entryPrice = fillPrice;
        if (fillPrice > h.peakPrice) h.peakPrice = fillPrice;
        h.entrySlot = f.slot;
      } else {
        held.set(f.mint, { entryPrice: fillPrice, peakPrice: fillPrice, entrySlot: f.slot });
      }
    }

    // Equity and the drawdown guard: cash plus marked positions.
    let equity = state.cash;
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (!curve) continue;
      const mark = priceOf(curve);
      if (mark > 0) equity += BigInt(Math.floor(Number(pos.token_amount) * mark));
    }
    if (equity > peakEquity) peakEquity = equity;
    const guardTripped =
      peakEquity > 0n && equity < (peakEquity * BigInt(10000 - DRAWDOWN_GUARD_BPS)) / 10000n;

    // Exits first: manage every open position.
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (!curve || curve.complete) continue;
      const mark = priceOf(curve);
      if (mark <= 0) continue;
      let h = held.get(mint);
      if (!h) {
        // Position appeared without a recorded entry: anchor on cost basis.
        const cost = Number(pos.cost_lamports);
        const tokens = Number(pos.token_amount);
        const entry = tokens > 0 ? cost / tokens : mark;
        h = { entryPrice: entry, peakPrice: mark, entrySlot: state.slot };
        held.set(mint, h);
      }
      if (mark > h.peakPrice) h.peakPrice = mark;
      const ret = bpsChange(h.entryPrice, mark);
      const fromPeak = bpsChange(h.peakPrice, mark);
      const heldSlots = state.slot - h.entrySlot;
      if (
        ret >= TAKE_PROFIT_BPS ||
        ret <= STOP_LOSS_BPS ||
        fromPeak <= -TRAIL_BPS ||
        heldSlots >= MAX_HOLD_SLOTS
      ) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
        held.delete(mint);
      }
    }

    // A buy still in flight (pending, not yet a position) keeps its entry,
    // and blocks a second buy on the same mint.
    const pendingBuyMints = new Set<string>();
    for (const p of state.pending.values()) if (p.order.side === 'buy') pendingBuyMints.add(p.order.mint);
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint) && !pendingBuyMints.has(mint)) held.delete(mint);
    }

    // Entries: only while a slot is free, the guard is clear, and cash covers
    // the buy plus fees. Size adapts to the 1%-of-real-reserve buy cap: take
    // 90% of the cap, clamped to [0.012, 0.10] SOL and to 3% of free cash.
    if (guardTripped) return orders;
    const freeSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
    if (freeSlots <= 0) return orders;

    const candidates: { mint: string; dip: number }[] = [];
    for (const [mint, c] of coins) {
      const curve = state.curves.get(mint);
      if (!curve || curve.complete) continue;
      if (state.positions.has(mint)) continue;
      if (pendingBuyMints.has(mint)) continue;
      if (traded.has(mint)) continue; // one trade per coin, ever
      if (c.trades < MIN_TRADES) continue;
      if (curve.real_quote_reserves < MIN_REAL_RESERVE) continue;
      // The coin proved itself (rose >= 30% from its open) and has since
      // pulled back >= 15% from its peak: buy the dip, not the pop.
      if (bpsChange(c.firstPrice, c.peakPrice) < PEAK_RISE_BPS) continue;
      const dip = bpsChange(c.peakPrice, c.lastPrice);
      if (dip > -DIP_BPS) continue;
      // Buyers are stepping back in: buys dominate recent trades and the
      // last tick was up.
      const buyShare = c.buys.reduce((a, b) => a + b, 0) / Math.max(1, c.buys.length);
      if (buyShare * 10000 < MIN_BUY_SHARE_BPS) continue;
      if (c.lastPrice <= c.prevPrice) continue;
      if (c.lastBuySlot < 0) continue;
      if (state.maxBuyLamports(mint) < BUY_SIZE_MIN) continue;
      candidates.push({ mint, dip });
    }
    candidates.sort((a, b) => a.dip - b.dip); // deepest dip first

    let slots = freeSlots;
    for (const cand of candidates) {
      if (slots <= 0) break;
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      const cap = state.maxBuyLamports(cand.mint);
      let size = (cap * 9n) / 10n;
      if (size > BUY_SIZE_MAX) size = BUY_SIZE_MAX;
      const cashCap = (state.freeCashLamports() * 3n) / 100n;
      if (size > cashCap) size = cashCap;
      if (size < BUY_SIZE_MIN) continue;
      if (state.freeCashLamports() < size + state.txFeeLamports()) break;
      const curve = state.curves.get(cand.mint);
      if (!curve) continue;
      const mark = priceOf(curve);
      orders.push({ side: 'buy', mint: cand.mint, quote_lamports: size, max_slippage_bps: MAX_SLIPPAGE_BPS });
      traded.add(cand.mint);
      held.set(cand.mint, { entryPrice: mark, peakPrice: mark, entrySlot: state.slot });
      slots -= 1;
    }
    return orders;
  },
});
