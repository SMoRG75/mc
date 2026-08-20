// Build script for both bundles: the extension (Node, CommonJS) and the
// webview (browser, ESM). Run with --watch during development.
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

const extension = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // 'vscode' is provided by the host. The Zowe packages stay external because
  // Imperative resolves plugins and credential managers at runtime with
  // dynamic require() calls that a bundler cannot follow — they ship in
  // node_modules instead (see .vscodeignore).
  //
  // @zowe/secrets-for-zowe-sdk is doubly external: it is a native module that
  // loads a prebuilt .node binary, which a bundler cannot inline at all.
  // Imperative declares it only as a devDependency and require()s it at
  // runtime, so *we* have to depend on it — without it the credential manager
  // fails to load and every secure value in zowe.config.json reads as empty.
  external: ['vscode', '@zowe/imperative', '@zowe/core-for-zowe-sdk',
             '@zowe/zos-files-for-zowe-sdk', '@zowe/zos-jobs-for-zowe-sdk',
             '@zowe/secrets-for-zowe-sdk'],
};

const webview = {
  ...common,
  entryPoints: ['webview/index.ts', 'webview/style.css'],
  outdir: 'dist/webview',
  platform: 'browser',
  target: 'es2022',
  format: 'esm',
};

if (watch) {
  const ctxs = await Promise.all([esbuild.context(extension), esbuild.context(webview)]);
  await Promise.all(ctxs.map((c) => c.watch()));
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
}
