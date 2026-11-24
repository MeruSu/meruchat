// sync-www.mjs — mirror the static app into ./www for Capacitor/Electron packaging.
// Sources stay at the project root (index.html / theme.css / js / assets);
// www/ is a build artifact and is gitignored.
import { cp, mkdir, rm, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const out = join(root, 'www');

const files = ['index.html', 'theme.css', 'manifest.json', 'favicon.png'];
const dirs = ['js', 'css', 'assets'];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const f of files) {
  try {
    await stat(join(root, f));
    await cp(join(root, f), join(out, f));
  } catch {
    // optional file
  }
}

for (const d of dirs) {
  try {
    await stat(join(root, d));
    await cp(join(root, d), join(out, d), { recursive: true });
  } catch {
    // optional dir
  }
}

const entries = await readdir(out);
console.log(`www/ ready: ${entries.join(', ')}`);
