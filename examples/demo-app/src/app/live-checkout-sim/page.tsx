/**
 * Chaos page (CHECKOUT_LIVE_SIM=1): mimics a checkout surface that carries
 * LIVE-mode markers. FlowGuard's live-mode guard must refuse to fill anything
 * here — this page exists to prove that, without touching real live keys.
 */
export default function LiveCheckoutSimPage() {
  return (
    <main>
      <h1>Checkout</h1>
      {/* a live publishable key marker — the guard treats this as LIVE */}
      <script dangerouslySetInnerHTML={{ __html: `window.__pk = "pk_live_SIMULATEDDONOTUSE00000000";` }} />
      {/* a stripe-hosted frame so the payment surface is "present" */}
      <iframe title="stripe" src="https://js.stripe.com/v3/controller.html" style={{ display: "none" }} />
      <form>
        <input name="cardNumber" placeholder="1234 1234 1234 1234" />
        <input name="cardExpiry" placeholder="MM / YY" />
        <input name="cardCvc" placeholder="CVC" />
        <button type="submit">Pay</button>
      </form>
    </main>
  );
}
