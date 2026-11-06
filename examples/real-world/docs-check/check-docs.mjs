// Deterministic documentation check: every relative markdown link must resolve
// and every required document must exist. No model, no network.
//
// usage: node check-docs.mjs <root> [required,comma,separated] [extraDirs,comma,separated]
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('usage: check-docs <root> [required] [extraDirs]');
  process.exit(2);
}
const required = (process.argv[3] ?? '').split(',').filter(Boolean);
const extraDirs = (process.argv[4] ?? '').split(',').filter(Boolean);

const files = [];
function walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith('.md')) files.push(path);
  }
}
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.md')) files.push(join(root, entry.name));
}
for (const dir of extraDirs) walk(join(root, dir));

const failures = [];
for (const requiredPath of required) {
  if (!existsSync(join(root, requiredPath))) failures.push(`missing required doc: ${requiredPath}`);
}
let checked = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim().replace(/^<|>$/g, '');
    if (/^(https?:|mailto:|#|\/)/.test(target)) continue;
    const clean = target.split('#')[0];
    if (!clean) continue;
    checked += 1;
    const resolved = resolve(dirname(file), decodeURIComponent(clean));
    if (!existsSync(resolved)) failures.push(`${file}: broken link ${target}`);
  }
}
if (failures.length > 0) {
  console.error(failures.slice(0, 60).join('\n'));
  console.error(`total failures: ${failures.length}`);
  process.exit(1);
}
console.log(`ok: ${files.length} markdown files, ${checked} relative links`);
