import { createGithubApp, decodePrivateKey } from "@flowguard/github";

const app = createGithubApp({
  appId: process.env.GITHUB_APP_ID!,
  privateKey: decodePrivateKey(process.env.GITHUB_APP_PRIVATE_KEY_BASE64!),
});
const octokit = await app.getInstallationOctokit(145154076);
const { data: comments } = await octokit.rest.issues.listComments({
  owner: "abhinav26966", repo: "vercel-reviewer", issue_number: 1,
});
console.log("total comments on PR #1:", comments.length);
for (const c of comments) {
  console.log(`--- comment ${c.id} by ${c.user?.login}:`);
  console.log(c.body);
}
const sha = process.argv[2];
if (sha) {
  const { data: statuses } = await octokit.rest.repos.listCommitStatusesForRef({
    owner: "abhinav26966", repo: "vercel-reviewer", ref: sha,
  });
  console.log("--- flowguard statuses for", sha.slice(0, 7), ":");
  for (const s of statuses.filter((s) => s.context === "flowguard/flows"))
    console.log(` ${s.state}: ${s.description}`);
}
