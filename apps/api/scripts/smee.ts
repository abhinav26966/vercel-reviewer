/** Forwards the smee.io channel to the local webhook endpoint (SETUP.md item 4). */
import SmeeClient from "smee-client";

const source = process.env.SMEE_URL;
if (!source) {
  console.error("SMEE_URL missing — set it in apps/api/.env");
  process.exit(1);
}
const target = `http://localhost:${process.env.PORT ?? 8787}/webhooks/github`;

const smee = new SmeeClient({ source, target, logger: console });
smee.start();
console.log(`forwarding ${source} -> ${target}`);
