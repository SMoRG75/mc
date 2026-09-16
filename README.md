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
command **Mainframe Commander: Open** (`Ctrl+Shift+M`). `F1` in the panel lists
every shortcut; the list itself is `SHORTCUTS` in
[`webview/keymap.ts`](webview/keymap.ts), next to the bindings it describes.

`npm run typecheck` runs TypeScript over both the extension and the webview half.

```bash
npm run vsix           # -> mainframe-commander-<version>.vsix
```

One package covers every platform: the only native code is the Zowe credential
manager, and it ships a prebuilt binary for each of the eleven targets in the
same npm package — so there is no `vsce package --target` per architecture.
[`scripts/package-vsix.mjs`](scripts/package-vsix.mjs) checks that before
handing over to `vsce`, because the credential manager is the one package that
cannot be bundled: a package built without it in `node_modules` installs
perfectly and then reads every secure value in `zowe.config.json` as empty.

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
│  ├─ transferQueue.ts     Background queue for F5 with concurrency and cancellation
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
├─ keymap.ts               Key → action, with dedup of forwarded keys, and the F1 list
├─ dialogs.ts              F1 help, F5 transfer, F7 allocation, Ctrl+F filter, Ctrl+D saved views, prompts
├─ vscode.ts               The webview API handle; every request to the host goes through send()
├─ progress.ts             The busy pointer — from the webview, the host and the transfer queue
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
- **The JES filter is a dialog, not a path.** Which jobs a JES pane shows comes
  down to owner, job name and queue, and writing that as
  `owner=IBMUSER;prefix=BK*;status=output` is a syntax to remember rather than a
  question to answer. `Ctrl+F` — or a click on the path bar, which is showing
  exactly those three things — asks for them as fields and hands the answer back
  to the provider, which is still the only side that knows how a JES path is
  spelled. The dialog opens on the *resolved* values, so the owner it shows is
  the one being listed even when the path never said one. The fields themselves
  are the provider's (`Listing.filter`), so the mechanism is not JES-specific:
  any world that is a filter rather than a path can declare one and get the same
  dialog. The four view tabs stay honest about the filter rather than beside it:
  `Mine` and `All` claim to be every job of an owner, so they clear the job name
  as well — a `Mine` that still hides everything but `RACF*` is not mine —
  while `Active` and `Output` only claim a queue and keep what is in force. And
  a tab is lit only when the pane is showing exactly what that tab points at, so
  a filter typed into Ctrl+F that none of the four describes lights up none of
  them instead of one that is not true.
- **Saved views are favourites with a name.** `Ctrl+D` saves where a pane is
  standing — LPAR, world and filter — under a name, and every saved view for the
  world and profile a pane is in turns up as a ★ tab beside the provider's own
  views, because they are the same kind of thing: a name and a place to stand.
  They live in `mc.favourites` rather than in the extension's own storage: this
  is the user saying "this is a view I want back", which belongs somewhere they
  can read, edit and share, next to `mc.panes.*`. The name is the identity, so
  saving over one replaces it, and the list is validated on the way in — it is
  an array people will edit by hand.
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
  read-only views use schemes of their own — `mc-view` for F3 and `mc-ebcdic`
  for Shift+F3 — because VS Code can only set readonly per provider.
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
- **The Zowe SDKs are bundled; the credential manager is not.** Left in
  `node_modules`, the SDKs drag in some 5,000 files. Imperative's dynamic
  `require()` calls — command handlers, plugins, custom credential managers —
  all belong to the CLI and are never reached through `ProfileInfo` and the REST
  client, so esbuild can take the rest. `@zowe/secrets-for-zowe-sdk` loads a
  native `.node` binary, so it stays `external` in `esbuild.mjs` and is the only
  runtime dependency; the SDKs themselves are devDependencies.

## Status

All four providers are written against the Zowe v8 API and have been run
against a real LPAR through z/OSMF. Still missing:

- [x] Run against a real LPAR
- [ ] Streaming for large transfers (reads and writes the whole buffer today)
- [ ] Recursive copying of directories and PDSes
- [ ] `Alt+F7` search
- [ ] TSO and console commands on the command line
- [ ] Recall of migrated data sets (shown, but refused for now)
- [ ] Tests

## License

Copyright © ubi.dk. Released under EPL-2.0, like the rest of the Zowe ecosystem.
