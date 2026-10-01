# Meme coin trading on Solana: what the data says, what the winners do, and what we are building

Research date: 1 October 2026. Everything below was checked against current sources on that date; links are at the end.

## 1. The bottom line first

- Almost every meme coin dies. Of 832,941 pump.fun launches studied between May and June 2026, 0.198% graduated to a real market (down from 0.63% in late 2025 and about 1.4% in 2024). A Solidus Labs report classified 98.6% of pump.fun tokens as pump-and-dumps or rug pulls.
- Most wallets lose. Dune dashboards through 2025 showed 50 to 60% of pump.fun wallets losing money and 96% either losing or making under $500. Early 2026 looked better on paper (CoinGecko: 56.8% of wallets profitable in February, 73.3% in April), but that study counts realized trades only, nets at the wallet level, ignores bag-holders, and coincided with most retail leaving. Of the wallets that did profit in April 2026, 65.1% made between $1 and $500.
- The money is captured by a small group: token creators collecting fees, insiders who pre-load supply before the public sees the token, coordinated wallet rings, and a few hundred extremely well-equipped snipers. The top 250 token issuers alone earned about $79 million.
- Being "first in" at token creation is an infrastructure race that a laptop or a cloud VM cannot win. Competitive snipers run co-located bare metal next to validators with Yellowstone gRPC and shred streams, and land in the same slot as the creation transaction. A WebSocket feed from a normal RPC sees that event 150 to 300 ms later, by which point the bundlers and slot-zero bots already own the cheap supply.
- The edge that is realistically available to one operator with good software is not milliseconds. It is selection (buying only the small fraction of launches that show organic, non-coordinated demand in the first 20 to 60 seconds), copying a curated set of wallets that have proven they pick winners, disciplined laddered exits, and hard risk limits that keep the bankroll alive long enough for the few big winners to pay for the many small losers.

That is what this bot is built to do. It will not make money every day. It is designed so that a bad week costs a bounded amount and a good launch pays several times the loss, and so that every decision is logged and can be tuned with real data.

## 2. How the game works right now (October 2026)

### The venue
Pump.fun is still the dominant Solana launchpad. New competitors (Ponsfamily and Stonkfun) briefly out-earned it on daily revenue in early September 2026, and LetsBonk had a strong run in 2025, but pump.fun remains where the overwhelming majority of launches, bots and liquidity are. It is also the only venue with an official TypeScript SDK (`@pump-fun/pump-sdk`) and a free real-time feed, so it is the right first target. The architecture keeps the venue behind an interface so another launchpad can be added later.

