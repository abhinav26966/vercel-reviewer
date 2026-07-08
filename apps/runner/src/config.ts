import { z } from "zod";

const RunnerEnvSchema = z.object({
  S3_ENDPOINT: z.string().default("http://localhost:9000"),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY_ID: z.string().default("minioadmin"),
  S3_SECRET_ACCESS_KEY: z.string().default("minioadmin"),
  S3_BUCKET: z.string().default("flowguard-artifacts"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  RUNNER_HEADLESS: z.coerce.boolean().default(true),
  LOG_LEVEL: z.string().default("info"),
});

export type RunnerEnv = z.infer<typeof RunnerEnvSchema>;

export function loadRunnerEnv(source: NodeJS.ProcessEnv = process.env): RunnerEnv {
  return RunnerEnvSchema.parse(source);
}
