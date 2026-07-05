/**
 * The sticky PR comment (doc 05 §6): ONE comment per PR, edited in place on every
 * run, found via a hidden HTML marker. Never a new comment per push.
 */
export const STICKY_MARKER = "<!-- flowguard:pr-summary -->";

export interface StickyTarget {
  owner: string;
  repo: string;
  prNumber: number;
}

/** Narrow slice of octokit.rest.issues — injectable for tests. */
export interface IssuesApi {
  listComments(params: {
    owner: string;
    repo: string;
    issue_number: number;
    per_page?: number;
  }): Promise<{ data: Array<{ id: number; body?: string | null }> }>;
  createComment(params: {
    owner: string;
    repo: string;
    issue_number: number;
    body: string;
  }): Promise<{ data: { id: number } }>;
  updateComment(params: {
    owner: string;
    repo: string;
    comment_id: number;
    body: string;
  }): Promise<{ data: { id: number } }>;
}

export interface UpsertResult {
  commentId: number;
  created: boolean;
}

/**
 * Create-or-edit the sticky comment. `knownCommentId` (from pull_requests.sticky_comment_id)
 * skips the list call; a stale id falls back to find-or-create.
 */
export async function upsertStickyComment(
  api: IssuesApi,
  target: StickyTarget,
  body: string,
  knownCommentId?: number | null,
): Promise<UpsertResult> {
  const fullBody = `${STICKY_MARKER}\n${body}`;
  const base = { owner: target.owner, repo: target.repo };

  if (knownCommentId) {
    try {
      await api.updateComment({ ...base, comment_id: knownCommentId, body: fullBody });
      return { commentId: knownCommentId, created: false };
    } catch {
      // stale id (comment deleted) — fall through to find-or-create
    }
  }

  const { data: comments } = await api.listComments({
    ...base,
    issue_number: target.prNumber,
    per_page: 100,
  });
  const existing = comments.find((c) => c.body?.includes(STICKY_MARKER));
  if (existing) {
    await api.updateComment({ ...base, comment_id: existing.id, body: fullBody });
    return { commentId: existing.id, created: false };
  }

  const { data } = await api.createComment({
    ...base,
    issue_number: target.prNumber,
    body: fullBody,
  });
  return { commentId: data.id, created: true };
}
