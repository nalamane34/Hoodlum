import { Keypair } from "@solana/web3.js";
import { exportBase58 } from "../chain/wallet.js";

const kp = Keypair.generate();
console.log(`
New dedicated bot wallet
========================
Public key (fund this, watch it in Phantom):
  ${kp.publicKey.toBase58()}

Secret key, base58 (paste into .env as WALLET_SECRET_KEY and into Phantom -> Settings -> Manage Accounts -> Add/Connect Wallet -> Import Private Key):
  ${exportBase58(kp)}

Rules:
  1. Fund it ONLY with the amount you are willing to lose completely.
  2. Never put your main Phantom wallet's key in .env.
  3. .env is git-ignored; keep it that way. Anyone with this string owns the funds.
`);
