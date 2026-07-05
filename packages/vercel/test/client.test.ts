import { describe, expect, it, vi } from "vitest";
import { VercelClient } from "../src/client.js";

function fakeFetch(handler: (url: URL) => { status: number; body: unknown }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const { status, body } = handler(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("VercelClient", () => {
  it("gets a deployment by URL, stripping the protocol and sending auth + teamId", async () => {
    const fetchImpl = fakeFetch((url) => {
      expect(url.pathname).toBe("/v13/deployments/demo-abc123.vercel.app");
      expect(url.searchParams.get("teamId")).toBe("team_1");
      return {
        status: 200,
        body: {
          uid: "dpl_1",
          url: "demo-abc123.vercel.app",
          name: "demo",
          readyState: "READY",
          target: null,
          projectId: "prj_vercel_1",
          createdAt: 1,
        },
      };
    });
    const client = new VercelClient({ token: "tok", teamId: "team_1", fetchImpl });
    const d = await client.getDeployment("https://demo-abc123.vercel.app");
    expect(d.state).toBe("READY");
    expect(d.projectId).toBe("prj_vercel_1");
  });

  it("lists deployments filtered by project and sha", async () => {
    const fetchImpl = fakeFetch((url) => {
      expect(url.pathname).toBe("/v6/deployments");
      expect(url.searchParams.get("projectId")).toBe("prj_vercel_1");
      expect(url.searchParams.get("sha")).toBe("abc123");
      return {
        status: 200,
        body: {
          deployments: [
            { uid: "dpl_1", url: "a.vercel.app", name: "demo", readyState: "READY", createdAt: 1 },
          ],
        },
      };
    });
    const client = new VercelClient({ token: "tok", fetchImpl });
    const list = await client.listDeployments({ projectId: "prj_vercel_1", sha: "abc123" });
    expect(list).toHaveLength(1);
    expect(list[0]!.state).toBe("READY");
  });

  it("verifies deployment↔project binding and fails closed on errors", async () => {
    const ok = new VercelClient({
      token: "tok",
      fetchImpl: fakeFetch(() => ({
        status: 200,
        body: { uid: "d", url: "u", name: "n", readyState: "READY", projectId: "prj_A", createdAt: 1 },
      })),
    });
    expect(await ok.deploymentBelongsToProject("u.vercel.app", "prj_A")).toBe(true);
    expect(await ok.deploymentBelongsToProject("u.vercel.app", "prj_B")).toBe(false);

    const broken = new VercelClient({
      token: "tok",
      fetchImpl: fakeFetch(() => ({ status: 500, body: {} })),
    });
    expect(await broken.deploymentBelongsToProject("u.vercel.app", "prj_A")).toBe(false);
  });

  it("throws a typed env_issue error on API failure", async () => {
    const client = new VercelClient({
      token: "tok",
      fetchImpl: fakeFetch(() => ({ status: 403, body: { error: "forbidden" } })),
    });
    await expect(client.getDeployment("x.vercel.app")).rejects.toMatchObject({
      code: "env_issue",
    });
  });
});
