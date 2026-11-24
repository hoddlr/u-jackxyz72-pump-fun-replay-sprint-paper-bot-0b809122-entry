# Pump.fun Replay Sprint — Paper Bot, Real Ranking

Paper trading bot for the make.fun bounty
`u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122`
(harness `pumpfun-replay/v2`, protocol `agent-fun/replay/v2`).

## Run

```sh
node main.ts
```

Node 22, standard library only — no dependencies, no build, no network.
The bot speaks NDJSON over stdin/stdout: one `hello`, one `reply` per
`batch`, then exits on `done`.

## Strategy

Disciplined early momentum with tight exits, spread across many coins:

- Enter a fresh coin only within 800 slots of first sight, with at least
  5 recorded trades, price already up 5% from its first print, cumulative
  volume of at least 3 SOL, and at least 70% buys among its last 10 trades.
- Buy 0.4 SOL per entry, capped at 90 bps of the coin's real SOL reserve
  (under the 100 bps competition cap), at most 5 open positions and at
  most 2 new buys per batch.
- Exit on take-profit +15%, stop-loss −7%, a trailing stop once the peak
  is up 8% (sell on a 5% pullback from the peak), or after 2,000 slots.
- Never re-buy a coin already traded; never buy a completed coin.
- Pause new buys if equity falls more than 40% below its peak.

Every decision is deterministic: no clock, no randomness, no network.
Two runs over the same replay produce byte-identical action logs
(verified locally and by `grade-local` L1 regrade).

## Local dev grade

`grade-local --driver process` on the frozen dev window (24h,
2026-11-02 → 2026-11-03 UTC):

- Net PnL **−1.385 SOL** (return −13.9%), 566 round trips over 566 coins,
  win rate 29.0%, max drawdown 14.9%.
- Guardrails met: 566 coins hold a round trip of at least 0.01 SOL,
  drawdown within limit.
- Fees: 1.145 SOL curve + 0.121 SOL tx.
- Action log reproduced byte for byte on regrade.

## License

MIT — see `LICENSE`.
