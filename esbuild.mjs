// Build script for both bundles: the extension (Node, CommonJS) and the
// webview (browser, ESM). Run with --watch during development.
import * as esbuild from 'esbuild';
import { noticesPlugin } from './scripts/notices.mjs';

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
  // 'vscode' is provided by the host. The Zowe SDKs are bundled: their
  // dependency trees are ~5,000 files, which is what vsce warns about. The
  // dynamic require() calls in Imperative that a bundler cannot follow are all
  // on the CLI's side of it — command handlers, plugins, custom credential
  // managers, token auto-store — and ProfileInfo plus the REST client do not
  // reach them.
  //
  // @zowe/secrets-for-zowe-sdk is the exception: it is a native module that
  // loads a prebuilt .node binary, which a bundler cannot inline at all, so it
  // stays external and ships in node_modules as the only runtime dependency.
  // Imperative finds it with require.resolve() from the bundle's own location,
  // which walks up from dist/ to the extension's node_modules. Without it the
  // credential manager fails to load and every secure value in
  // zowe.config.json reads as empty.
  external: ['vscode', '@zowe/secrets-for-zowe-sdk'],
  // What gets bundled is redistributed, so its licenses have to ship too.
  plugins: [noticesPlugin('dist/THIRD-PARTY-NOTICES.txt')],
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
