/**
 * Phase 11 AC: splice a hosted-checkout hop into the REAL Phase 5 recording
 * so the compiler's payment detection runs against a genuine trace, then
 * upload + compile through the normal product path.
 */
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const s3 = new S3Client({
  endpoint: "http://localhost:9000",
  region: "us-east-1",
  credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
  forcePathStyle: true,
});

const res = await s3.send(
  new GetObjectCommand({ Bucket: "flowguard-recordings", Key: "recordings/rec_mkc6y6m0ljd40f/bundle.zip" }),
);
const files = unzipSync(Buffer.from(await res.Body!.transformToByteArray()));
const trace = JSON.parse(strFromU8(files["trace.json"]!)) as {
  events: Array<{ id: string; ts: number; type: string; url: string; network?: unknown[] } & Record<string, unknown>>;
};

const buyIdx = trace.events.findIndex(
  (e) => e.type === "click" && JSON.stringify(e).includes("buy-pack-btn"),
);
if (buyIdx === -1) throw new Error("buy click not found in trace");
const buy = trace.events[buyIdx]!;
console.log("buy click:", buy.id, "at ts", buy.ts);

// drop the direct success navigations that followed the mock-mode buy
let after = buyIdx + 1;
while (after < trace.events.length && trace.events[after]!.type === "navigation" && String(trace.events[after]!.url).includes("/shop/success")) {
  after++;
}
const removed = after - (buyIdx + 1);

const stripeUrl = "https://checkout.stripe.com/c/pay/cs_test_spliced0000000001";
const mk = (id: string, ts: number, type: string, rest: Record<string, unknown> = {}) => ({
  id,
  ts,
  type,
  url: stripeUrl,
  target: null,
  value: null,
  screenshotBefore: null,
  screenshotAfter: null,
  domSnapshotAfter: null,
  network: [],
  ...rest,
});
const t0 = Number(buy.ts);
trace.events.splice(
  buyIdx + 1,
  removed,
  mk("sp1", t0 + 400, "navigation"),
  mk("sp2", t0 + 3000, "input", {
    target: {
      tag: "input",
      locators: [{ kind: "css", value: "[name=cardNumber]" }, { kind: "css", value: "#cardNumber" }],
      a11y: { role: "textbox", name: "Card number", path: [] },
      boundingBox: { x: 0, y: 0, w: 10, h: 10 },
      isCanvas: false,
      canvasRelative: null,
    },
    value: "4242 4242 4242 4242",
  }),
  mk("sp3", t0 + 4000, "click", {
    target: {
      tag: "button",
      locators: [{ kind: "css", value: ".SubmitButton" }, { kind: "text", value: "Pay" }],
      a11y: { role: "button", name: "Pay", path: [] },
      boundingBox: { x: 0, y: 0, w: 10, h: 10 },
      isCanvas: false,
      canvasRelative: null,
    },
  }),
  { ...mk("sp4", t0 + 6000, "navigation"), url: buy.url.replace("/shop", "/shop/success").replace("/success/success", "/success") },
);
console.log(`spliced stripe hop (replaced ${removed} direct success navs)`);

files["trace.json"] = strToU8(JSON.stringify(trace));
const bundle = zipSync(files);

const form = new FormData();
form.set("projectId", "prj_862ymcrku4xal4");
form.set("flowName", "Buy & Rip Open a Pack (recorded)");
form.set("bundle", new Blob([Buffer.from(bundle)], { type: "application/zip" }), "bundle.zip");
const upload = await fetch("http://localhost:8787/api/recordings", {
  method: "POST",
  headers: { authorization: "Bearer local-dev" },
  body: form,
});
console.log("upload:", upload.status, await upload.text());
