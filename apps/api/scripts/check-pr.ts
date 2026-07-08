/** Debug helper: show FlowGuard's comment + statuses on a PR.
 *  Usage: pnpm exec tsx --env-file=.env scripts/check-pr.ts <prNumber> [ref] */
import { createGithubApp, decodePrivateKey } from "@flowguard/github";

const prNumber = Number(process.argv[2] ?? 1);
const ref = process.argv[3];

const app = createGithubApp({
  appId: process.env.GITHUB_APP_ID!,
  privateKey: decodePrivateKey(process.env.GITHUB_APP_PRIVATE_KEY_BASE64!),
});
const octokit = await app.getInstallationOctokit(145154076);
const { data: comments } = await octokit.rest.issues.listComments({
  owner: "abhinav26966",
  repo: "vercel-reviewer",
  issue_number: prNumber,
});
const ours = comments.filter((c) => c.body?.includes("flowguard:pr-summary"));
console.log(`flowguard comments on PR #${prNumber}: ${ours.length} (of ${comments.length} total)`);
for (const c of ours) console.log(`--- id ${c.id}:\n${c.body}\n`);
if (ref) {
  const { data: statuses } = await octokit.rest.repos.listCommitStatusesForRef({
    owner: "abhinav26966",
    repo: "vercel-reviewer",
    ref,
  });
  console.log(`--- flowguard statuses for ${ref} (newest first):`);
  for (const s of statuses.filter((x) => x.context === "flowguard/flows").slice(0, 4))
    console.log(`  ${s.state}: ${s.description}`);
}
