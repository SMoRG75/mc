// Runs the unit tests.
//
// Node can execute TypeScript directly, but only as ES modules: type stripping
// removes the types and leaves `import` alone, so a file that imports one of
// ours is resolved by the ESM loader, which demands file extensions the source
// does not carry. The source is CommonJS on purpose — that is what the
// extension host loads — so the tests go through the bundler that already
// builds it rather than a second module system.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import * as esbuild from 'esbuild';

const OUT = 'out/test';

const tests = readdirSync('test').filter((name) => name.endsWith('.test.ts'));
if (tests.length === 0) {
  console.error('No test files in test/.');
  process.exit(1);
}

await esbuild.build({
  entryPoints: tests.map((name) => `test/${name}`),
  outdir: OUT,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: 'inline',
  logLevel: 'warning',
  // Nothing under test touches these; a test that reaches one should fail
  // loudly rather than pull the host API into the bundle.
  external: ['vscode', '@zowe/secrets-for-zowe-sdk'],
});

const run = spawnSync(
  process.execPath,
  ['--test', '--enable-source-maps', ...tests.map((name) => `${OUT}/${name.replace(/\.ts$/, '.cjs')}`)],
  { stdio: 'inherit' },
);
process.exit(run.status ?? 1);
