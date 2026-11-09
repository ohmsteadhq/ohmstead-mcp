// Bundle the server (and the app's shared lib code it imports via "@/") into dist/.
import { build } from "esbuild";
import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Embed snapshots use the print markup but never make a PDF. The wasm and fonts ship inside the file.
const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const shared = { alias: { "@": here("../src"), jspdf: here("src/pdf-stub.ts"), "svg2pdf.js": here("src/pdf-stub.ts") }, loader: { ".wasm": "binary", ".ttf": "binary" } };

await build({
  entryPoints: ["src/stdio.ts"],
  outfile: "dist/stdio.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  ...shared,
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
});
chmodSync("dist/stdio.js", 0o755);

// The same server with its npm packages inlined: one file that runs on any machine with Node 20+,
// for installing elsewhere without the repo (zip, or the `ohmstead` npm package's `npx ohmstead mcp`).
const bundled = await build({
  entryPoints: ["src/stdio.ts"],
  outfile: "dist/ohmstead-mcp.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  ...shared,
  // Some bundled CommonJS packages call require(); give the ESM bundle one.
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
  metafile: true,
});
chmodSync("dist/ohmstead-mcp.mjs", 0o755);

// The bundle inlines third-party packages; their licenses require shipping their notices with it.
const pkgs = new Map();
for (const input of Object.keys(bundled.metafile.inputs)) {
  const m = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
  if (m) pkgs.set(m[1].replace(/^.*node_modules\//, ""), m[1]);
}
const notices = [...pkgs].sort(([a], [b]) => a.localeCompare(b)).map(([name, dir]) => {
  const { version, license, repository } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying|notice)/i.test(f));
  const text = file ? readFileSync(join(dir, file), "utf8").trim() : `License: ${license}`;
  // MPL-2.0 and EPL-2.0 (resvg-wasm, elkjs) require telling recipients where the source is.
  const repo = (typeof repository === "string" ? repository : repository?.url ?? "")
    .replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/\.git$/, "").replace(/^github:/, "https://github.com/").replace(/^git@([^:]+):/, "https://$1/");
  const src = `https://www.npmjs.com/package/${name}/v/${version}${repo ? `, ${repo}` : ""}`;
  return `## ${name} ${version}\n\nLicense: ${license}. Source: ${src}\n\n${text}\n`;
});
writeFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "dist/THIRD_PARTY_NOTICES.md"),
  `# Third-party notices\n\nThe Ohmstead MCP bundle includes these packages.\n\n${notices.join("\n")}\n## Arimo font\n\n${readFileSync(here("../src/lib/embed/fonts/LICENSE.txt"), "utf8").trim()}\n`,
);
