/**
 * Redaction registry (doc 07 §4.3): the moment a secret plaintext is resolved,
 * it registers here; every logging/artifact sink must pass its output through
 * this registry before anything is persisted or transmitted.
 *
 * Phase 0 ships the registry + string/deep scrubbing. Later phases wire it into
 * HAR post-processing, artifact writers, and LLM prompt builders.
 */
const REDACTED = "«redacted»";

export class RedactionRegistry {
  private secrets: Set<string> = new Set();

  /** Register a resolved secret plaintext. Short strings are ignored (too collision-prone). */
  register(secret: string): void {
    if (typeof secret === "string" && secret.length >= 4) {
      this.secrets.add(secret);
    }
  }

  clear(): void {
    this.secrets.clear();
  }

  get size(): number {
    return this.secrets.size;
  }

  redactString(text: string): string {
    let out = text;
    for (const s of this.secrets) {
      if (out.includes(s)) out = out.split(s).join(REDACTED);
    }
    return out;
  }

  /** Recursively scrub every string in a JSON-ish value. Cycle-safe. */
  redactDeep<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
    if (typeof value === "string") return this.redactString(value) as unknown as T;
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value as object)) return value;
    seen.add(value as object);
    if (Array.isArray(value)) {
      return value.map((v) => this.redactDeep(v, seen)) as unknown as T;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = this.redactDeep(v, seen);
    }
    return out as T;
  }
}

/** Process-wide registry. Runner registers resolved secrets here before any logging. */
export const globalRedaction = new RedactionRegistry();
