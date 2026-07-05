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
