// prepack: keep plugin/app in sync with the runtime in the parent checkout.
// Publishing from the AgentCenter repo refreshes app/ first; publishing from a
// standalone copy of this package (no ../tools) just skips the refresh.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sync = path.resolve(HERE, '..', '..', 'tools', 'bundle-app.mjs');

if (!fs.existsSync(sync)) {
  console.log('[prepack] no ../tools/bundle-app.mjs (standalone copy) — using app/ as committed');
  process.exit(0);
}

await import(pathToFileURL(sync).href);