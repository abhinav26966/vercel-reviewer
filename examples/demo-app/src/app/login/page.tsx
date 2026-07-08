export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main>
      <h1>Log in</h1>
      <form className="stack" action="/api/login" method="POST">
        <input
          type="email"
          name="email"
          placeholder="Email"
          aria-label="Email"
          data-testid="email-input"
          required
        />
        <input
          type="password"
          name="password"
          placeholder="Password"
          aria-label="Password"
          data-testid="password-input"
          required
        />
        <button type="submit" data-testid="login-submit">
          Log in
        </button>
      </form>
      {error ? (
        <p className="error" data-testid="login-error">
          Invalid email or password.
        </p>
      ) : null}
      <p className="muted">Try default@demo.dev (password: see project setup)</p>
    </main>
  );
}
