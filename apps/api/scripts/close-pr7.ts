import { createGithubApp, decodePrivateKey } from "@flowguard/github";
const app = createGithubApp({ appId: process.env.GITHUB_APP_ID!, privateKey: decodePrivateKey(process.env.GITHUB_APP_PRIVATE_KEY_BASE64!) });
const octokit = await app.getInstallationOctokit(145154076);
await octokit.rest.pulls.update({ owner: "abhinav26966", repo: "vercel-reviewer", pull_number: 5, state: "closed" });
await octokit.rest.git.deleteRef({ owner: "abhinav26966", repo: "vercel-reviewer", ref: "heads/test/phase7-spectrum" });
console.log("PR #5 closed, branch deleted");
