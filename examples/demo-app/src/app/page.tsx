import Link from "next/link";

export default function HomePage() {
  return (
    <main>
      <h1>PackDemo</h1>
      <p className="muted">
        The permanent FlowGuard test target (phase-1 webhook test): email/password login, a shop with Stripe test-mode
        checkout, an inventory, and a WebGL pack-opening scene.
      </p>
      <p>
        <Link className="btn" href="/login">
          Get started — log in
        </Link>
      </p>
      <div className="grid">
        <div className="card">
          <h3>Chaos flags</h3>
          <p className="muted">
            <code>/shop?slow=1</code> — 1.8s latency on buy
            <br />
            <code>/open?break=rip</code> — pack opening 500s
            <br />
            <code>/inventory?blank=1</code> — blank page
          </p>
        </div>
        <div className="card">
          <h3>Seeded users</h3>
          <p className="muted">
            default@demo.dev
            <br />
            premium@demo.dev
          </p>
        </div>
      </div>
    </main>
  );
}
