// Cleanest Paper Bot — Pump.fun Sharpe Sprint (dip-bounce variant).
//
// Strategy: buy the dip on coins with proven organic demand, exit fast.
// Most new pump.fun coins spike within their first trades and then bleed: chasing
// the spike loses to the 2-slot fill latency (the fill lands ~12% above the decision
// price on a rising coin). So this bot never chases. It waits for a coin that has
// already shown real demand — at least 30 trades from at least 15 distinct buyers —
// and only buys after the price has pulled back at least 20% from its peak while
// still holding above its creation price: a bounce candidate, bought cheap, with the
// crowd already there. Exits are quick: +15% take-profit, -6% stop-loss, and a time
// stop that closes any position still open 100 trades after entry, so no position
// bleeds to zero while the bot waits. Stakes are small (0.05 SOL target, never under
// the 0.01 SOL round-trip floor), at most 5 open, one buy per mint ever.
//
// Why this should Sharpe well: entries are selective and cheap, exits are tight, so
// the equity curve is many small, short, independent bets with tiny drawdowns; the
// 2-slot latency hurts far less on a falling-or-flat entry than on a spike.
//
// Deterministic: no clock, no environment, no Math.random — every decision comes from
// the hello message and the batch the harness just delivered (its slot, its orders,
// its fills). Two runs on the same replay therefore produce byte-identical replies.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type BotState,
  type BuyInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// --- tuning (calibrated on the kit's dev window; dip entries were the least-bad
// family there: ~30% win rate at TP +15% / SL -6% before fees, ~380 trigger coins) ---
const MIN_TRADES = 30; // need a real trading history before trusting the coin
const MIN_BUYERS = 15; // distinct wallets that bought: organic demand, not one wallet
const DIP_MULT = 0.8; // buy only 20%+ below the coin's peak price
const STAKE_LAMPORTS = (LAMPORTS_PER_SOL * 5n) / 100n; // 0.05 SOL target stake
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL: the guardrail round-trip floor
const TAKE_PROFIT_MULT = 1.15;
const STOP_LOSS_MULT = 0.94;
const MAX_HOLD_TRADES = 100; // time stop: close 100 trades after entry if still open
const BUY_SLIPPAGE_BPS = 1000;
const SELL_SLIPPAGE_BPS = 1000;

/** Price of a curve in lamports of SOL per token, from its virtual reserves. */
function priceOf(state: BotState, mint: string): number | null {
  const curve = state.curves.get(mint);
  if (curve === undefined) return null;
  if (curve.virtual_token_reserves <= 0n || curve.virtual_quote_reserves <= 0n) return null;
  return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
}

interface Coin {
  /** Price at creation (virtual reserves on the CreateEvent batch). */
  firstPrice: number;
  /** Highest mark price seen on this curve. */
  peakPrice: number;
  /** Trades seen on this curve so far. */
  trades: number;
  /** Distinct wallets that bought this coin (organic-demand filter). */
  buyers: Set<string>;
  /** Decided already: bought, skipped, or dropped — never reconsidered. */
  decided: boolean;
  /** Price we bought at (decision-time mark), once a buy fills. */
  entryPrice: number | null;
  /** Trade count when the buy was decided (for the time stop). */
  entryTrades: number;
}

const coins = new Map<string, Coin>();

function coinFor(state: BotState, mint: string): Coin | null {
  let coin = coins.get(mint);
  if (coin !== undefined) return coin;
  const price = priceOf(state, mint);
  if (price === null) return null;
  coin = {
    firstPrice: price,
    peakPrice: price,
    trades: 0,
    buyers: new Set<string>(),
    decided: false,
    entryPrice: null,
    entryTrades: 0,
  };
  coins.set(mint, coin);
  return coin;
}

await runBot({
  onBatch(state, batch) {
    const { caps } = state.hello;
    const txFee = state.txFeeLamports();
    const orders: Array<BuyInput | SellInput> = [];

    // True entry prices come from fills, not decision-time marks: a buy decided on
    // this slot fills two slots later at the fill price, so re-base the position on
    // quote_lamports / token_amount of the filled buy (fees included in the quote).
    for (const fill of batch.fills) {
      if (fill.side !== 'buy' || fill.status !== 'filled') continue;
      const coin = coins.get(fill.mint);
      if (coin === undefined) continue;
      const quote = Number(fill.quote_lamports);
      const tokens = Number(fill.token_amount);
      if (quote > 0 && tokens > 0) coin.entryPrice = quote / tokens;
    }

    // Refresh per-coin history from this batch's events: trade counts, distinct
    // buyers, peak prices, and creation prices. A batch is one slot of events.
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        const coin = coinFor(state, event.mint);
        if (coin !== null) {
          coin.firstPrice = priceOf(state, event.mint) ?? coin.firstPrice;
          coin.peakPrice = coin.firstPrice;
        }
      } else if (event.event === 'TradeEvent') {
        const coin = coins.get(event.mint);
        if (coin === undefined) continue;
        coin.trades += 1;
        if (event.is_buy) coin.buyers.add(event.user);
        const price = priceOf(state, event.mint);
        if (price !== null && price > coin.peakPrice) coin.peakPrice = price;
      } else if (event.event === 'CompleteEvent') {
        const coin = coins.get(event.mint);
        if (coin !== undefined) coin.decided = true;
      }
    }

    // --- exits first: take-profit, stop-loss, and the time stop ---
    for (const [mint, holding] of state.positions) {
      const coin = coins.get(mint);
      const price = priceOf(state, mint);
      if (coin === null || price === null) continue;
      if (coin.entryPrice === null) coin.entryPrice = price;
      const up = price / coin.entryPrice;
      const agedOut = coin.trades - coin.entryTrades >= MAX_HOLD_TRADES;
      if (up >= TAKE_PROFIT_MULT || up <= STOP_LOSS_MULT || agedOut) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
      }
    }

    // --- entries: dip buys on proven coins, in batch event order, while slots last ---
    // A sell queued this batch still occupies its slot until its fill lands two
    // slots later, so slots are counted from committed positions as-is; no credit
    // is taken for sells in flight.
    let free = state.freeCashLamports();
    let openSlots = caps.max_open_positions - state.committedPositionCount();
    for (const event of batch.events) {
      if (orders.length >= caps.max_orders_per_batch || openSlots <= 0) break;
      const mint = event.mint;
      const coin = coins.get(mint);
      if (coin === undefined || coin.decided) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        coin.decided = true;
        continue;
      }
      const price = priceOf(state, mint);
      if (price === null) continue;
      // The dip rule: a real history, a real crowd, a real pullback, still alive.
      if (coin.trades < MIN_TRADES) continue;
      if (coin.buyers.size < MIN_BUYERS) continue;
      if (price > coin.peakPrice * DIP_MULT) continue;
      if (price < coin.firstPrice) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + txFee) continue;
      coin.decided = true;
      coin.entryPrice = price;
      coin.entryTrades = coin.trades;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
      free -= amount + txFee;
      openSlots -= 1;
    }
    return orders;
  },
});
