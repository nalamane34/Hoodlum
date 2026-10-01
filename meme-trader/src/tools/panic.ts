import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const dataDir = process.env.DATA_DIR ?? "./data";
fs.mkdirSync(dataDir, { recursive: true });
const file = path.join(dataDir, "KILL");
const args = process.argv.slice(2);
if (args.includes("--clear")) {
  if (fs.existsSync(file)) fs.unlinkSync(file);
  console.log("kill switch cleared; the bot may open positions again");
} else if (args.includes("--liquidate")) {
  fs.writeFileSync(file, "liquidate\n");
  console.log("KILL=liquidate written: the running bot sells every open position now and opens nothing new. `npm run panic -- --clear` to resume.");
} else {
  fs.writeFileSync(file, "halt\n");
  console.log("KILL=halt written: the running bot opens nothing new (existing positions still follow their exit rules). Add --liquidate to also sell everything.");
}
