// Bundles the outreach background function into netlify/functions/outreach-background.mjs (one self-contained file).
// Run by `npm run build:netlify` before `next build`; Netlify then deploys it as a background function (name suffix + netlify.toml).
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shim = (f) => path.join(root, "netlify/background-src/shims", f);
const SHIMS = { "server-only": shim("empty.ts"), "next/headers": shim("next-headers.ts"), "next/server": shim("next-server.ts") };

export async function buildBackground({ outfile = path.join(root, "netlify/functions/outreach-background.mjs"), metafile = false } = {}) {
  mkdirSync(path.dirname(outfile), { recursive: true });
  return build({
    entryPoints: [path.join(root, "netlify/background-src/outreach-background.ts")],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    tsconfig: path.join(root, "tsconfig.json"), // resolves the app's "@/..." imports
    logLevel: "warning",
    metafile,
    // CommonJS dependencies (web-push, google clients) call require(); give the ESM bundle one.
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
    plugins: [
      {
        name: "background-shims",
        setup(b) {
          b.onResolve({ filter: /^(server-only|next\/headers|next\/server)$/ }, (a) => ({ path: SHIMS[a.path] }));
        },
      },
    ],
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildBackground();
  console.log("built netlify/functions/outreach-background.mjs");
}
