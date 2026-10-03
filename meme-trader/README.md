# meme-trader

An autonomous Solana meme coin trader. It watches every new pump.fun launch, scores the first seconds of trading against the signals that separate organic launches from farmed ones, buys the few that pass, mirrors a curated list of smart wallets, and manages every position with laddered take-profits, trailing and hard stops, and panic exits. Once running it never asks for confirmation. It ships in paper mode.

Read `docs/RESEARCH.md` first. It explains why the bot is built this way, what the data says about who wins and loses in this market, and what a realistic expectation looks like. Short version: most tokens die, most wallets lose, and the edge available to one operator is selection plus discipline, not speed.

## What it does

```
PumpPortal WS ──launches──┐
RPC logsSubscribe ─trades─┼─▶ TokenTracker ─▶ LaunchStrategy (observe 25s → hard filters → score → buy)
Yellowstone gRPC (opt.) ──┘        │           CopyStrategy  (mirror curated wallets)
                                   ▼
                              Portfolio (ladder / trailing / stop / time / stagnation / dev-sell / whale-dump)
                                   ▼
                              Executor ── paper fills  |  live: @pump-fun/pump-sdk → RPC / Jito / Helius Sender
                                                        graduated tokens → Jupiter Swap API v2
                              RiskManager: per-trade size, max positions, daily loss stop, reserve, cooldown, KILL file
```

Every scored launch (features, decision, reasons) goes to `data/launches.jsonl`, every fill to `data/fills.jsonl`, every closed position to `data/closed.jsonl`, and every rejected launch is shadow-tracked for 10 minutes so you can see what you skipped (`data/shadow_outcomes.jsonl`). Tune the filters on your own data before risking SOL.

## Quick start (paper mode, no wallet needed)

```bash
cd meme-trader
npm install
cp .env.example .env          # defaults are paper mode on the public RPC
npm run smoke                 # read-only self test: RPC, pump.fun globals, live quote, Jupiter
npm run dev                   # starts observing launches and paper trading
```

Let it run for a day. Then look at `data/launches.jsonl` and `data/shadow_outcomes.jsonl`: which skipped launches ran, which bought ones died, and adjust `MIN_SCORE`, `MIN_UNIQUE_BUYERS`, `OBSERVE_SECONDS` and the exit settings. `npm run status` prints positions and PnL.

## Going live

Phantom has no automation API, so the bot needs a key of its own. Do not use your main wallet.

1. `npm run keygen` prints a fresh keypair.
2. Put the base58 secret in `.env` as `WALLET_SECRET_KEY`. Never commit `.env`.
3. Import the same secret into Phantom: Settings → Manage Accounts → Add/Connect Wallet → Import Private Key. You now see the bot's wallet and every position inside Phantom.
4. Send it only the SOL you are prepared to lose. Keep at least `MIN_RESERVE_SOL` on top of your trading budget for fees.
5. Get a paid RPC endpoint (Helius, QuickNode, Chainstack, Triton). Public RPC rate-limits during busy launches, which is exactly when you need it.
6. Set `MODE=live`, start with `BUY_SOL` small, and run `npm run build && npm start` under a process manager (pm2, systemd) on a machine that stays on.

Nothing will ask you to confirm trades. The only brakes are the risk limits in `.env` and the kill switch:

```bash
npm run panic                 # stop opening new positions (existing ones keep following exit rules)
npm run panic -- --liquidate  # also sell everything now
npm run panic -- --clear      # resume
```

## Running on a server (EC2 or any Ubuntu VPS)

```bash
git clone -b meme-trader https://github.com/nalamane34/Hoodlum.git
cd Hoodlum/meme-trader
bash deploy/ec2-setup.sh        # installs Node 22, builds, creates .env, installs a systemd service
nano .env                       # RPC_URL (e.g. https://mainnet.helius-rpc.com/?api-key=...), risk limits
npm run smoke
sudo systemctl start meme-trader
journalctl -u meme-trader -f
```

The service restarts on crash and on reboot, stops cleanly with SIGINT so state is flushed, and open positions resume on the next start. Edit `.env` then `sudo systemctl restart meme-trader` to apply changes. `t3.small` / `t4g.small` is plenty; inbound bandwidth (all the bot uses) is free on AWS. Lock the security group to SSH from your IP only and keep `.env` at mode 600: whoever can read it owns the wallet.

## Dashboard

A read-only page served from the bot's data directory: balance and PnL tiles, cumulative realized PnL, launches per hour, the decision funnel, skip reasons, score distribution, what skipped launches did afterwards (misses and dodges), open and closed positions, the latest decisions and the log tail. Window filter (1h / 6h / 24h / 7d), hover tooltips, a table view for every chart, light and dark themes.

```bash
npm run dashboard          # http://127.0.0.1:8787/ by default
```

On a server the deploy script installs it as `meme-trader-dashboard`. Two ways to reach it:

