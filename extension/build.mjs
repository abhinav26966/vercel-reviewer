import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });

await build({
  entryPoints: ["src/content.ts", "src/background.ts", "src/popup.ts"],
  bundle: true,
  outdir: "dist",
  format: "esm",
  target: "chrome120",
  minify: false,
  sourcemap: false,
});

await cp("manifest.json", "dist/manifest.json");
await cp("src/popup.html", "dist/popup.html");
console.log("extension built → extension/dist");
