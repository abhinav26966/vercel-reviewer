import { z } from "zod";

/**
 * projects.settings jsonb shape (doc 08 comment on the projects table).
 * Zod-validated at the boundary like all JSONB columns.
 */
export const ProjectSettingsSchema = z.object({
  runnerConcurrency: z.number().int().positive().default(3),
  measureSamples: z.number().int().min(1).max(3).default(2),
  agentHealEnabled: z.boolean().default(false),
  perfDefaults: z
    .object({
      relativeFactor: z.number().positive().default(3.0),
      absoluteFloorMs: z.number().int().nonnegative().default(500),
    })
    .prefault({}),
  fanoutGlobs: z.array(z.string()).default([]),
  authPathGlobs: z.array(z.string()).default([]),
  /**
   * App root within the repo (Vercel "Root Directory", e.g. "examples/demo-app";
   * "" = repo root). Maps coverage source paths to repo-relative diff paths.
   */
  rootDir: z.string().default(""),
  artifactRetentionDays: z.number().int().positive().default(30),
});

export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;
