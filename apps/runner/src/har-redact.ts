import { readFile, writeFile } from "node:fs/promises";
import type { RedactionRegistry } from "@flowguard/shared";

/**
 * HAR post-processor (doc 07 §4.3): strip request bodies on auth/payment
 * endpoints entirely, then deep-redact every string against the registry.
 * Runs before upload; the stored HAR never contains a registered secret.
 */
const SENSITIVE_URL = /login|logout|auth|token|password|session|payment|stripe|checkout/i;

interface HarLike {
  log?: {
    entries?: Array<{
      request?: {
        url?: string;
        postData?: { text?: string; params?: unknown };
        headers?: Array<{ name: string; value: string }>;
      };
    }>;
  };
}

export function redactHarObject<T extends HarLike>(har: T, registry: RedactionRegistry): T {
  for (const entry of har.log?.entries ?? []) {
    const url = entry.request?.url ?? "";
    if (entry.request?.postData && SENSITIVE_URL.test(url)) {
      entry.request.postData = { text: "«stripped:sensitive-endpoint»" };
    }
    // cookies/session headers travel in the clear inside HARs
    for (const h of entry.request?.headers ?? []) {
      if (/^(cookie|authorization)$/i.test(h.name)) h.value = "«stripped»";
    }
  }
  return registry.redactDeep(har);
}

export async function redactHarFile(path: string, registry: RedactionRegistry): Promise<void> {
  let har: HarLike;
  try {
    har = JSON.parse(await readFile(path, "utf8")) as HarLike;
  } catch {
    return; // absent/invalid HAR — nothing to sanitize
  }
  await writeFile(path, JSON.stringify(redactHarObject(har, registry)));
}
