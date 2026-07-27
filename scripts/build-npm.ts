/**
 * Builds a real npm package from the Deno-flavoured source.
 *
 * The SDK itself uses no Deno APIs, so the only thing standing between it and
 * npm is the `.ts` import extensions. dnt rewrites those and emits ESM + CJS
 * with `.d.ts` declarations, so the published package is an ordinary npm
 * package with no Deno dependency at install or run time.
 *
 * Run: deno task build:npm [version]
 * Output: ./npm, publishable with `npm publish ./npm`.
 */

import { build, emptyDir } from "@deno/dnt";

const denoConfig = JSON.parse(await Deno.readTextFile("deno.json"));
const version = Deno.args[0] ?? denoConfig.version;

await emptyDir("./npm");

await build({
  entryPoints: ["./src/mod.ts"],
  outDir: "./npm",
  // The SDK targets web-standard fetch; Node 18+ has it natively, so none of
  // dnt's shims are needed. Keeping this off guarantees no polyfill sneaks in
  // and the package stays dependency-free.
  shims: {},
  test: false,
  typeCheck: "both",
  // The SDK is typed against web standards (fetch, Response, AbortSignal,
  // FormData, Blob), all of which Node 18+ provides natively. Without shims
  // dnt would otherwise compile against a lib set that omits them.
  compilerOptions: {
    lib: ["ES2022", "DOM", "DOM.Iterable"],
    target: "ES2022",
  },
  package: {
    name: "@zweiundeins/cashctrl-ts-sdk",
    version,
    description:
      "Typed TypeScript client for the CashCtrl accounting API, covering all " +
      "376 endpoints. Generated from the published reference, with an " +
      "OpenAPI 3.1 spec.",
    keywords: [
      "cashctrl",
      "accounting",
      "erp",
      "api",
      "sdk",
      "openapi",
      "switzerland",
      "buchhaltung",
    ],
    license: "MIT",
    engines: { node: ">=18" },
    repository: {
      type: "git",
      url: "git+https://github.com/zweiundeins/cashctrl-ts-sdk.git",
    },
    bugs: {
      url: "https://github.com/zweiundeins/cashctrl-ts-sdk/issues",
    },
    homepage: "https://github.com/zweiundeins/cashctrl-ts-sdk#readme",
  },
  async postBuild() {
    await Deno.copyFile("LICENSE", "npm/LICENSE");
    await Deno.copyFile("README.md", "npm/README.md");
  },
});

console.log(`\nbuilt npm package v${version} in ./npm`);
console.log("publish with: npm publish ./npm --access public");
