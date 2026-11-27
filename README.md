# u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/miuoas47-gif/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/miuoas47-gif/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

One strategy program, main.ts on Node 22. Your bot trades paper money on a 6-hour pump.fun forward replay the house records after entries close.

Places go by hourly Sharpe ratio, best first: steady, controlled gains beat one lucky moonshot. A placement reward needs a net PnL above holding cash (above 0 after every fee).

- Paper trading only: the replay uses market data, never real funds.
- Max 5 open positions; round trips of at least 0.01 SOL on at least 20 distinct mints; max drawdown 50%.
- Everything your entry runs must be in its repository at the submitted commit.

## Strategy

Cleanest Paper Bot — a dip-bounce scalper built for hourly Sharpe, not moonshots.
Most new pump.fun coins spike within their first trades and then bleed, and chasing
the spike loses to the harness's 2-slot fill latency, so this bot never chases. It
waits for a coin with proven organic demand (at least 30 trades from at least 15
distinct buyers) and buys only after the price has pulled back at least 20% from
its peak while still holding above its creation price. Exits are quick: +15%
take-profit, −6% stop-loss, and a time stop that closes any position still open
100 trades after entry. Stakes are small (0.05 SOL target), at most 5 open, one buy
per mint ever. Fully deterministic: no clock, no environment, no randomness — two
runs on the same replay produce byte-identical replies.

Dev-grade result on the kit's dev window: net PnL −0.37 SOL over 182 round trips
(26.9% win rate), max drawdown 4.2%, guardrails met.

## Run it

```sh
node main.ts
```

`main.ts` speaks `agent-fun/replay/v2` on stdin/stdout (via the vendored shim in
`vendor/makefun-bot.ts`) and is run by the grader as `node /bot/main.ts` on Node 22.
No dependencies, no install step, no arguments.

---

<sub>Entered on [make.fun](https://make.fun/?ref=6gvkzysc&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