### The bonding curve
Every token launches with 1 billion supply (2 billion for "mayhem mode" coins, see below) on a constant-product bonding curve seeded with 30 virtual SOL and about 1.073 billion virtual tokens. About 793 million tokens are sold through the curve. When the curve has taken in roughly 85 SOL (about $69k market cap at today's prices), the token "graduates": liquidity moves automatically into PumpSwap, pump.fun's own AMM, with no migration fee and no gap in trading. Price on the curve is simply `virtual_sol_reserves / virtual_token_reserves`, which is why the bot can price every token exactly from on-chain state without any third-party price API.

### Fees, which matter more than people think
Since 1 September 2025 pump.fun charges dynamic fees that fall as market cap rises. At launch-size market caps a bonding-curve trade costs about 1.25% (protocol plus creator fee) per side. PumpSwap starts in the same range and falls to about 0.30% for large tokens. Add a Jito tip or priority fee (today's landed-tip median is 0.0006 SOL, 95th percentile 0.0026 SOL), Jupiter's 50 bps platform fee if you route a token younger than 24 hours through Jupiter, and a third-party transaction builder such as PumpPortal (reported 0.5%). A realistic round trip costs 3 to 5% before slippage. A trade has to move at least that much in your favour just to break even. The bot uses the official SDK to build transactions directly, so it pays no builder fee, and it routes graduated tokens through Jupiter only when the curve is no longer tradeable.

### 2026 program changes a bot must handle
- New unified instructions `buy_v2` / `sell_v2` with mandatory volume-accumulator and fee-sharing accounts; the SDK handles these.
- `create_v2` coins use the Token-2022 program, not the legacy token program, so a bot must resolve the token program per mint or its transactions fail.
- Mayhem mode: creators can opt in to a pump.fun AI agent that mints a second billion tokens and trades them randomly for 24 hours, then burns what is left. Pump.fun itself warns that there is no rational strategy to copy. Mayhem coins produce volume that looks organic and is not, so the bot skips them by default.
- Holder-reward coins route creator fees to holders; cashback coins are deprecated. Neither changes trading, but event layouts grew, and the SDK's tolerant decoders are used for this reason.

## 3. Who actually makes money, and how

1. Creators and insiders. The creator fee share plus "pre-loading" (buying the first few percent of supply in the creation transaction or in a bundle in the same slot) means retail often enters 30 to 50% above the true starting price. The pump.fun study above found that self-bought launches (initial market cap over 30 SOL) graduated at 0.634%, roughly three times the base rate, because the creator has skin in the game; that is a signal, not a guarantee.
2. Coordinated wallet rings. Researchers identified 1,012 persistent cohorts of 2 to 12 wallets that co-fire as early buyers across many launches; the top cohort appeared in 42 launches in two weeks. After controlling for launch quality they still add about 16% to first-30-minute buyer flow. These rings are the "bundles" that trading terminals flag. They are the exit liquidity trap when they hold a large share of supply.
3. Slot-zero snipers. Vendors report that with co-located Frankfurt nodes and gRPC, around 89% of measured graduations were landed in slot zero, versus under 20% from generic cloud regions. These operators pay hundreds to thousands of dollars a month for infrastructure and still lose on most tokens; they win on volume and speed. The same vendors estimate that roughly 90% of do-it-yourself sniper bots fail, and that only about 10% of bots targeting sub-50 ms latency deliver consistent profit.
4. Copy traders. Tools such as GMGN, Cielo, Axiom and Kolscan (now owned by pump.fun and free) rank wallets by realized PnL and win rate, and terminals mirror their buys. Copying works when the copied wallet holds for minutes to hours and when you land close to their price; it fails against scalpers, because by the time your copy lands "the price they got no longer exists". Several high-profile KOL wallets have been shown to profit precisely because followers buy after them, so copy lists must be curated and re-checked.
5. The disciplined minority of manual traders. What the better ones share is boring: small positions, a written entry checklist, selling half at 2x to recover principal, trailing the rest, and leaving when the thesis breaks (developer sells, bundle dumps, volume dies). They lose on most trades and survive because the losses are small and the winners are allowed to run.

## 4. What the profitable traders look at before they buy

The filters below are what trading terminals (GMGN, Axiom, Photon, BullX) surface and what the data analysis supports. The bot implements all of them as scored or hard-fail rules, every one of them configurable.

Hard fails (reject the token):
- Developer holds too much. Dev wallet above about 5% of supply at launch (terminals prefer under 3%) or the developer sells during the observation window.
- Bundled launch. Three or more distinct wallets buying in the same slot as creation (or the slot after) with similar amounts, or sniper-flagged wallets holding more than roughly 20% combined; bundler clusters above 10 to 15% are a red flag; 50% is a near-certain coordinated dump.
- Top holder concentration. Top-10 holders (excluding the curve itself) above about 30%, or any single non-dev wallet above 10 to 20%.
- Mayhem mode, known-bad creator addresses, blacklisted names and symbols, and tokens whose creator wallet is brand new with no history (classic serial-rugger pattern; a fresh wallet funded minutes before launch).
- Already chased. Market cap already far above launch (the move happened without you); entering late means you are the exit liquidity.

Scored signals (add up to a threshold):
- Unique buyers in the first 20 to 60 seconds, with organic rhythm. Graduating tokens show real wallet diversity within the first 30 seconds and transaction timing that varies naturally; mechanically even spacing means a volume bot.
- Buyer wallet quality: aged, active wallets rather than freshly generated ones. The study above found this to be the strongest early predictor of the token being promoted by discovery feeds.
- Accelerating bonding-curve progress (the rate of SOL inflow rising across the window, not merely positive).
- Net SOL inflow and the buy/sell ratio over the window; the ratio of sells to buys in the first minute is a strong tell for farmed launches.
- Social presence in the metadata. Having a Telegram link lifted graduation odds 8.9x (1.485% vs 0.166%); Telegram plus Twitter plus website lifted them 17.4x. Scammers can add links too, so this is a score, not a pass.
- A creator self-buy in a sane range (roughly 0.5 to 2.5 SOL at launch) rather than zero or a huge chunk.

Mint and freeze authority checks that matter on other chains are not needed on pump.fun: the program revokes both at creation, and a token on the curve cannot be made a honeypot. The honeypot risk returns only after graduation on third-party pools, which is one reason the bot's default is to keep positions on the curve small and to lean on Jupiter's routing after graduation.

## 5. How to be early: detection paths, latency and cost

| Path | Latency after the on-chain event | Cost | Notes |
|---|---|---|---|
| PumpPortal WebSocket (`subscribeNewToken`, `subscribeMigration`) | sub-second, typically a few hundred ms | Free | Easiest. Per-token and per-wallet trade subscriptions are metered (0.01 SOL per 10,000 events) and need an API key; the bot does not use those. |
| Solana RPC `logsSubscribe` on the pump.fun program | 150 to 300 ms | Free tier of Helius, QuickNode or Chainstack; public RPC works for testing | Independent of any third party; gives every create and trade event decoded straight from program logs. The bot runs this as the trade feed. |
| Yellowstone gRPC (Geyser) | 5 to 20 ms | Chainstack from $49/month, Shyft from $199, QuickNode gRPC from $499, Helius LaserStream from $999 | The production standard for anyone serious. Supported as an optional listener. |
| gRPC plus ShredStream, co-located bare metal | sees transactions before they execute | thousands per month | Slot-zero racing. Out of scope for an individual operator. |

What this means for strategy: the bot does not try to buy in the creation slot. It uses the first 20 to 60 seconds to watch who is buying and how, which is exactly the window in which the research says the winners separate from the farmed launches. It then enters with a pre-built transaction and a tuned priority fee. In practice this means entering a few percent higher than the slot-zero crowd, in exchange for skipping the large majority of launches that are dead within the minute.

## 6. Execution: landing transactions fast and not overpaying

- Stake-weighted QoS (SWQoS) beats both priority fees and Jito tips for latency (Chorus One measured this directly). Priority fees alone barely move landing time; Jito tips matter mainly for bundle auctions. Over 95% of stake runs the Jito client, so tips are the universal language.
- Three sending paths, all implemented: plain RPC `sendTransaction` with a compute-unit price; the Jito block engine (`sendTransaction` or a bundle, with a tip transfer to one of Jito's eight tip accounts; one request per second unauthenticated; live tip floor from `bundles.jito.wtf`); and Helius Sender, which fans out across Jito, SWQoS and other relays for the price of a 0.001 SOL tip (0.000005 SOL in SWQoS-only mode) with no API credits consumed.
- Dynamic, not hard-coded, tips: the bot reads recent prioritization fees for the pump.fun program and the Jito tip-floor percentiles and clamps between configured minimum and maximum. Vendors' advice is unanimous that fixed tips either overpay all day or fail during congestion.
- Slippage is set per side and escalated on retry. Buying with 10 to 15% slippage on a fast curve is normal; selling uses wider slippage because getting out matters more than the price.
- Transactions are pre-built as far as possible (compute budget, tip, ATA creation) so the hot path is: observe, decide, fill in amounts, sign, send.
- Fallback path: PumpPortal's "local" trade API returns a serialized transaction you sign yourself (your key never leaves the machine) for about 0.5%. It is slower and costs more, so it is not the default, but it is a useful backstop if the program changes before the SDK updates.

## 7. Exit discipline: where most of the PnL actually comes from

The consensus from traders, terminals and the exit-strategy guides is the same and the bot's defaults follow it:
- Sell half at 2x to take the principal off the table, then sell another slice at 3x.
- Trail the remainder: once a position is up meaningfully, a 30% drawdown from its peak closes it.
- Hard stop at about 35% down. On a bonding curve, losses compound quickly once buyers leave.
- Time stop: a launch that has not done anything within about 10 minutes almost never does; exit. A token with no trades for 90 seconds is dead; exit.
- Panic exits: the developer sells, or a single wallet dumps more than about 5% of supply, or buyers vanish while sells continue. Sell immediately at wide slippage; the second after is always worse.
- Graduation handling is configurable: either sell into the graduation pump or hold through migration with the trailing stop active and Jupiter as the price oracle and router.

## 8. Risks specific to running a bot, and how the build addresses them

- Private key exposure. Phantom has no automation API. A bot must hold a key. The bot therefore uses a dedicated hot wallet you create for it, funded only with the risk budget, and that key is imported into Phantom so positions are visible in the Phantom app. The main wallet's key is never used. The key is read from a local `.env` file, never logged, never sent anywhere.
- Malicious "sniper bot" repositories. Cointelegraph and security researchers documented GitHub repos (`solana-pumpfun-bot` by `zldp2002`, "Solana-MEV-Bot-Optimized", "SniperBot-Solana-PumpSwap", dozens of Polymarket bot clones) with inflated stars that steal wallet keys from config files. Do not run code from random repos with a funded key. This project depends only on the official pump.fun SDK, Solana's own libraries, and a handful of widely used utilities; the lockfile pins versions.
- RPC rate limits and stale state. Public RPCs throttle during busy launches, which is exactly when you need them. Budget a paid RPC plan before going live; the bot keeps a request budget and degrades gracefully (skips a launch rather than trading on stale data).
- MEV and sandwiching. Setting tight slippage on the curve limits sandwich profit; Helius Sender's `mev-protect` and Jito's revert protection are available flags.
- Taxes and record keeping. Every fill is written to an append-only log with signatures, amounts and fees.
- The strategy itself can be wrong. Everything above is based on historical analyses and vendor write-ups; the market adapts. The bot ships in paper mode, logs every scored launch with its features and the decision taken, and tracks the price of rejected launches too, so filters can be tuned on your own data before any SOL is at risk.

## 9. Design decision and roadmap

Chosen approach (v1, built in this repository):
1. Feeds: PumpPortal WebSocket for launches and migrations, plus a direct `logsSubscribe` firehose on the pump.fun program decoded with the official SDK for every trade; optional Yellowstone gRPC listener for when you add a paid endpoint.
2. Launch strategy: filter-first observation window, hard fails and a weighted score as in section 4, fixed small entries.
3. Copy strategy: a curated wallet list (from Kolscan, GMGN, Cielo), with trades detected from the same firehose and generic token-balance parsing for non-pump venues; mirrored buys at your own fixed size; optional mirrored sells.
4. Exits: ladder, trailing stop, hard stop, time stop, stagnation, developer-sell and whale-dump panics, graduation handling.
5. Risk: per-trade size, maximum concurrent positions, daily loss limit that halts new entries, minimum SOL reserve for fees, consecutive-loss cooldown, creator blacklist that learns from your own rugs, kill-switch file.
6. Execution: official SDK instruction builders, dynamic priority fee and tip, RPC / Jito / Helius Sender senders, confirmation tracking, retry with escalation, Jupiter for graduated tokens.
7. Paper mode by default with realistic fills (curve math plus fee plus a slippage penalty), identical code path otherwise.

Later (not in v1): PumpSwap direct trading without Jupiter, automated wallet discovery from on-chain PnL, support for a second launchpad, dashboard.

## 10. What we measured ourselves (1 October 2026)

While building the bot we checked the claims above against the live chain from a plain cloud container on the public RPC:

- Launch rate: 0.44 new pump.fun tokens per second. 31% were mayhem-mode coins, 30% had a developer buy above 5% of supply, 14% were quoted in something other than SOL (pump.fun now allows "quote control" mints such as CARDS). Only about a quarter of launches were worth observing at all.
- Of 18 launches observed for the full 25-second window, 2 scored 55 or more, and one of those failed the "already chased" and sell-ratio rules (127 buyers and 17.9 SOL inflow, but market cap already 125 SOL). The single buy, triggered early by 10 buyers, was dumped by a 6.6% holder one second later; the panic exit took a 9% loss instead of the 40% the stop-loss would have taken.
- Pump.fun's fee program currently charges 95 bps protocol plus 30 bps creator on the lowest market-cap tier (1.25% per side). A 0.05 SOL round trip on a large-cap curve cost 2.48% including price impact.
- The program-wide `logsSubscribe` firehose delivered 452 notifications per second, 85% of them failed transactions (bots fighting over the same launches), 0.76 MB/s. Even a single token's subscription delivered 86 notifications per second of which about one per second was a real trade. The spam is the market's signature; gRPC can filter it server-side, WebSocket cannot.
- The public RPC rate-limits `getTokenLargestAccounts` to the point of uselessness, so the holder-concentration check needs a paid endpoint. All other reads were fine for paper trading.
- With all filters disabled as a stress test, 5 buys in 2 minutes lost 5 times (developer sells within seconds, whale dumps, stop-loss, stagnation). The consecutive-loss cooldown then halted new entries by itself.
- A new transaction format (version 1) is now common on Solana; `@solana/web3.js` 1.x cannot decode it, so third-party transactions are read through raw JSON-RPC.

## 11. Sources

Market structure, fees, program changes
- Pump.fun public docs and IDL: https://github.com/pump-fun/pump-public-docs (fee program README, buy_v2/sell_v2, holder rewards, negative virtual quote reserves)
- Official SDK: https://www.npmjs.com/package/@pump-fun/pump-sdk
- Program reference (IDs, PDAs, discriminators): https://docs.solanatracker.io/guides/pumpfun-program
- Fee explainers: https://froglabs.io/blog/pump-fun-fees-explained , https://www.soltokencreator.io/blog/pump-fun-fees-explained , https://blockworks.com/news/pumpdotfun-fee-model , https://smithii.io/en/project-ascend-update/
- Launchpad competition: https://www.coingecko.com/learn/memecoin-launchpad-wars-pumpfun-stonkfun-ponsfamily , https://coinmarketcap.com/academy/article/pumpfun-reclaims-90percent-market-share-in-solana-launchpad-war , https://bex.co/blog/2026/04/22/meme-launchpad-2-pump-fun-letsbonk-anti-sniper-bonding-curve-professionalization
- Mayhem mode: https://chainstack.com/trading-bot-update-full-mayhem-mode-support-for-pump-fun/ , https://cryptonews.net/news/altcoins/32016109/ , https://www.cryptopolitan.com/pump-fun-launches-mayhem-mode-letting-ai-agents-loose-in-the-trenches/
- Graduation mechanics: https://madeonsol.com/blog/pump-fun-graduation-bonding-curve-explained

Who wins and loses
- CoinGecko, "Pump.fun traders are making a comeback" (monthly profitability, methodology caveats): https://www.coingecko.com/research/publications/pump-fun-traders-are-making-a-comeback
- Dune-based loss statistics: https://crypto.news/over-60-pump-fun-traders-saw-losses-less-than-0-01-made-over-1m/ , https://beincrypto.com/pump-fun-trading-data-majority-lose-money/ , https://coinalertnews.com/news/2026/03/25/pumpfun-traders-losses-profits-data
- Solidus Labs rug-pull report coverage: https://forklog.com/en/report-98-of-pump-funs-memecoins-deemed-scams/
- Graduation rate history: https://www.chaincatcher.com/en/article/2139008
- Survival analysis of 832,941 launches, social-presence effect, wallet rings: https://arxiv.deeppaper.ai/papers/2607.02823v1 ; broader Solana memecoin study: https://arxiv.org/html/2512.11850v3
- Kolscan acquisition and KOL profits: https://www.theblock.co/post/362119/pump-fun-makes-first-acquisition-purchases-solana-based-copy-trading-wallet-tracker-kolscan , https://www.dlnews.com/articles/defi/memecoin-kols-bag-millions-as-pump-fun-buys-kolscan-tracker/
- Sniper manipulation: https://beincrypto.com/pump-fun-meme-coin-snipers-systematic-problem/

Filters and signals
- Mobula, detecting snipers and bundlers: https://docs.mobula.io/almanac/detecting-snipers-bundlers
- GMGN, bundles and linked wallets: https://gmgn.ai/blog/what-is-a-meme-coin-bundle/
- Terminal comparison: https://gmgn.ai/blog/best-meme-coin-trading-platforms-2026/
- Smart-money tracking tools: https://madeonsol.com/blog/nansen-vs-gmgn-vs-cielo-smart-money-solana , https://madeonsol.com/blog/how-to-copy-trade-on-solana
- Bot strategy write-ups: https://odin.tools/blog/pump-fun-bot-strategy-solana-2026 , https://parasol.so/blog/pumpfun-trading-bot-automation

Detection, latency, execution
- Sniping infrastructure guide (vendor): https://rpcfast.com/blog/how-to-launches-snipe-pump ; copy-trading infrastructure: https://rpcfast.com/blog/how-to-build-a-solana-copy-trading-bot ; Odinbot same-block claims: https://decrypt.co/314700/how-solana-copy-trading-platform-odinbot-is-achieving-zero-block-latency
- Chorus One, do SWQoS, priority fees and Jito tips make transactions land faster: https://chorus.one/reports-research/transaction-latency-on-solana-do-swqos-priority-fees-and-jito-tips-make-your-transactions-land-faster
- Jito docs (endpoints, tip accounts, tip floor): https://docs.jito.wtf/lowlatencytxnsend/ ; Jito explainer: https://rpcfast.com/blog/jito-explained-bundles-tips-mev-solana
- Helius Sender: https://www.helius.dev/docs/sending-transactions/sender ; Helius plans and LaserStream: https://www.helius.dev/docs/laserstream , https://helius.dev/docs/billing/plans
- Yellowstone gRPC pricing: https://chainstack.com/yellowstone-grpc-more-streams-same-price/ ; client: https://github.com/rpcpool/yellowstone-grpc
- PumpPortal data and trade APIs: https://pumpportal.fun/data-api/real-time/ , https://pumpportal.fun/local-trading-api/trading-api/
- Jupiter Swap API v2: https://developers.jup.ag/docs/swap/v2/order-and-execute , https://developers.jup.ag/docs/swap/v2/fees.md
- Reference open-source bot (Python, no third-party APIs): https://github.com/chainstacklabs/pumpfun-bonkfun-bot

Exits and risk
- https://www.dextools.io/tutorials/memecoin-trading-strategy-take-profits , https://madeonsol.com/blog/solana-memecoin-exit-strategy-guide , https://coin360.com/learn/how-to-trade-memecoins-failing

Safety
- Malicious bot repositories: https://cointelegraph.com/news/solana-trading-bot-github-malware-scam , https://www.stepsecurity.io/blog/malicious-polymarket-bot-hides-in-hijacked-dev-protocol-github-org-and-steals-wallet-keys
- Phantom, importing an account by private key: https://phantom.com/learn/blog/import-and-manage-multiple-wallets-with-phantom
