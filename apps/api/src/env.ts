import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  DATABASE_URL: z
    .string()
    .default("postgres://flowguard:flowguard@localhost:5433/flowguard"),
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY_BASE64: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  FLOWGUARD_MASTER_KEY: z.string().min(1),
  LOG_LEVEL: z.string().default("info"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  /** Base for artifact links in PR comments (Phase 13 makes this a real host). */
  PUBLIC_API_URL: z.string().default("http://localhost:8787"),
  /** Dashboard base for credential links in 🟣 comment rows. */
  PUBLIC_DASHBOARD_URL: z.string().default("http://localhost:3100"),
  S3_ENDPOINT: z.string().default("http://localhost:9000"),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY_ID: z.string().default("minioadmin"),
  S3_SECRET_ACCESS_KEY: z.string().default("minioadmin"),
  S3_BUCKET: z.string().default("flowguard-artifacts"),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment: ${missing} (see apps/api/.env.example)`);
  }
  return parsed.data;
}
