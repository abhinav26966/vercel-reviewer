/**
 * Typed errors shared across services. Every failure mode that surfaces to a user
 * gets a stable machine-readable code (doc 09 standing rule 2: "no generic 'flow failed'").
 */
export type ErrorCode =
  | "validation_failed"
  | "not_found"
  | "unauthorized"
  | "conflict"
  | "env_issue"
  | "secret_resolution_failed"
  | "origin_scope_violation"
  | "webhook_signature_invalid"
  | "internal";

export class FlowGuardError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    opts?: { details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "FlowGuardError";
    this.code = code;
    this.details = opts?.details;
  }
}

export class ValidationError extends FlowGuardError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("validation_failed", message, { details });
    this.name = "ValidationError";
  }
}

export class NotFoundError extends FlowGuardError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("not_found", message, { details });
    this.name = "NotFoundError";
  }
}

export function isFlowGuardError(err: unknown): err is FlowGuardError {
  return err instanceof FlowGuardError;
}
