// Runs the provider tests against a real z/OSMF.
//
// Separate from `npm test` on purpose: these need a host, credentials and a
// data set to write into, and CI has none of them. They go through the same
// esbuild step as the unit tests, for the same reason (see run-tests.mjs),
// and use the Zowe profile the extension would — zowe.config.json and the
// credential manager — so nothing about the connection is test-only.
//
//   MC_HOST_PDS      A PDS the tests may write members into. They only ever
//                    create, change and delete members whose names start with
//                    MCT, and never touch the data set itself.
//   MC_HOST_USS_DIR  A USS directory the tests may write into. Likewise, only
//                    files and directories whose names start with mct.
//   MC_HOST_PROFILE  The zosmf profile to use; the default profile if unset.
//   MC_HOST_DEBUG    Set to anything to see every z/OSMF request.
//
// At least one of MC_HOST_PDS and MC_HOST_USS_DIR is needed; the tests for the
// other are skipped. JES is only ever read.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import * as esbuild from 'esbuild';

if (!process.env.MC_HOST_PDS && !process.env.MC_HOST_USS_DIR) {
  console.error('Set MC_HOST_PDS to a PDS the tests may write MCT* members into, '
    + 'MC_HOST_USS_DIR to a USS directory they may write mct* files into, or both.');
  process.exit(1);
}

const DIR = 'test/host';
const OUT = 'out/test-host';
const tests = readdirSync(DIR).filter((name) => name.endsWith('.host.ts'));

await esbuild.build({
  entryPoints: tests.map((name) => `${DIR}/${name}`),
  outdir: OUT,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: 'inline',
  logLevel: 'warning',
  // The credential manager is a native module and has to be loaded from
  // node_modules at run time, as it is in the extension.
  external: ['vscode', '@zowe/secrets-for-zowe-sdk'],
});

const run = spawnSync(
  process.execPath,
  [
    '--test', '--enable-source-maps', '--test-concurrency=1',
    ...tests.map((name) => `${OUT}/${name.replace(/\.ts$/, '.cjs')}`),
  ],
  { stdio: 'inherit' },
);
process.exit(run.status ?? 1);
