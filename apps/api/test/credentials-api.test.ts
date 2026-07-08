import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type ApiApp } from "../src/app.js";
import { FakeStore, boundProject, fakeOctokit, makeDeps } from "./fakes.js";

let app: ApiApp;
afterEach(async () => {
  await app?.close();
});

function makeApp(store = new FakeStore()) {
  const { octokit } = fakeOctokit();
  app = buildApp({
    webhookSecret: "s",
    logger: pino({ level: "silent" }),
    deps: makeDeps(store, octokit),
    storeSecret: async (projectId, kind, plaintext) =>
      store.createSecret({
        projectId,
        kind,
        ciphertext: Buffer.from("x"),
        dekWrapped: Buffer.from("y"),
        kmsKeyId: "local:v1",
        last4: plaintext.slice(-4),
      }),
  });
  return { app, store };
}

describe("credentials API", () => {
  it("creates project-scoped credentials (two vault secrets + a set)", async () => {
    const { store } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/prj_1/credentials",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        scope: "project",
        persona: "default",
        username: "default@demo.dev",
        password: "hunter2secret",
      }),
    });
    expect(res.statusCode).toBe(201);
    expect(store.secrets).toHaveLength(2);
    expect(store.credentialSets).toHaveLength(1);
    expect(store.credentialSets[0]).toMatchObject({ scope: "project", persona: "default", prNumber: null });
  });

  it("pr-scoped credentials require a prNumber and default dataBranchDiffers=true", async () => {
    const { store } = makeApp();
    const bad = await app.inject({
      method: "POST",
      url: "/api/projects/prj_1/credentials",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ scope: "pr", persona: "default", username: "u", password: "p" }),
    });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({
      method: "POST",
      url: "/api/projects/prj_1/credentials",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ scope: "pr", prNumber: 7, persona: "default", username: "u", password: "p" }),
    });
    expect(ok.statusCode).toBe(201);
    expect(store.credentialSets[0]).toMatchObject({ prNumber: 7, dataBranchDiffers: true });
  });

  it("lists credentials WITHOUT secret references or values", async () => {
    const { store } = makeApp();
    store.credentialSets.push({
      id: "crd_1",
      projectId: "prj_1",
      scope: "project",
      prNumber: null,
      persona: "default",
      usernameSecretId: "sec_u",
      passwordSecretId: "sec_p",
      dataBranchDiffers: false,
      expiresAt: null,
    });
    const res = await app.inject({ method: "GET", url: "/api/projects/prj_1/credentials" });
    const body = res.json() as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("sec_u");
    expect(JSON.stringify(body)).not.toContain("sec_p");
  });

  it("deletes credential sets", async () => {
    const { store } = makeApp();
    store.credentialSets.push({
      id: "crd_1",
      projectId: "prj_1",
      scope: "project",
      prNumber: null,
      persona: "default",
      usernameSecretId: "sec_u",
      passwordSecretId: "sec_p",
      dataBranchDiffers: false,
      expiresAt: null,
    });
    expect((await app.inject({ method: "DELETE", url: "/api/credentials/crd_1" })).statusCode).toBe(200);
    expect(store.credentialSets).toHaveLength(0);
    expect((await app.inject({ method: "DELETE", url: "/api/credentials/crd_1" })).statusCode).toBe(404);
  });

  it("serves projects and run listings for the dashboard", async () => {
    const store = new FakeStore();
    store.projects.push({ ...boundProject });
    makeApp(store);
    const projects = (await app.inject({ method: "GET", url: "/api/projects" })).json() as unknown[];
    expect(projects).toHaveLength(1);
    expect(JSON.stringify(projects)).not.toContain("vercelTokenRef");
  });
});
