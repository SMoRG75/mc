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
│  ├─ cursorHistory.ts     Which row the cursor was on, per listing
│  ├─ ebcdic.ts            Local EBCDIC decoding for Shift+F3
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
- **The codepage is picked, not typed, and is remembered.** `IBM-277` is only
  right in Denmark and Norway, so the F5 dialog offers the national EBCDIC pages
  by country and writes the choice back to `mc.transfer.codepage` — into
  whichever settings scope already defines it, so a workspace value is not
  silently shadowed by a global one. The offered set is `mc.transfer.codepages`
  for sites with a page of their own. It applies to every direction: F3/F4 read
  with it, Ctrl+S writes with it, and F5 uses it at both ends — a file read in
  one codepage and written back in another is how national characters get lost.
- **The panes reopen where you left them.** `mc.panes.*` says where a pane
  *starts*; after that the position that last listed successfully is what comes
  back, so the PDS or USS directory you were working in — which LPAR it was on,
  and the row the cursor was on — survives closing VS Code. Within a session
  every listing keeps its own cursor, so stepping into a PDS and back out lands
  on the member you came from rather than at the top. It is kept in the extension's own storage
  rather than written back into `mc.panes.*`, because it changes on every
  navigation and that settings file is often under git. The setting still wins
  whenever it has been edited since: the position is remembered together with
  the `mc.panes.*` value it was remembered against, so changing the setting is
  never silently ignored.
- **`Shift+F3` decodes the bytes here, not on the host.** F3 asks z/OSMF for a
  conversion, which only works for content the host agrees is text. A load
  module, a data set read in binary, or an EBCDIC file that was FTP'd down to
  the PC has no service left to convert it — so `Shift+F3` fetches the raw bytes
  and translates them locally, using IBM's own CDRA tables in
  [`src/core/ebcdic.ts`](src/core/ebcdic.ts). Records come out one per line:
  split on x'15' when the bytes carry one, otherwise on the data set's LRECL
  (`mc.view.ebcdicRecordLength` when there is none). The page is
  `mc.view.ebcdicCodepage`, falling back to the transfer codepage, and it is in
  the tab title — the same bytes are equally valid as IBM-037 and as IBM-277,
  so which one you chose is part of what you are looking at. Content that is
  already text is refused rather than decoded: ASCII read as EBCDIC comes out as
  pages of accented letters that look like a wrong codepage rather than like the
  wrong question, and a USS file tagged ISO8859-1 — z/OSMF's own `.properties`
  files are — has no EBCDIC in it at all.
- **`longLines: 'abort'` by default.** A 132-character line going into FB 80 is
  the classic way to ruin an upload. The user has to choose wrap or truncate
  deliberately.
- **`auto` only guesses binary on known extensions.** Treating an unknown file as
  text is recoverable; treating it as binary silently ruins the EBCDIC
  conversion.
- **The Zowe packages are not bundled.** Imperative loads plugins and credential
  managers with dynamic `require()` calls that a bundler cannot follow. They are
  marked `external` in `esbuild.mjs` and live in `node_modules`.

## Status

The skeleton compiles and all four providers are written against the verified
Zowe v8 API. The following is missing before it is usable in practice:

- [x] Run against a real LPAR — nothing here has seen z/OSMF yet
- [ ] Streaming for large transfers (reads and writes the whole buffer today)
- [ ] Recursive copying of directories and PDSes
- [ ] `Alt+F7` search, favourites (`Ctrl+D`), per-column sort options
- [ ] TSO and console commands on the command line
- [ ] Recall of migrated data sets (shown, but refused for now)
- [ ] Tests

## License

EPL-2.0, like the rest of the Zowe ecosystem.
