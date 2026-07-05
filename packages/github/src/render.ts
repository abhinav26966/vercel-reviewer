/**
 * PR comment bodies. Phase 1: the "hello" comment (doc 09 Phase 1 task 4).
 * The full verdict table renderer (doc 05 §6) lands in Phase 3.
 */
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
