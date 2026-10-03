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

**Result:** pending.

## 2. Exit ladder (needs price paths)

Since 3 October 2026 (late UTC) the bot saves every trade of bought tokens and of active skipped launches to
`data/paths/DAY.jsonl`, and keeps active skips subscribed for the shadow window. Exit variants (earlier partial profit
around 1.5x, trailing stop settings) and a later-entry strategy (buy launches that survived their first minutes) are to
be replayed on those paths once about a day of them exists. A rough what-if from `closed.jsonl` alone could not reproduce
the actual results, so it was not used.

**Result:** pending.
