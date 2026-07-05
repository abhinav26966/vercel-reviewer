import { z } from "zod";

/**
 * Verdict taxonomy (doc 05 §1) + judge output contract (doc 05 §3).
 */

export const VerdictKindSchema = z.enum([
  "passing", // ✅
  "broken", // 🔴
  "slower", // 🟡
  "hung", // 🟠
  "dead", // 🟠
  "changed_as_intended", // 🔵
  "skipped", // ⚪
  "already_broken_on_base", // ⬜
  "env_issue", // 🟣
]);
export type VerdictKind = z.infer<typeof VerdictKindSchema>;

/** Blocking rule (doc 05 §1): any 🔴/🟠 → status-check failure. */
export const BLOCKING_VERDICTS: readonly VerdictKind[] = ["broken", "hung", "dead"];

export const ApprovalStateSchema = z.enum(["awaiting", "approved", "rejected"]);

export const VerdictSchema = z.object({
  runId: z.string().min(1),
  flowId: z.string().min(1),
  verdict: VerdictKindSchema,
  confidence: z.number().min(0).max(1).nullable().default(null),
  rationale: z.string().nullable().default(null),
  humanCopy: z.string().min(1),
  /** Keys of the judge evidence bundle (artifact refs). */
  evidence: z.record(z.string(), z.unknown()).default({}),
  /** For 🔵 only. */
  approvalState: ApprovalStateSchema.nullable().default(null),
});
export type Verdict = z.infer<typeof VerdictSchema>;

/**
 * Judge three-way output (doc 05 §3.1). The judge can NEVER emit `passing` —
 * intent evidence only downgrades severity to changed_as_intended, never to ✅.
 * `inconclusive` renders as 🔴 with softened copy.
 */
export const JudgeOutputSchema = z.object({
  outcome: z.enum(["regression", "changed_as_intended", "inconclusive"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  humanCopy: z.string().min(1),
});
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;
