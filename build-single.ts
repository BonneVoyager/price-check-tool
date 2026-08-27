/**
 * Build a single self-contained index.html — for GitHub Pages, or for opening
 * straight off the filesystem.
 *
 * The normal build emits public/index.html + public/app.js, which needs a real
 * HTTP server: `<script type="module">` obeys CORS, so an ES module import
 * fails from a `file://` page. Inlining the bundle removes both the second
 * request and that restriction.
 *
 * Two things have to change when inlining, or the page silently does nothing:
 *
 *  1. `import { OO } from "./app.js"` must go — there is no module to import
 *     from once the code is in the same file. The bundle already assigns
 *     `window.OO`, so the page reads that instead.
 *  2. The bundle's trailing `export{...}` must go. An `export` outside a module
 *     is a syntax error, and a plain `<script>` is not a module.
 *
 * Output: dist/index.html, plus a .nojekyll so GitHub Pages doesn't run Jekyll
 * over it (harmless here, but it would strip any future underscore-prefixed
 * file, and it costs nothing to be explicit).
 *
 *   bun run build:single
 */

const OUT_DIR = new URL("./dist/", import.meta.url);
const SRC_HTML = new URL("./public/index.html", import.meta.url);

// 1. Bundle the browser entry to a string rather than a file.
const built = await Bun.build({
  entrypoints: ["src/browser.ts"],
  target: "browser",
  minify: true,
});

if (!built.success) {
  console.error("Bundle failed:");
  for (const log of built.logs) console.error(" ", log.message);
  process.exit(1);
}

const jsArtifact = built.outputs.find((o) => o.kind === "entry-point");
if (!jsArtifact) {
  console.error("No entry-point artifact produced.");
  process.exit(1);
}
let js = await jsArtifact.text();

// 2. Strip the trailing ES export — illegal in a non-module <script>.
//    `window.OO = …` earlier in the bundle is what the page actually uses.
const exportRe = /export\s*\{[^}]*\}\s*;?\s*$/;
if (!exportRe.test(js.trim())) {
  console.warn(
    "  ! No trailing export{...} found — bundle shape changed; check the page still boots.",
  );
}
js = js.trim().replace(exportRe, "");

// 3. Swap the module script for an inline classic script.
const html = await Bun.file(SRC_HTML).text();

const MODULE_OPEN =
  /<!--[\s\S]*?-->\s*<script type="module">\s*\nimport \{ OO \} from "\.\/app\.js";/;
if (!MODULE_OPEN.test(html)) {
  console.error(
    "Could not find the module <script> + import of ./app.js in public/index.html.\n" +
      "The single-file build rewrites that specific shape; update this script if it moved.",
  );
  process.exit(1);
}

// A replacement FUNCTION, not a string: String.replace expands `$&`, `$1`,
// "$`" etc. inside a string replacement, and a minified bundle can legitimately
// contain those sequences (a `$&` in a regex literal is enough). As a string
// this silently re-injected the matched `import … "./app.js"` line into the
// output — which the sanity check below then caught. A function receives the
// replacement verbatim, so there is nothing to expand.
const single = html.replace(
  MODULE_OPEN,
  () =>
    `<script>\n/* --- inlined bundle (bun build) --- */\n${js}\n/* --- app --- */\nconst OO = window.OO;`,
);

// Sanity: nothing should still point at the sibling file.
if (/["']\.\/app\.js["']/.test(single)) {
  console.error("Output still references ./app.js — inlining did not take.");
  process.exit(1);
}

await Bun.write(new URL("index.html", OUT_DIR), single);
// GitHub Pages runs Jekyll by default; opt out explicitly.
await Bun.write(new URL(".nojekyll", OUT_DIR), "");

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
console.log(`\n  dist/index.html  ${kb(single.length)}  (single file, no deps)`);
console.log(`  dist/.nojekyll\n`);
console.log("  Open it directly, or publish dist/ to GitHub Pages.\n");
