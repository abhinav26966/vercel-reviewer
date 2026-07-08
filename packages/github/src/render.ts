/**
 * PR comment bodies (doc 05 §6): the sticky comment IS the product surface.
 * One table row per flow; failure rows always name the exact step and cause.
 */
export interface FlowReviewRow {
  flowName: string;
  emoji: string;
  label: string;
  detail: string;
}

export interface FlowReviewComment {
  headSha: string;
  pushNumber: number;
  baseBranch: string;
  mergeBaseSha: string | null;
  previewHost: string;
  rows: FlowReviewRow[];
  runDetails: string;
}

export function renderFlowReviewComment(c: FlowReviewComment): string {
  const compared = c.mergeBaseSha
    ? `Compared against \`${c.baseBranch}\` @ \`${c.mergeBaseSha.slice(0, 7)}\` (merge base)`
    : `Base comparison unavailable — assertions evaluated on head only`;
  const lines = [
    `## 🛡️ FlowGuard — flow review for \`${c.headSha.slice(0, 7)}\` (push #${c.pushNumber})`,
    `${compared} · preview: ${c.previewHost}`,
    ``,
    `| Flow | Verdict | Detail |`,
    `|---|---|---|`,
    ...c.rows.map((r) => `| ${escapeCell(r.flowName)} | ${r.emoji} ${r.label} | ${escapeCell(r.detail)} |`),
    ``,
    `<details><summary>Run details</summary>`,
    ``,
    c.runDetails,
    `</details>`,
  ];
  return lines.join("\n");
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
export function renderPreviewDetectedComment(params: {
  previewUrl: string;
  sha: string;
  pushNumber?: number;
}): string {
  const host = params.previewUrl.replace(/^https?:\/\//, "");
  const shortSha = params.sha.slice(0, 7);
  return [
    `## 🛡️ FlowGuard`,
    ``,
    `Preview detected for \`${shortSha}\`: [${host}](https://${host})`,
    ``,
    `No flows configured yet — record your first flow to get verdicts on every push.`,
  ].join("\n");
}
