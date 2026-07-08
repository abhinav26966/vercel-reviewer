import type { z } from "zod";
import type {
  AssertionSchema,
  ExecuteFlowJobSchema,
  FlowStepSchema,
  RunFlowResultSchema,
  StepAssertionResultSchema,
  StepResultSchema,
} from "@flowguard/schemas";

export type Assertion = z.infer<typeof AssertionSchema>;
export type FlowStep = z.infer<typeof FlowStepSchema>;
export type ExecuteFlowJob = z.infer<typeof ExecuteFlowJobSchema>;
export type RunFlowResult = z.infer<typeof RunFlowResultSchema>;
export type StepResult = z.infer<typeof StepResultSchema>;
export type StepAssertionResult = z.infer<typeof StepAssertionResultSchema>;