- Tunnel (nothing exposed): `ssh -i YOUR.pem -L 8787:127.0.0.1:8787 ubuntu@SERVER_IP`, then open http://localhost:8787/ while that SSH session is open.
- Public with a token: set `DASHBOARD_HOST=0.0.0.0` in `.env` (the setup script already generated `DASHBOARD_TOKEN`), open port 8787 in the security group (your IP only is best), `sudo systemctl restart meme-trader-dashboard`, then open `http://SERVER_IP:8787/?token=YOUR_TOKEN` once; a cookie keeps you signed in.

- Public HTTPS URL (free): `bash deploy/expose.sh` installs Caddy, obtains a Let's Encrypt certificate for `<ip-with-dashes>.sslip.io` (or a hostname you pass, e.g. a free DuckDNS name), and proxies to the dashboard, which stays bound to loopback. Open ports 80 and 443 in the security group, then sign in once on the `/login` page with `DASHBOARD_TOKEN`. Allocate an Elastic IP so the address, and with it the sslip.io name, survives a stop/start.

Sign-in is a token entered once on `/login` (cookie, `Secure` behind HTTPS, 8 attempts per minute per client). `/logout` forgets the browser. The dashboard only reads files; it cannot trade or change settings.

## Remote jobs runner (optional, hands-off operations)

`bash deploy/install-agent.sh` installs a systemd timer that every two minutes pulls this branch and runs any new `deploy/jobs/NNN-*.sh` exactly once, in order, logging to `data/agent/`. It is how the server can be operated without SSH: push a job, the server runs it, the result shows on the dashboard under "Remote jobs" (and at `/api/agent`). Job 001 rebuilds the bot and puts the dashboard on HTTPS.

Security: anyone who can push to this branch can then run commands on the server as the login user. Keep push access to yourself, keep the repository readable by the server (public, or add a read-only deploy key if you make it private), and disable the runner at any time with `sudo systemctl disable --now meme-trader-agent.timer`. Jobs never re-run, even after a failure; a retry is a new job number.

## Configuration

Everything lives in `.env`; `.env.example` documents each setting. The important groups:

| Group | Keys | Notes |
|---|---|---|
| Mode | `MODE`, `RPC_URL`, `WALLET_SECRET_KEY` | `paper` or `live` |
| Feeds | `FEEDS`, `TRADE_FEED` | `watched` (default) subscribes per token we observe or hold; `firehose` streams every pump.fun log (measured 0.76 MB/s, about 65 GB/day) and sees same-slot bundles and wallet rings better. In both modes most messages are failed bot transactions, which `logsSubscribe` cannot filter; a hot token alone produces ~90 notifications/s. Yellowstone gRPC filters failures server-side. |
| Sending | `SENDER`, `PRIORITY_FEE_*`, `TIP_SOL_*`, `SLIPPAGE_*` | `rpc`, `jito` or `helius`; fees and tips auto-tune from live data within your clamps |
| Risk | `BUY_SOL`, `MAX_POSITIONS`, `MAX_DAILY_LOSS_SOL`, `MIN_RESERVE_SOL`, `MAX_CONSECUTIVE_LOSSES` | hard limits; the daily loss stop halts new entries until the next UTC day |
| Launch filters | `OBSERVE_SECONDS`, `MIN_SCORE`, `MIN_UNIQUE_BUYERS`, `MAX_DEV_PCT`, `MAX_TOP10_PCT`, `MAX_BUNDLE_PCT`, `MAX_SELL_RATIO`, `MIN_NET_INFLOW_SOL`, `MAX_ENTRY_MCAP_SOL`, `SKIP_MAYHEM`, `NAME_BLACKLIST` | see `docs/RESEARCH.md` section 4 for where the thresholds come from |
| Copy trading | `COPY_ENABLED`, `COPY_WALLETS`, `COPY_MIN_THEIR_SOL`, `COPY_BUY_SOL`, `COPY_FOLLOW_SELLS` | curate wallets from Kolscan, GMGN or Cielo; re-check them monthly |
| Exits | `TP_LADDER`, `TRAIL_PCT`, `TRAIL_ARM_MULT`, `STOP_LOSS_PCT`, `MAX_HOLD_MIN`, `STAGNATION_SECONDS`, `EXIT_ON_DEV_SELL`, `WHALE_DUMP_PCT`, `SELL_ON_GRADUATION` | defaults: sell 50% at 2x and 25% at 3x, trail the rest 30% off the peak, stop at -35%, leave after 10 minutes without +10% |

### How a launch is judged

Hard fails (any one rejects): mayhem-mode coin, blacklisted name or creator, developer bought more than `MAX_DEV_PCT` of supply, developer sold during the window, fewer than `MIN_UNIQUE_BUYERS` distinct buyers, net inflow below `MIN_NET_INFLOW_SOL`, sell/buy ratio above `MAX_SELL_RATIO`, a single non-dev wallet above `MAX_SINGLE_HOLDER_PCT`, three or more wallets buying in the creation slot (bundle), top-10 holders above `MAX_TOP10_PCT`, market cap already above `MAX_ENTRY_MCAP_SOL`, too many sampled buyers that keep appearing in other launches' first minute (wallet ring).

