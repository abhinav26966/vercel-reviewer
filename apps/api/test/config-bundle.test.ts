import { describe, expect, it } from "vitest";
import { FlowSpecSchema, type FlowSpec } from "@flowguard/schemas";
import {
  buildConfigBundle,
  MissingCredentialsError,
  personasUsedBySpec,
} from "../src/orchestrator/config-bundle.js";
import { FakeStore } from "./fakes.js";

const loginSpec: FlowSpec = FlowSpecSchema.parse({
  specVersion: 3,
  flowId: "flw_login",
  projectId: "prj_1",
  name: "Login",
  startPath: "/login",
  steps: [
    {
      id: "s1",
      title: "user",
      action: {
        type: "type",
        locators: [
          { kind: "testid", value: "email-input" },
          { kind: "css", value: "input" },
        ],
        value: "{{secret:default.username}}",
      },
      settle: { strategy: "timeout", timeoutMs: 50 },
    },
  ],
});

const authedSpec: FlowSpec = FlowSpecSchema.parse({
  specVersion: 3,
  flowId: "flw_inventory",
  projectId: "prj_1",
  name: "Inventory",
  persona: "default",
  startPath: "/inventory",
  steps: [
    {
      id: "s1",
      title: "nav",
      action: { type: "navigate", path: "/inventory" },
      settle: { strategy: "networkidle", timeoutMs: 5000 },
    },
  ],
});

function storeWith(sets: Array<{ scope: "project" | "pr"; prNumber?: number; dataBranchDiffers?: boolean }>) {
  const store = new FakeStore();
  for (const [i, s] of sets.entries()) {
    store.credentialSets.push({
      id: `crd_${i}`,
      projectId: "prj_1",
      scope: s.scope,
      prNumber: s.prNumber ?? null,
      persona: "default",
      usernameSecretId: `sec_u_${s.scope}`,
      passwordSecretId: `sec_p_${s.scope}`,
      dataBranchDiffers: s.dataBranchDiffers ?? false,
      expiresAt: null,
    });
  }
  return store;
}

describe("personasUsedBySpec", () => {
  it("collects the spec persona and placeholder personas", () => {
    expect(personasUsedBySpec(authedSpec)).toEqual(["default"]);
    expect(personasUsedBySpec(loginSpec)).toEqual(["default"]);
  });
});

describe("buildConfigBundle — per-target resolution (doc 07 §3)", () => {
  it("head: PR scope wins over project defaults, dataBranchDiffers inferred", async () => {
    const store = storeWith([{ scope: "project" }, { scope: "pr", prNumber: 7 }]);
    const bundle = await buildConfigBundle(
      { store, projectId: "prj_1", prNumber: 7, deploymentId: "dep_1", loginSpec },
      authedSpec,
    );
    expect(bundle.persona?.usernameRef).toBe("sec_u_pr");
    expect(bundle.dataBranchDiffers).toBe(true);
    expect(bundle.secretRefs["default.password"]).toBe("sec_p_pr");
    expect(bundle.persona?.loginSpec?.flowId).toBe("flw_login");
  });

  it("head without PR-scoped credentials falls back to project defaults", async () => {
    const store = storeWith([{ scope: "project" }]);
    const bundle = await buildConfigBundle(
      { store, projectId: "prj_1", prNumber: 7, deploymentId: "dep_1", loginSpec },
      authedSpec,
    );
    expect(bundle.persona?.usernameRef).toBe("sec_u_project");
    expect(bundle.dataBranchDiffers).toBe(false);
  });

  it("base: project defaults ALWAYS, even when PR-scoped credentials exist", async () => {
    const store = storeWith([{ scope: "project" }, { scope: "pr", prNumber: 7 }]);
    const bundle = await buildConfigBundle(
      { store, projectId: "prj_1", prNumber: null, deploymentId: "dep_base", loginSpec },
      authedSpec,
    );
    expect(bundle.persona?.usernameRef).toBe("sec_u_project");
    expect(bundle.dataBranchDiffers).toBe(false);
  });

  it("user-flagged dataBranchDiffers propagates from project scope", async () => {
    const store = storeWith([{ scope: "project", dataBranchDiffers: true }]);
    const bundle = await buildConfigBundle(
      { store, projectId: "prj_1", prNumber: null, deploymentId: null, loginSpec },
      authedSpec,
    );
    expect(bundle.dataBranchDiffers).toBe(true);
  });

  it("cached storageState key is attached when a session exists for the deployment", async () => {
    const store = storeWith([{ scope: "project" }]);
    store.sessionKeys.set("default:dep_1", "ss/prj_1/default/dep_1.json");
    const bundle = await buildConfigBundle(
      { store, projectId: "prj_1", prNumber: null, deploymentId: "dep_1", loginSpec },
      authedSpec,
    );
    expect(bundle.persona?.storageStateKey).toBe("ss/prj_1/default/dep_1.json");
  });

  it("throws MissingCredentialsError when no set matches", async () => {
    const store = storeWith([]);
    await expect(
      buildConfigBundle({ store, projectId: "prj_1", prNumber: 7, deploymentId: null, loginSpec }, authedSpec),
    ).rejects.toBeInstanceOf(MissingCredentialsError);
  });

  it("expired PR-scoped credentials are skipped (PR close hygiene)", async () => {
    const store = storeWith([{ scope: "project" }, { scope: "pr", prNumber: 7 }]);
    await store.expirePrScopedCredentials("prj_1", 7);
    const bundle = await buildConfigBundle(
      { store, projectId: "prj_1", prNumber: 7, deploymentId: null, loginSpec },
      authedSpec,
    );
    expect(bundle.persona?.usernameRef).toBe("sec_u_project");
  });
});
