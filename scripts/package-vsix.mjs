/**
 * Builds the .vsix that gets uploaded to the Marketplace.
 *
 * `vsce package` does the actual work — and runs `vscode:prepublish` on the way,
 * so the bundle in the package is always a fresh production build rather than
 * whatever was left in dist/ from the last watch session.
 *
 * What is here instead of a bare `vsce package` is the check that this
 * extension can fail: the Zowe SDKs are bundled, but the credential manager
 * cannot be (see the comment in esbuild.mjs), so it has to travel in
 * node_modules. A package built with it missing installs perfectly and then
 * reads every secure value in zowe.config.json as empty.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const problems = [];
const notes = [];

const exists = (...parts) => fs.existsSync(path.join(root, ...parts));

/* The unbundled runtime dependency must be on disk to be packaged. */
for (const name of Object.keys(manifest.dependencies ?? {})) {
  if (!exists('node_modules', ...name.split('/'))) {
    problems.push(`${name} is not installed — run 'npm install' before packaging.`);
  }
}

/*
 * The credential manager is a native module. It ships a prebuilt binary per
 * platform, all of them inside the one package, which is what lets a single
 * .vsix serve every platform — no `vsce package --target` per architecture. If
 * that ever stops being true, the package would silently work only on the
 * machine that built it, so it is worth knowing about.
 */
const prebuilds = path.join(root, 'node_modules/@zowe/secrets-for-zowe-sdk/prebuilds');
const binaries = fs.existsSync(prebuilds)
  ? fs.readdirSync(prebuilds).filter((file) => file.endsWith('.node'))
  : [];
if (binaries.length === 0) {
  problems.push(
    'No prebuilt keyring binary in @zowe/secrets-for-zowe-sdk/prebuilds. Without it '
    + 'every secure value in zowe.config.json reads as empty.',
  );
} else if (!binaries.some((file) => file.includes('win32'))
  || !binaries.some((file) => file.includes('darwin'))
  || !binaries.some((file) => file.includes('linux'))) {
  problems.push(
    `Only some platforms have a keyring binary (${binaries.join(', ')}). This .vsix `
    + 'would work on those alone — build one per platform with `vsce package --target`.',
  );
}

/* Things the Marketplace shows but will not refuse a package over. */
if (!['LICENSE', 'LICENSE.md', 'LICENSE.txt'].some((name) => exists(name))) {
  notes.push(`No LICENSE file, so the Marketplace has nothing to show under '${manifest.license}'.`);
}
if (!manifest.icon) notes.push('No "icon" in package.json — the Marketplace uses a grey placeholder.');
if (!exists('CHANGELOG.md')) notes.push('No CHANGELOG.md — the Marketplace leaves that tab empty.');

for (const note of notes) console.log(`note: ${note}`);
if (problems.length > 0) {
  for (const problem of problems) console.error(`error: ${problem}`);
  process.exit(1);
}

/*
 * dist/ is emptied first because esbuild writes into it without clearing it.
 * A watch session leaves source maps behind that the production build does not
 * emit and does not overwrite, and .vscodeignore deliberately lets everything
 * under dist/ through — so they ship. Anything else left over from an older
 * build would ship the same way.
 */
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });

const result = spawnSync(
  process.execPath,
  [path.join(root, 'node_modules/@vscode/vsce/vsce'), 'package', ...process.argv.slice(2)],
  { cwd: root, stdio: 'inherit' },
);
if (result.status !== 0) process.exit(result.status ?? 1);

const vsix = path.join(root, `${manifest.name}-${manifest.version}.vsix`);
if (fs.existsSync(vsix)) {
  const mb = (fs.statSync(vsix).size / 1024 / 1024).toFixed(1);
  console.log(`\n${path.basename(vsix)} — ${mb} MB`);
  console.log('Install locally:  code --install-extension ' + path.basename(vsix));
  console.log('Publish:          npx vsce publish   (needs a Marketplace token for publisher '
    + `"${manifest.publisher}")`);
}
