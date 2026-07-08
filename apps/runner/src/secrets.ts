import { eq } from "drizzle-orm";
import { createDb, secrets, type Db } from "@flowguard/db";
import { decryptSecret, globalRedaction, parseMasterKey } from "@flowguard/shared";

/**
 * Vault resolution — RUNNER ONLY (doc 07 §4.2): jobs carry `sec_*` references,
 * plaintext exists only in runner memory during a job. Every resolved plaintext
 * registers with the process-wide redaction registry BEFORE it can be used, so
 * no logging/artifact sink can emit it.
 */
export interface SecretResolver {
  resolve(ref: string): Promise<string>;
}

export class VaultSecretResolver implements SecretResolver {
  private readonly db: Db;
  private readonly masterKey: Buffer;
  private readonly cache = new Map<string, string>();

  constructor(opts?: { databaseUrl?: string; masterKey?: string }) {
    this.db = createDb(opts?.databaseUrl ?? process.env.DATABASE_URL);
    const keyMaterial = opts?.masterKey ?? process.env.FLOWGUARD_MASTER_KEY;
    if (!keyMaterial) throw new Error("FLOWGUARD_MASTER_KEY is required to resolve secrets");
    this.masterKey = parseMasterKey(keyMaterial);
  }

  async resolve(ref: string): Promise<string> {
    const cached = this.cache.get(ref);
    if (cached !== undefined) return cached;
    const rows = await this.db.select().from(secrets).where(eq(secrets.id, ref)).limit(1);
    const row = rows[0];
    if (!row) throw new Error(`secret not found: ${ref}`);
    const plaintext = decryptSecret(
      { ciphertext: row.ciphertext, dekWrapped: row.dekWrapped },
      this.masterKey,
    );
    globalRedaction.register(plaintext); // before ANY use (doc 07 §4.3)
    this.cache.set(ref, plaintext);
    return plaintext;
  }
}

/** Hermetic tests: fixed ref→plaintext map, still registers for redaction. */
export class StaticSecretResolver implements SecretResolver {
  constructor(private readonly table: Record<string, string>) {}
  async resolve(ref: string): Promise<string> {
    const v = this.table[ref];
    if (v === undefined) throw new Error(`secret not found: ${ref}`);
    globalRedaction.register(v);
    return v;
  }
}

export const SECRET_PLACEHOLDER = /\{\{secret:([a-zA-Z0-9_.-]+)\}\}/g;

export function findSecretPlaceholders(value: string): string[] {
  return [...value.matchAll(SECRET_PLACEHOLDER)].map((m) => m[1]!);
}

/** Does any type-action in the spec use secrets? (disables tracing, doc 04 §3) */
export function specUsesSecrets(spec: { steps: Array<{ action: { type: string; value?: string } }> }): boolean {
  return spec.steps.some(
    (s) => s.action.type === "type" && s.action.value !== undefined && findSecretPlaceholders(s.action.value).length > 0,
  );
}
