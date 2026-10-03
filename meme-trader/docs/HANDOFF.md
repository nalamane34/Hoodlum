# Handoff: where the meme-trader project stands (3 October 2026)

Read this first when picking the project up in a new Claude Code session. It holds the state, the rules agreed with the
owner and the next steps. Server address, key files and tokens are deliberately not in here (the repository is public);
the owner provides them in chat.

## What this is

An autonomous Solana meme-coin trading bot for pump.fun launches, running in paper mode on the owner's Ubuntu EC2
server. Phantom has no automation API, so the bot uses its own wallet; the owner imports that wallet's secret into
Phantom to watch positions. The owner is not a developer, wants the bot fully autonomous once live (no per-trade
confirmations; safety lives in the config limits and the kill switch) and accepts the risk of this market.

`README.md` covers setup, going live, server deployment, the dashboard, the remote jobs runner and the RPC credit
budget. `docs/RESEARCH.md` is the research the strategy is built on, with live measurements. `.env.example` documents
every setting.

## Where things run

- Repository `nalamane34/Hoodlum`, branch `meme-trader`, everything under `meme-trader/`. The rest of the repository is unrelated.
- Server: Ubuntu EC2 in eu-central-1, login user `ubuntu`, app directory `~/Hoodlum/meme-trader`. Its `.env` (git-ignored) holds `RPC_URL` with the Helius key and `DASHBOARD_TOKEN`.
- systemd services: `meme-trader` (the bot), `meme-trader-dashboard` (port 8787, loopback only), `meme-trader-agent.timer` (optional jobs runner, see README). Caddy fronts the dashboard on 80/443 once job 006 has run.
- Update flow on the server: `git pull && npm ci && npm run build && npm prune --omit=dev && sudo systemctl restart meme-trader`. Without SSH: push a `deploy/jobs/NNN-*.sh` and the runner executes it within two minutes; output lands in `data/agent/` and on the dashboard.

## State at handoff

- Paper mode since 1 October. After about 20 hours: 15 closed trades, 27% win rate, -0.0975 SOL on a 5 SOL paper balance; exits dominated by dev-sell and whale-dump panics, most of the loss from modelled fees and slippage. The feed was degraded for most of that time (next point), so these numbers are not yet meaningful.
- The first Helius free key's 1 million monthly credits were spent in about a day: the websocket trade feed ran through Helius, which meters websocket traffic per megabyte. Helius then answered everything with `429 Too Many Requests: max usage reached` and the bot crash-looped at its first account fetch.
- Fixes shipped: websocket and background reads moved to the public RPC (jobs 002, 003), realistic paper fee (0.0005 SOL), dev dependencies pruned on the server (004), an RPC failover breaker that keeps the bot on `RPC_FALLBACK_URL` when the primary is out of credits and probes it every 10 minutes (005, `src/chain/rpcFailover.ts`), job 006 to finish the HTTPS dashboard.
- The owner has a new Helius key with a fresh 1 million credits. It is installed with `HELIUS_KEY=<key> bash deploy/jobs/005-rpc-failover.sh` on the server. Whether that has been run, and whether ports 80/443, the runner and the HTTPS dashboard are done, was unknown at handoff: check before assuming.
- Expected Helius usage with the current settings: well under 50 thousand credits a month in paper mode (globals refresh every 10 minutes, one holder check per candidate launch, one curve read per paper buy), plus roughly 50 to 100 credits per live round trip.

## First things to do in a new session

1. Check the server: `systemctl is-active meme-trader` and `journalctl -u meme-trader -n 30 --no-pager`. Healthy means a start line with `"rpc":"mainnet.helius-rpc.com"` and `"ws":"api.mainnet-beta.solana.com"`, then `pump.fun globals loaded` and `ready.`, and status lines ending in `rpc primary N req | ...` with no `max usage reached`.
2. If the bot is not on the new key yet, ask the owner for the key in chat and run job 005 with `HELIUS_KEY`. Never write the key into any file that git tracks.
3. Website: after the owner opens inbound TCP 80 and 443 in the security group, run `SKIP_JOBS_THROUGH=5 bash deploy/install-agent.sh` (installs the runner and runs job 006) or just `bash deploy/jobs/006-website.sh`. The dashboard is then at `https://<public-ip-with-dashes>.sslip.io/`; sign in with `DASHBOARD_TOKEN` from `.env`. If Let's Encrypt refuses with "too many certificates", use a free DuckDNS name (README, Dashboard section).
4. Let paper mode run at least two days on the clean feed. Then review `npm run status`, `data/launches.jsonl`, `data/shadow_outcomes.jsonl` and the dashboard before touching `MIN_SCORE`, `MIN_UNIQUE_BUYERS`, `OBSERVE_SECONDS` or the exit ladder. Report results to the owner in plain language.
5. Going live (README, Going live): `npm run keygen`, fund the new wallet with a small amount only, import the secret into Phantom, set `WALLET_SECRET_KEY` and `MODE=live`, keep `BUY_SOL=0.05`, `MAX_POSITIONS=3`, `DAILY_LOSS_LIMIT_SOL=0.5` until there is data, restart. Kill switch: `npm run panic` (`--liquidate` sells everything).
6. Housekeeping the owner intends to do: rotate the Helius key and the SSH key once things are stable, allocate an Elastic IP, keep the repository public (or add a read-only deploy key) so the server can pull.

## Rules agreed with the owner

- Fully autonomous once live. Do not add confirmation prompts to the trading path.
- Never commit `.env`, wallet secrets, API keys or `.pem` files. Logs print hosts only, never URLs with keys.
- Keep the paid RPC for the trading path and the holder check only; websocket, outcome sampling and wallet history stay on the public endpoint.
- Validate before pushing: `npm run typecheck && npm test` (vitest, 53 tests at handoff). The server runs compiled output from `dist/`.
- Explain things in plain language and give exact commands for anything the owner must do in AWS or on their PC.

## Quirks worth knowing

- `bigint: Failed to load bindings` at start is a harmless message from a Solana library.
- `npm audit` still lists items that are transitive in the Solana and pump.fun SDKs; the only critical one was the test runner, which is upgraded and pruned from the server.
- The public RPC sometimes returns 429 for `getTokenLargestAccounts`; the holder check then fails open with a one-time warning.
- `@pump-fun/pump-sdk` 2.0.0 only works as CommonJS (its ESM entry is broken), so the project compiles to CommonJS.
- Solana serves transaction version 1, which web3.js 1.x cannot decode; third-party transactions are read through `src/chain/rawRpc.ts`.
- Windows: OpenSSH refuses a `.pem` whose permissions are too open. Fix with `icacls FILE /inheritance:r` then `icacls FILE /grant:r "%USERNAME%:R"`.
