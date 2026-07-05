/** Seeded demo users (doc 09 Phase 0). Password via DEMO_PASSWORD env, default demo1234. */
export const SEEDED_USERS = [
  { email: "default@demo.dev", persona: "default" },
  { email: "premium@demo.dev", persona: "premium_user" },
] as const;

export function checkCredentials(email: string, password: string): boolean {
  const expected = process.env.DEMO_PASSWORD ?? "demo1234";
  return password === expected && SEEDED_USERS.some((u) => u.email === email);
}
