import { App } from "octokit";
import { decodePrivateKey } from "@flowguard/github";
const app = new App({
  appId: process.env.GITHUB_APP_ID!,
  privateKey: decodePrivateKey(process.env.GITHUB_APP_PRIVATE_KEY_BASE64!),
});
const { data } = await app.octokit.request("GET /app/hook/deliveries", { per_page: 30 });
const deliveries = data as Array<{ id: number; event: string; action: string | null; delivered_at: string }>;
const recent = deliveries.filter((d) => d.event === "deployment_status").slice(0, 4);
for (const d of recent) {
  console.log("redelivering", d.id, d.action, d.delivered_at);
  await app.octokit.request("POST /app/hook/deliveries/{delivery_id}/attempts", { delivery_id: d.id });
}
console.log("done:", recent.length);
