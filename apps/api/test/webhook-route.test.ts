import { createHmac } from "node:crypto";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type ApiApp } from "../src/app.js";
import { FakeStore, fakeOctokit, makeDeps } from "./fakes.js";

const SECRET = "wh_secret";
const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

let app: ApiApp;
afterEach(async () => {
  await app?.close();
});

function makeApp(store = new FakeStore()) {
  const { octokit } = fakeOctokit();
  app = buildApp({
    webhookSecret: SECRET,
    logger: pino({ level: "silent" }),
    deps: makeDeps(store, octokit),
  });
  return { app, store };
}

function inject(body: object, headers: Record<string, string> = {}) {
  const raw = JSON.stringify(body);
  return app.inject({
    method: "POST",
    url: "/webhooks/github",
    payload: raw,
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": sign(raw),
      "x-github-event": "installation",
      "x-github-delivery": "delivery-1",
      ...headers,
    },
  });
}

describe("POST /webhooks/github", () => {
  it("rejects unsigned and mis-signed requests with 401", async () => {
    makeApp();
    const raw = JSON.stringify({ action: "created" });
    const noSig = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: raw,
      headers: { "content-type": "application/json", "x-github-event": "ping", "x-github-delivery": "d" },
    });
    expect(noSig.statusCode).toBe(401);

    const badSig = await inject({ action: "created" }, { "x-hub-signature-256": "sha256=" + "0".repeat(64) });
    expect(badSig.statusCode).toBe(401);
  });

  it("accepts a valid signature and processes the event", async () => {
    const { store } = makeApp();
    const res = await inject({
      action: "created",
      installation: { id: 99, account: { login: "founder" } },
    });
    expect(res.statusCode).toBe(202);
    expect(store.installations.get(99)).toBe("founder");
  });

  it("skips duplicate deliveries (idempotency on delivery id)", async () => {
    const { store } = makeApp();
    await inject({ action: "created", installation: { id: 99, account: { login: "a" } } });
    // same delivery id, different payload — must NOT be processed
    const res = await inject({ action: "deleted", installation: { id: 99, account: { login: "a" } } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ duplicate: true });
    expect(store.installations.get(99)).toBe("a");
  });

  it("never bounces on handler errors (GitHub would retry side effects)", async () => {
    const store = new FakeStore();
    store.getProjectByRepo = async () => {
      throw new Error("db exploded");
    };
    makeApp(store);
    const res = await inject(
      { action: "created", deployment_status: { state: "success" }, deployment: {}, repository: { full_name: "x/y" } },
      { "x-github-event": "deployment_status", "x-github-delivery": "d2" },
    );
    expect(res.statusCode).toBe(202);
  });

  it("responds to /healthz", async () => {
    makeApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });
});
