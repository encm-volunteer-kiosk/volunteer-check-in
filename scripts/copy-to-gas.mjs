// Copies the single-file build (dist-gas/index.html) to apps-script/Index.html, the page
// doGet serves. Run by `pnpm build:gas` after `vite build --mode gas`.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../dist-gas/index.html", import.meta.url));
const to = fileURLToPath(new URL("../apps-script/Index.html", import.meta.url));

function fail(message) {
  console.error(`copy-to-gas: ${message}`);
  process.exit(1);
}

let html;
try {
  html = readFileSync(from, "utf8");
} catch {
  fail(`${from} is missing; run vite build --mode gas first`);
}

// Apps Script reads "<?" as the start of a scriptlet in HTML files.
const scriptlet = html.indexOf("<?");
if (scriptlet !== -1) {
  fail(
    `the build contains "<?" at character ${scriptlet}: ${JSON.stringify(html.slice(scriptlet, scriptlet + 60))}`,
  );
}

// Everything must be inlined: Apps Script serves this one file and nothing beside it.
const external = html.match(
  /<script[^>]+\bsrc=|<link[^>]+rel="?(?:stylesheet|modulepreload)|["(]\/assets\//,
);
if (external) {
  fail(`the build still points at a separate file: ${JSON.stringify(external[0])}`);
}

writeFileSync(to, html);
console.log(
  `copy-to-gas: wrote apps-script/Index.html (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`,
);
