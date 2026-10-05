# Experiments

Changes to entry or exit settings are tested here first, on trades the rule was not found on, so the bot is not tuned
to luck. Record each experiment before looking at its result.

## 1. Three entry rules (frozen 3 October 2026, 22:00 UTC)

**Found on:** the 84 paper trades opened between 3 Oct 02:48 UTC (clean feed, new RPC key) and 21:53 UTC. Net -0.171 SOL;
8 trades reached 2x and earned +0.617 SOL, the other 76 lost -0.788 SOL.

| Rule (feature at the buy decision, `data/launches.jsonl`) | Allowed | Blocked |
|---|---|---|
| `score >= 70` | 28 trades, +0.111 SOL | 56 trades, -0.282 SOL |
| creator holds `< 2%` (`features.devPct`) | 48 trades, +0.066 SOL | 36 trades, -0.236 SOL |
| market cap `< 60` SOL (`features.mcapSol`) | 72 trades, -0.082 SOL | 12 trades, -0.089 SOL, no 2x trade |

Why they could be real: a creator still holding supply can dump it on buyers (dev-sell exits were the most common loss),
and a launch already above 60 SOL has run up, so the bot buys from earlier buyers who are about to sell. Why they could
be luck: only 8 winning trades decide most of the result.

**Test:** the bot keeps its normal settings (`MIN_SCORE=55`, `MAX_DEV_PCT=5`, `MAX_ENTRY_MCAP_SOL=90`). `npm run rulecheck`
splits the launch trades opened since the freeze by whether each rule would have allowed them.

**Decide** once there are at least 60 fresh trades. Switch a rule on (`MIN_SCORE=70`, `MAX_DEV_PCT=2`,
`MAX_ENTRY_MCAP_SOL=60`) only if the trades it allows beat the trades it blocks on average, and still do with the single
best trade left out. Otherwise drop it.

**Result (5 October 2026, 21:33 UTC, 160 fresh trades, -1.065 SOL in total):**

| Rule | Allowed: avg / without best | Blocked: avg / without best | Verdict |
|---|---|---|---|
| `score >= 70` | -0.0041 / -0.0060 | -0.0078 / -0.0089 | passes: `MIN_SCORE=70` |
| creator holds `< 2%` | -0.0092 / -0.0106 | -0.0047 / -0.0059 | fails (reversed): dropped |
| market cap `< 60` SOL | -0.0066 / -0.0074 | -0.0069 / -0.0097 | passes by the letter, effect negligible: `MAX_ENTRY_MCAP_SOL=60` |

Both passing rules only make the bot lose more slowly; neither group was profitable.

## 2. Exit ladder (needs price paths)

Since 3 October 2026 (late UTC) the bot saves every trade of bought tokens and of active skipped launches to
`data/paths/DAY.jsonl`, and keeps active skips subscribed for the shadow window. Exit variants (earlier partial profit
around 1.5x, trailing stop settings) and a later-entry strategy (buy launches that survived their first minutes) are to
be replayed on those paths once about a day of them exists. A rough what-if from `closed.jsonl` alone could not reproduce
the actual results, so it was not used.

**Result (5 October 2026, 150 bought trades with paths):** the replay matched the actual win or loss on 139 of 150 trades
with a 1.5 s exit delay. Speed decides everything: with an instant exit the current rules were -0.064 SOL, with 0.5 s
-0.529, 1.5 s -0.638 (actual -0.865). Prices gap within a second after a dump, so the sell lands after it. The best
variant at realistic delays (sell everything at 1.3x) was still -0.30 SOL; `score >= 70` plus a 20% trailing stop was
+0.053 on 48 trades but -0.067 without its best trade. No exit change adopted.

## 3. Later entry (5 October 2026)

Buying launches that survived 1, 2 or 4 minutes (market cap at least 45, 60 or 90 SOL, optionally still rising), on
4,618 saved paths with 1.5 s delays: every variant lost. Waiting 4 minutes lost least (about -0.0023 SOL per trade).
Only 10 minutes of path after the decision exist, so holds of hours are untested.

## 4. Entry-signal search (5 October 2026)

2,743 observed launches with paths, bought at the decision time with 1.5 s buy and sell delays, four exit styles,
tuned on the older 60% and judged on the newer 40%. Buying every active launch loses about -0.0025 to -0.0036 SOL per
trade (5-7% of the stake), which is roughly the modelled friction: after the bot's entry, prices are a coin flip.
`score >= 70` is consistently less bad but negative. No feature quintile (buyers, inflow, sell ratio, dev holdings,
bundles, socials, market cap, acceleration, rhythm, age, curve progress) was positive on both halves. Conclusion: the
recorded launch features carry no edge large enough to beat fees once reaction time is realistic.

`npm run backtest` now does this replay with the exit settings from `.env` (`--set KEY=VALUE` for what-ifs), using
the bot's own exit code (`src/strategy/replay.ts`).

## 5. Smart wallets (frozen 5 October 2026, before any wallet data exists)

**Idea:** some wallets keep buying early into launches that then run. If so, their early buy is information the
launch features lack. **Data:** from this date every saved path point carries the trader's wallet.

**Test,** after at least two full days of wallet data:
- Split launches by time: older 60%, newer 40%.
- On the older part, an early buy is a buy within 60 s of the launch; it hits if the market cap reaches 1.5x the price
  of that buy within 5 minutes. A wallet is smart with at least 5 early buys and a hit rate of at least twice the
  base rate of all early buys.
- On the newer part, enter 1.5 s after a smart wallet's early buy and exit with the `.env` rules (the backtest replay).

**Decide:** adopt (copy those wallets through `COPY_WALLETS` or a new launch signal) only if, on the newer part,
the signal has at least 30 trades and a positive average with the best trade left out. Otherwise the wallet idea is
dropped.

**Result:** pending.
