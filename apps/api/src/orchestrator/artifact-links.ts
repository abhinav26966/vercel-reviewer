import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC-signed artifact links (doc 05 §6: "link artifacts via short-lived presigned
 * URLs through an auth redirect"). The comment carries a stable signed api URL;
 * GET /artifacts verifies the signature and 302s to a fresh presigned S3 URL.
 * Real org-level auth arrives in Phase 13.
 */
export function signArtifactKey(s3Key: string, masterKey: Buffer): string {
  return createHmac("sha256", masterKey).update(`artifact:${s3Key}`).digest("hex").slice(0, 32);
}

export function verifyArtifactSig(s3Key: string, sig: string, masterKey: Buffer): boolean {
  const expected = signArtifactKey(s3Key, masterKey);
  if (sig.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(sig, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}

export function artifactLinkBuilder(publicApiUrl: string, masterKey: Buffer) {
  return (s3Key: string, label: string): string => {
    const sig = signArtifactKey(s3Key, masterKey);
    const url = `${publicApiUrl}/artifacts?key=${encodeURIComponent(s3Key)}&sig=${sig}`;
    return `[${label}](${url})`;
  };
}
