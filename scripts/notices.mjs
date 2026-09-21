/**
 * Writes dist/THIRD-PARTY-NOTICES.txt for the code the extension bundle carries.
 *
 * Bundling copies the Zowe SDKs and some 130 packages below them into
 * dist/extension.js, so the .vsix redistributes them all. Their LICENSE files
 * stay behind in node_modules, which does not ship, and nearly every one of
 * those licenses asks for its notice to travel with the code. EPL-2.0, which
 * the Zowe packages use, also asks that recipients of the compiled form are
 * told where the source is.
 *
 * The list comes from esbuild's metafile, so it is whatever the build actually
 * pulled in — not package.json, which says nothing about transitive packages
 * and names the Zowe SDKs as devDependencies because they are bundled.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i;
const NOTICE_FILE = /^notice(\.(md|txt))?$/i;
const RULE = '='.repeat(78);

/* Not bundled — it is a native module — but shipped as is in node_modules. */
const SHIPPED = ['node_modules/@zowe/secrets-for-zowe-sdk'];

/** The package directories behind the bundle's inputs, innermost node_modules first. */
function packageDirs(metafile) {
  const dirs = new Set(SHIPPED);
  for (const input of Object.keys(metafile.inputs)) {
    const match = input.replace(/\\/g, '/').match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
    if (match) dirs.add(match[1]);
  }
  return [...dirs];
}

function readPackage(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const files = fs.readdirSync(dir);
  const read = (pattern) => files.filter((f) => pattern.test(f))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim());
  const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  return {
    shipped: SHIPPED.includes(dir),
    name: manifest.name,
    version: manifest.version,
    license: typeof manifest.license === 'string' ? manifest.license : manifest.license?.type ?? 'UNKNOWN',
    repository: repository?.replace(/^git\+/, '').replace(/\.git$/, ''),
    licenseTexts: read(LICENSE_FILE),
    notices: read(NOTICE_FILE),
  };
}

function zoweSection(packages) {
  const lines = [
    RULE,
    'Zowe SDK (Eclipse Public License 2.0)',
    RULE,
    '',
    'This extension includes the following packages from the Zowe project,',
    'Copyright Contributors to the Zowe Project, either compiled into',
    'dist/extension.js or included unmodified under node_modules/:',
    '',
    ...packages.map((p) => `  ${p.name}@${p.version}${p.shipped ? '  (node_modules)' : ''}`),
    '',
    'They are made available under the terms of the Eclipse Public License 2.0,',
    'reproduced below. Their Source Code is available from',
    '',
    '  https://github.com/zowe/zowe-cli (under packages/)',
    '',
    'and each version above can be obtained from the npm registry, for example',
    `  npm pack ${packages[0].name}@${packages[0].version}`,
    '',
    'The Zowe code has not been modified. Any provisions in this extension that',
    'differ from the Eclipse Public License are offered by ubi.dk alone and not',
    'by any Contributor to the Zowe project.',
    '',
  ];
  const texts = [...new Set(packages.flatMap((p) => p.licenseTexts))];
  return [...lines, ...texts.flatMap((t) => [t, ''])].join('\n');
}

function packageSection(p) {
  const lines = [RULE, `${p.name}@${p.version} (${p.license})`];
  if (p.repository) lines.push(p.repository);
  lines.push(RULE, '');
  if (p.licenseTexts.length === 0) lines.push(`Licensed under ${p.license}. The package carries no license file.`, '');
  for (const text of [...p.licenseTexts, ...p.notices]) lines.push(text, '');
  return lines.join('\n');
}

export function writeNotices(metafile, outfile) {
  const packages = packageDirs(metafile).map(readPackage)
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true }));
  /* The same package can be bundled twice at different versions; the same version twice once. */
  const unique = packages.filter((p, i) => i === 0 || p.name !== packages[i - 1].name || p.version !== packages[i - 1].version);
  const zowe = unique.filter((p) => p.name.startsWith('@zowe/'));
  const others = unique.filter((p) => !p.name.startsWith('@zowe/'));

  const header = [
    'Mainframe Commander — third-party notices',
    '',
    'Mainframe Commander is Copyright © ubi.dk and released under EPL-2.0 (see',
    'LICENSE). It includes the third-party software listed below, each under its',
    'own license.',
    '',
  ].join('\n');

  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  fs.writeFileSync(outfile, [header, zoweSection(zowe), ...others.map(packageSection)].join('\n'));
}

/** An esbuild plugin that rewrites the notices after every successful build. */
export function noticesPlugin(outfile) {
  return {
    name: 'third-party-notices',
    setup(build) {
      build.initialOptions.metafile = true;
      build.onEnd((result) => {
        if (result.errors.length === 0 && result.metafile) writeNotices(result.metafile, outfile);
      });
    },
  };
}
