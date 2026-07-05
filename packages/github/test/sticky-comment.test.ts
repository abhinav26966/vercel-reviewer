import { describe, expect, it } from "vitest";
import { STICKY_MARKER, upsertStickyComment, type IssuesApi } from "../src/sticky-comment.js";

/** In-memory fake of the issues API. */
function fakeIssuesApi(initial: Array<{ id: number; body: string }> = []) {
  const comments = [...initial];
  let nextId = 1000;
  const calls: string[] = [];
  const api: IssuesApi = {
    async listComments() {
      calls.push("list");
      return { data: comments.map((c) => ({ ...c })) };
    },
    async createComment({ body }) {
      calls.push("create");
      const c = { id: nextId++, body };
      comments.push(c);
      return { data: { id: c.id } };
    },
    async updateComment({ comment_id, body }) {
      calls.push("update");
      const c = comments.find((x) => x.id === comment_id);
      if (!c) throw new Error("404 comment not found");
      c.body = body;
      return { data: { id: comment_id } };
    },
  };
  return { api, comments, calls };
}

const target = { owner: "o", repo: "r", prNumber: 7 };

describe("upsertStickyComment", () => {
  it("creates exactly one marked comment on first call", async () => {
    const { api, comments } = fakeIssuesApi();
    const res = await upsertStickyComment(api, target, "hello");
    expect(res.created).toBe(true);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain(STICKY_MARKER);
    expect(comments[0]!.body).toContain("hello");
  });

  it("edits in place on subsequent calls — never a second comment", async () => {
    const { api, comments } = fakeIssuesApi();
    const first = await upsertStickyComment(api, target, "push #1");
    const second = await upsertStickyComment(api, target, "push #2");
    expect(second.created).toBe(false);
    expect(second.commentId).toBe(first.commentId);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("push #2");
  });

  it("uses a known comment id without listing", async () => {
    const { api, calls } = fakeIssuesApi([{ id: 42, body: `${STICKY_MARKER}\nold` }]);
    const res = await upsertStickyComment(api, target, "new", 42);
    expect(res).toEqual({ commentId: 42, created: false });
    expect(calls).toEqual(["update"]);
  });

  it("recovers from a stale known id (deleted comment) via find-or-create", async () => {
    const { api, comments } = fakeIssuesApi();
    const res = await upsertStickyComment(api, target, "recovered", 9999);
    expect(res.created).toBe(true);
    expect(comments).toHaveLength(1);
  });

  it("ignores unmarked comments from other bots/humans", async () => {
    const { api, comments } = fakeIssuesApi([{ id: 1, body: "LGTM!" }]);
    const res = await upsertStickyComment(api, target, "hello");
    expect(res.created).toBe(true);
    expect(comments).toHaveLength(2);
  });
});
