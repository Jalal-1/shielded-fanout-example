// Copies the circuit files the site must serve into public/.
//
// Proving and deploying fetch these from the site's own origin:
//   compiler/contract-manifest.json   sizes and hashes, checked on every fetch
//   keys/<circuit>.verifier           every circuit (a deploy carries them all)
//   keys/<circuit>.prover             only circuits the UI proves (see PROVED)
//   zkir/<circuit>.bzkir              every circuit
//
// Prover keys are large, so only the ones in PROVED are committed and served.
// `pnpm compile` regenerates all of them under contract/managed/.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The circuits the UI calls, and therefore proves. */
export const PROVED = ['mint'];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const managed = path.join(root, 'contract/managed/FanoutToken');
const out = path.join(root, 'public');

if (!existsSync(path.join(managed, 'compiler/contract-manifest.json'))) {
  console.error('contract/managed/FanoutToken is missing. Run `pnpm compile` (needs the Compact compiler).');
  process.exit(1);
}

const wanted = (dir, file) =>
  dir === 'compiler' ||
  (dir === 'zkir' && file.endsWith('.bzkir')) ||
  (dir === 'keys' && (file.endsWith('.verifier') || PROVED.some((circuit) => file === `${circuit}.prover`)));

rmSync(out, { recursive: true, force: true });
const rows = [];
for (const dir of ['compiler', 'keys', 'zkir']) {
  mkdirSync(path.join(out, dir), { recursive: true });
  for (const file of readdirSync(path.join(managed, dir)).sort()) {
    if (!wanted(dir, file)) continue;
    cpSync(path.join(managed, dir, file), path.join(out, dir, file));
    rows.push([`${dir}/${file}`, statSync(path.join(out, dir, file)).size]);
  }
}

if (process.argv.includes('--table')) {
  const mb = (bytes) => (bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log('| File | Size |\n| --- | ---: |');
  for (const [file, size] of rows) console.log(`| \`${file}\` | ${mb(size)} |`);
  console.log(`| **Total** | **${mb(rows.reduce((sum, [, size]) => sum + size, 0))}** |`);
} else {
  console.log(`Copied ${rows.length} circuit files to public/.`);
}