Score (0 to 100, buy at `MIN_SCORE`): unique buyers, net SOL inflow, accelerating inflow, organic transaction rhythm, social links in the metadata, a sane developer self-buy, an aged creator wallet, aged buyer wallets, few sells, spread-out holdings. The weights are in `src/strategy/scorer.ts` and are deliberately simple so they can be tuned from the logs.

If `EARLY_TRIGGER_BUYERS` distinct buyers show up before the window ends with no red flags, the bot buys immediately instead of waiting.

## What a live session looked like (1 October 2026, public RPC, paper mode)

Measured while building this, so you know what "normal" is:

| Metric | Value |
|---|---|
| New pump.fun tokens | 0.44 per second (70 in 160 s) |
| Rejected before observation: mayhem mode / dev holds >5% / not SOL-quoted | 31% / 30% / 14% |
| Fully observed for 25 s | 18 of 70; 2 scored 55 or higher; 1 bought (early trigger), exited 1 s later on a 6.6% whale dump at -9% |
| Program-wide log firehose | 452 notifications/s, 85% failed transactions, 0.76 MB/s |
| One hot token's own subscription | 86 notifications/s, of which 1 trade/s was real |
| Round trip on a large-cap curve (0.05 SOL in, sold back immediately) | -2.48% including fees and price impact |
| Public RPC | `getTokenLargestAccounts` returns 429 (holder check unavailable); everything else fine for paper mode |

With all filters disabled (a deliberate stress test) the bot bought 5 launches in 2 minutes and lost on all 5 (dev sold, whale dump, stop loss, stagnation), then stopped itself through the consecutive-loss cooldown. That is the market the defaults are protecting you from; do not loosen them without data from `data/launches.jsonl` and `data/shadow_outcomes.jsonl`.

## RPC credit budget

Measured usage with the defaults (websocket on the public endpoint, background reads on the public endpoint): the paid plan serves only the trading path and the top-holder check for launches that pass the free signals, roughly 20 to 40 thousand credits a month in paper mode plus about 50 credits per live trade. Helius's free tier (1 million credits a month, 10 requests a second) is enough; what pushed the first day over the limit was the websocket, which Helius meters at 20 credits per MB and which carries mostly failed bot transactions.

## Costs you should know

A bonding-curve round trip costs about 1.25% in and 1.25% out in pump.fun fees at launch-size market caps, plus a priority fee or tip (typically 0.0005 to 0.003 SOL), plus slippage. Jupiter adds 50 bps on tokens younger than 24 hours. Expect 3 to 5% before slippage; a trade must move at least that much to break even. The paper mode models fees and a slippage penalty (`PAPER_FEE_SOL`, `PAPER_SLIPPAGE_PCT`); make them pessimistic.

## Project layout

```
src/
  index.ts               wiring, loops, shutdown
  config.ts              .env schema (zod) and derived settings
  chain/                 pump.fun SDK wrapper, log decoding, sender (rpc/jito/helius), fee oracle, Jupiter, metadata, holders, wallet history
  feed/                  PumpPortal feed, RPC logs feed (watched/firehose), copy-wallet watcher, optional Yellowstone gRPC
  strategy/              tracker (per-token state), scorer, exits, launch strategy, copy strategy
  portfolio/             store (JSON state + JSONL logs), risk manager, portfolio (positions and exit loop)
  exec/executor.ts       buys and sells, live or paper, same interface
  tools/                 keygen, status, panic, smoke
test/                    unit tests (vitest) incl. a real mainnet log sample
docs/RESEARCH.md         the research and the design rationale
```

## Commands

```bash
npm run dev        # run from source (tsx)
npm run build      # compile to dist/
npm start          # run compiled
npm test           # unit tests
npm run typecheck
npm run smoke      # read-only connectivity + SDK self-test
npm run keygen     # new bot wallet
npm run status     # positions and PnL from data/state.json
npm run panic      # kill switch (see above)
```

## Safety notes

- The bot depends on the official `@pump-fun/pump-sdk`, Solana's own libraries and a few small utilities. Do not run "sniper bot" repos from strangers with a funded key; several have been wallet drainers (see `docs/RESEARCH.md` section 8).
- `WALLET_SECRET_KEY` is read from `.env` only, never logged (the logger redacts base58 strings of key length), never sent anywhere except to sign transactions locally. Jupiter's `/execute` receives a transaction you already signed, not your key.
- Trading income is taxable in most places. `data/fills.jsonl` and `data/closed.jsonl` are your records.
- This software can lose all the SOL in its wallet. It is built to lose it slowly and in a controlled way; it cannot promise to make money.

## Roadmap

Direct PumpSwap trading without Jupiter, automated wallet discovery from on-chain PnL, a second launchpad behind the same interface, a small web dashboard. Yellowstone gRPC is already supported as an optional feed (`npm i @triton-one/yellowstone-grpc`, set `FEEDS=grpc,pumpportal` and `GRPC_ENDPOINT`).
