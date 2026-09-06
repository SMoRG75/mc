# Mainframe Commander

Total Commander-style dual-pane file management for z/OS, as a VS Code extension.
The connection goes through [Zowe](https://www.zowe.org/), so the user's existing
`zowe.config.json` — certificates, MFA and credential manager included — is the
only setup required.

The design sketch is in [`docs/mainframe-commander-mockup.html`](docs/mainframe-commander-mockup.html).

## Getting started

```bash
npm install
npm run build          # or: npm run watch
```

Press `F5` in VS Code to start an Extension Development Host, and run the
command **Mainframe Commander: Open** (`Ctrl+Shift+M`).

`npm run typecheck` runs TypeScript over both the extension and the webview half.

## How it fits together

```
src/
├─ extension.ts            Activation: registers providers, commands and file system
├─ commanderPanel.ts       The webview panel and all state (where each pane points)
├─ shared/
│  └─ protocol.ts          The message contract between host and webview — imported by both
├─ core/
│  ├─ provider.ts          The PaneProvider interface + registry
│  ├─ transferQueue.ts     Background queue for F5/F6 with concurrency and cancellation
│  ├─ editorBridge.ts      FileSystemProvider, so F3/F4 open in a real editor
│  ├─ text.ts              Text/binary choice and LRECL fitting
│  ├─ settings.ts          Typed reading of the mc.* settings
│  └─ errors.ts            Digs the readable sentence out of z/OSMF errors
├─ providers/
│  ├─ localProvider.ts     Local disk
│  ├─ dsProvider.ts        MVS: dataset filters, PDS members, allocation, submit
│  ├─ ussProvider.ts       USS: paths, permissions, tagging
│  └─ jesProvider.ts       JES: jobs as folders, spool DDs as files
└─ zowe/
   └─ sessions.ts          ProfileInfo → session, cached per profile name

webview/
├─ index.ts                App: layout, messages, actions
├─ pane.ts                 One pane: header, path, rows, footer, selection
├─ virtualList.ts          Windowed rendering — only visible rows are built
├─ keymap.ts               Key → action, with dedup of forwarded keys
├─ dialogs.ts              The F5 transfer dialog, prompt, confirm
└─ style.css               Total Commander layout in the user's VS Code theme
```

### The load-bearing idea

`PaneProvider` is the whole extension. Local disk, datasets, USS and JES
implement the same interface, so every key has exactly one implementation no
matter which world the pane is showing — and F5 from LPAR1 to LPAR2 is not a
special case, just `source.read()` followed by `target.write()`.

### Decisions worth knowing

- **JES is a file system.** Jobs are folders, spool DDs are files. That is why
  F3/F5/F8 mean the same thing there as everywhere else, without a separate
  command palette just for jobs.
- **F7 asks for more than a name on MVS.** RECFM, LRECL and the space cannot be
  changed afterwards, so allocation has a real dialog with the four shapes it
  actually comes down to (FB 80, FBA 133, VB 255, load module) — and a LIKE
  field, because the answer is most often "like the dataset that already
  exists". Inside a PDS and on USS/local disk, F7 is still just a name prompt.
- **Dataset names are read as in TSO.** A name without apostrophes is relative to
  the user's own HLQ, so `TEST.JCL` becomes `IBMUSER.TEST.JCL`; `'SYS1.PARMLIB'`
  is used exactly as typed. This holds for both F7 and F6, and both dialogs
  therefore pre-fill with apostrophes — the field already carries a full
  qualifier, which the user should not get their own put on top of.
- **File system provider rather than temp files.** F3/F4 open `mc://LPAR1/BACKUP01`,
  so syntax colours, diff, search and `Ctrl+S` work as on a local file. The
  read-only view uses its own scheme (`mc-view`), because VS Code can only set
  readonly per provider.
- **`longLines: 'abort'` by default.** A 132-character line going into FB 80 is
  the classic way to ruin an upload. The user has to choose wrap or truncate
  deliberately.
- **`auto` only guesses binary on known extensions.** Treating an unknown file as
  text is recoverable; treating it as binary silently ruins the EBCDIC
  conversion.
- **The Zowe packages are not bundled.** Imperative loads plugins and credential
  managers with dynamic `require()` calls that a bundler cannot follow. They are
  marked `external` in `esbuild.mjs` and live in `node_modules`.

## Troubleshooting

### LMDINIT errors when the DS pane opens

`X-IBM-Attributes: base` — which is what `List.dataSet(..., { attributes: true })`
sends — makes z/OSMF go through TSO's and ISPF's data set list services instead
of just reading the catalog. Those services fail on things a plain catalog read
handles without trouble: a migrated data set that DFSMShsm wants to prompt
about, a volume that is not mounted, or a filter that matches too much. The
symptom is an LMDINIT failure or *"received TSO Prompt when expecting
TsoServletResponse"*.

Two things changed as a result:

- An empty pane filter no longer becomes `dslevel=*` (the entire catalog), but
  `<YOUR-USER>.*`. Set `mc.ds.defaultFilter` if you want something else.
- `listWithAttributeFallback()` tries the detailed listing first and falls back
  to a plain name list if it fails. The pane then shows `without attributes` in
  the footer instead of being empty. The RECFM, LRECL and Used columns are blank
  in that case — everything else works.

## About the credential manager

`@zowe/imperative` reads secure values from zowe.config.json through
`@zowe/secrets-for-zowe-sdk` — a native module it only has as a *devDependency*
and `require()`s at runtime. It therefore has to be in our own `dependencies`,
or Imperative only logs

```
Failed to load Keytar module: Cannot find module '@zowe/secrets-for-zowe-sdk'
```

and carries on with every user name and password empty. The error only surfaces
much later as a 401, so `src/zowe/sessions.ts` explicitly checks that there are
credentials and says so in plain words instead.

When packaging to `.vsix`: the module is `external` in esbuild and ships in
`node_modules`. If you ever choose to bundle the Zowe packages, the `prebuilds/`
directory with the native binaries has to be copied up next to `package.json` in
the extension root — see
[EXTENDERS.md in the secrets package](https://github.com/zowe/zowe-cli/blob/master/packages/secrets/EXTENDERS.md).

## Status

The skeleton compiles and all four providers are written against the verified
Zowe v8 API. The following is missing before it is usable in practice:

- [ ] Run against a real LPAR — nothing here has seen z/OSMF yet
- [ ] Streaming for large transfers (reads and writes the whole buffer today)
- [ ] Recursive copying of directories and PDSes
- [ ] `Alt+F7` search, favourites (`Ctrl+D`), per-column sort options
- [ ] TSO and console commands on the command line
- [ ] Recall of migrated data sets (shown, but refused for now)
- [ ] Tests

## License

EPL-2.0, like the rest of the Zowe ecosystem.
