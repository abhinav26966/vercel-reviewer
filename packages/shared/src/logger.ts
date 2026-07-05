import { pino } from "pino";
import type { Logger, DestinationStream } from "pino";
import { globalRedaction, type RedactionRegistry } from "./redaction.js";

export interface CreateLoggerOptions {
  name: string;
  level?: string;
  /** Defaults to the process-wide registry. Injectable for tests. */
  redaction?: RedactionRegistry;
  /** Custom destination stream (tests). */
  destination?: DestinationStream;
}

/**
 * Structured pino logger with the redaction transform applied to every log call
 * (doc 01 §6 "Logging: structured (pino), with the redaction transform from doc 07
 * applied globally"). All interpolation args and merge objects are deep-scrubbed.
 */
export function createLogger(opts: CreateLoggerOptions): Logger {
  const registry = opts.redaction ?? globalRedaction;
  const logger = pino(
    {
      name: opts.name,
      level: opts.level ?? process.env.LOG_LEVEL ?? "info",
      hooks: {
        logMethod(args, method) {
          const scrubbed = args.map((a) => registry.redactDeep(a)) as typeof args;
          return method.apply(this, scrubbed);
        },
      },
    },
    opts.destination,
  );
  return logger;
}
