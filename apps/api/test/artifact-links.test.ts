import { createHmac } from "node:crypto";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { parseMasterKey } from "@flowguard/shared";
import { artifactLinkBuilder, signArtifactKey, verifyArtifactSig } from "../src/orchestrator/artifact-links.js";
import { buildApp, type ApiApp } from "../src/app.js";
import { FakeStore, fakeOctokit, makeDeps } from "./fakes.js";

const master = parseMasterKey("c".repeat(64));

describe("artifact link signing", () => {
  it("round-trips sign → verify", () => {
    const key = "runs/run_1/flw_rip/head/video.webm";
    const sig = signArtifactKey(key, master);
    expect(verifyArtifactSig(key, sig, master)).toBe(true);
  });

  it("rejects tampered keys and signatures", () => {
    const key = "runs/run_1/flw_rip/head/video.webm";
    const sig = signArtifactKey(key, master);
    expect(verifyArtifactSig("runs/run_1/flw_rip/head/trace.zip", sig, master)).toBe(false);
    expect(verifyArtifactSig(key, sig.replace(/./, "0"), master)).toBe(false);
    expect(verifyArtifactSig(key, "short", master)).toBe(false);
  });

  it("builds markdown links carrying the signature", () => {
    const link = artifactLinkBuilder("https://api.example.com", master);
    const md = link("runs/a/b/head/video.webm", "video");
    expect(md).toMatch(/^\[video\]\(https:\/\/api\.example\.com\/artifacts\?key=.*&sig=[0-9a-f]{32}\)$/);
  });
});

describe("GET /artifacts", () => {
  let app: ApiApp;
  afterEach(async () => {
    await app?.close();
  });

  function makeApp() {
    const { octokit } = fakeOctokit();
    app = buildApp({
      webhookSecret: "s",
      logger: pino({ level: "silent" }),
      deps: makeDeps(new FakeStore(), octokit),
      artifacts: {
        verifySig: (key, sig) => verifyArtifactSig(key, sig, master),
        presign: async (key) => `https://minio.local/presigned/${encodeURIComponent(key)}`,
      },
    });
    return app;
  }

  it("302s to a presigned URL for a valid signature", async () => {
    makeApp();
    const key = "runs/run_1/flw_rip/head/video.webm";
    const res = await app.inject({
      method: "GET",
      url: `/artifacts?key=${encodeURIComponent(key)}&sig=${signArtifactKey(key, master)}`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("presigned");
  });

  it("403s on bad or missing signatures", async () => {
    makeApp();
    const key = "runs/run_1/flw_rip/head/video.webm";
    expect(
      (await app.inject({ method: "GET", url: `/artifacts?key=${encodeURIComponent(key)}&sig=${"0".repeat(32)}` }))
        .statusCode,
    ).toBe(403);
    expect((await app.inject({ method: "GET", url: `/artifacts?key=${encodeURIComponent(key)}` })).statusCode).toBe(403);
  });
});

// keep the HMAC primitive honest
describe("signArtifactKey", () => {
  it("is a truncated HMAC-SHA256 over a domain-separated message", () => {
    const key = "runs/x";
    const expected = createHmac("sha256", master).update(`artifact:${key}`).digest("hex").slice(0, 32);
    expect(signArtifactKey(key, master)).toBe(expected);
  });
});
