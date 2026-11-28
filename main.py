"""Pump.fun Sharpe Sprint bot — clean, conservative paper trading.

Strategy, in one paragraph: trade only the most established coins.
A coin is bought only after its curve holds at least 50 SOL of real
quote reserves — that is, after the crowd has already put serious
money in and the curve is deep, slow-moving and far from the
single-slot casino at launch. One small fixed stake per coin, then a
hard take-profit, a hard stop-loss and a hold timeout: winners are
banked, losers are cut, and no position is left to bleed. That shape
is what the hourly Sharpe ratio rewards — a few steady, controlled
round trips instead of hundreds of wild bets.

Protocol: agent-fun/replay/v2. The harness sends hello, then one batch
per slot (events, marks, fills, account) on stdin; this bot answers
each batch with exactly one reply line carrying its orders, echoing
the batch seq. All decisions are pure functions of the hello seed and
the batches seen so far — no clock, no randomness, no network — so two
runs on the same data produce the same orders.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))

import makefun_bot  # noqa: E402  (after the sys.path line: -P leaves the script directory off sys.path)

SOL = makefun_bot.LAMPORTS_PER_SOL

# --- sizing ---------------------------------------------------------------
STAKE_LAMPORTS = SOL // 20            # 0.05 SOL per coin at most
MIN_BUY_LAMPORTS = SOL // 100         # 0.01 SOL: the guardrail's round-trip floor
MAX_SLIPPAGE_BPS = 1000               # 10%: wide enough to fill, tight enough to matter

# --- entry filter: only deep, established curves --------------------------
MIN_REAL_QUOTE_SOL = 50.0             # real quote reserves on the curve
MAX_AGE_SLOTS = 200000                # coins stay eligible for a long time

# --- exits: bank winners, cut losers, never overstay ----------------------
TAKE_PROFIT = 0.30                    # sell if price rises 30% above the buy
STOP_LOSS = 0.10                      # sell if price falls 10% below the buy
TRAIL = 0.08                          # sell if price falls 8% below its peak since buying
TRAIL_ARM = 0.10                      # trailing stop arms only once up 10%
HOLD_TIMEOUT_SLOTS = 20000            # sell whatever is left after this long

#: Coins already bought once this run (a coin is entered at most once).
decided = set()
#: First slot each mint was seen, for coins the shim met without a CreateEvent.
first_seen = {}
#: Open-trade bookkeeping, by mint: buy price, peak price since buying, buy slot.
open_trades = {}


def price_of(curve):
    """SOL per token from the curve's virtual reserves (float, deterministic)."""
    return curve.virtual_quote_reserves / curve.virtual_token_reserves


def on_batch(state, batch):
    slot = batch["slot"]
    caps = state.hello["caps"]
    tx = state.tx_fee_lamports()
    free = state.free_cash_lamports()
    orders = []

    # Remember when each curve was first seen (age filter for late discoveries).
    for mint in state.curves:
        if mint not in first_seen:
            first_seen[mint] = slot

    # Drop trade records for positions the harness already closed (a curve
    # completing, or the end-of-window flatten): nothing left to exit.
    pending_buys = {
        p.order["mint"] for p in state.pending.values() if p.order["side"] == "buy"
    }
    for mint in list(open_trades):
        if mint not in state.positions and mint not in pending_buys:
            del open_trades[mint]

    # --- exits first: free the position slots before deciding new buys ---
    # A sell already in flight (pending) is not sent twice: the trade record
    # stays until the position itself disappears from the account.
    pending_sells = {
        p.order["mint"] for p in state.pending.values() if p.order["side"] == "sell"
    }
    for mint in list(state.positions):
        trade = open_trades.get(mint)
        curve = state.curves.get(mint)
        if trade is None or curve is None or curve.complete:
            continue
        if mint in pending_sells:
            continue
        price = price_of(curve)
        if price > trade["peak"]:
            trade["peak"] = price
        ret = price / trade["buy_price"] - 1.0
        age = slot - trade["buy_slot"]
        armed = trade["peak"] >= trade["buy_price"] * (1.0 + TRAIL_ARM)
        trailed = armed and price <= trade["peak"] * (1.0 - TRAIL)
        if ret >= TAKE_PROFIT or ret <= -STOP_LOSS or trailed or age >= HOLD_TIMEOUT_SLOTS:
            holding = state.positions[mint]
            orders.append(
                {
                    "side": "sell",
                    "mint": mint,
                    "token_amount": holding.token_amount,
                    "max_slippage_bps": MAX_SLIPPAGE_BPS,
                }
            )
            pending_sells.add(mint)

    # --- entries: one small buy per qualifying coin, in event order -------
    slots_free = caps["max_open_positions"] - state.committed_position_count()
    for event in batch["events"]:
        if len(orders) >= caps["max_orders_per_batch"] or slots_free <= 0:
            break
        mint = event["mint"]
        if mint in decided or mint in state.positions:
            continue
        curve = state.curves.get(mint)
        if curve is None or curve.complete:
            continue
        created = curve.created_slot if curve.created_slot is not None else first_seen.get(mint, slot)
        if slot - created > MAX_AGE_SLOTS:
            continue
        if curve.real_quote_reserves < MIN_REAL_QUOTE_SOL * SOL:
            continue
        cap = state.max_buy_lamports(mint)
        amount = min(STAKE_LAMPORTS, cap)
        if amount < MIN_BUY_LAMPORTS:
            continue
        if free < amount + tx:
            continue
        orders.append(
            {
                "side": "buy",
                "mint": mint,
                "quote_lamports": amount,
                "max_slippage_bps": MAX_SLIPPAGE_BPS,
            }
        )
        decided.add(mint)
        open_trades[mint] = {
            "buy_price": price_of(curve),
            "peak": price_of(curve),
            "buy_slot": slot,
        }
        free -= amount + tx
        slots_free -= 1

    return orders


if __name__ == "__main__":
    makefun_bot.run(on_batch)
