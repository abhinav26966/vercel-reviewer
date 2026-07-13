import { describe, expect, it } from "vitest";
import { renderFlowReviewComment } from "../src/render.js";

const base = {
  headSha: "abcdef1234",
  pushNumber: 3,
  baseBranch: "main",
  mergeBaseSha: "deadbeef99",
  previewHost: "app.vercel.app",
  rows: [{ flowName: "Login", emoji: "✅", label: "passing", detail: "1.2s" }],
  runDetails: "1/1 flows",
};

describe("renderFlowReviewComment — report footer (doc 09 Phase 13)", () => {
  it("adds a 'report it' link when a reportUrl is given", () => {
    const c = renderFlowReviewComment({ ...base, reportUrl: "https://dash.local/projects/prj_1?run=run_1#reports" });
    expect(c).toContain("[Report it](https://dash.local/projects/prj_1?run=run_1#reports)");
    expect(c).toContain("false positives are the one thing we never ship");
  });

  it("omits the footer when no reportUrl", () => {
    const c = renderFlowReviewComment(base);
    expect(c).not.toContain("Report it");
  });
});
