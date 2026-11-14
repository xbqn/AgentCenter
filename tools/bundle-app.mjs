// Copy the AgentCenter runtime (h5 + core + 解析规则) into plugin/app so the npm
// package is self-contained: no `root` pointing at a local checkout.
// usage: node tools/bundle-app.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(REPO, 'plugin', 'app');
const checkOnly = process.argv.includes('--check');

const ITEMS = [
  ['h5', ['index.html', 'serve.mjs', 'sw.js', 'manifest.webmanifest', 'icon.svg']],
  ['core', ['adapters.mjs', 'parse.mjs', 'conversation.mjs', 'scan.mjs', 'report.mjs', 'util.mjs', 'scheduler.mjs', 'search-index.mjs']],
  ['docs/解析规则', null],   // null = 整个目录
];

const copied = [];

function copyFile(from, to) {
  const body = fs.readFileSync(from);
  const current = fs.existsSync(to) ? fs.readFileSync(to) : null;
  if (current !== null && current.equals(body)) return false;
  if (checkOnly) {
    copied.push(path.relative(REPO, to));
    return true;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, body);
  copied.push(path.relative(REPO, to));
  return true;
}

for (const [dir, files] of ITEMS) {
  const source = path.join(REPO, dir);
  const target = path.join(TARGET, dir);
  const list = files === null ? fs.readdirSync(source).filter((name) => name.endsWith('.md')) : files;
  for (const name of list) {
    const from = path.join(source, name);
    if (!fs.existsSync(from)) {
      console.warn('missing source file:', path.relative(REPO, from));
      continue;
    }
    copyFile(from, path.join(target, name));
  }
}

if (copied.length === 0) {
  console.log(`plugin/app is up to date (${ITEMS.length} groups checked)`);
} else if (checkOnly) {
  console.log('drift detected, run `node tools/bundle-app.mjs` before publishing:');
  for (const name of copied) console.log('  -', name);
  process.exitCode = 1;
} else {
  console.log('copied into plugin/app:');
  for (const name of copied) console.log('  -', name);
}