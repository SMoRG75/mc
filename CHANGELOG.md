# Changelog

## 0.10.0 — 2026-09-28

- Transfers stream. `F5` and `F6` no longer read the whole source into memory
  before writing it: the bytes go from one side to the other through a stream,
  paced so that neither a slow host nor a slow disk makes the other end buffer
  the rest. Spool files are streamed too.
- Cancelling a running transfer stops it, rather than letting it finish and
  then calling it cancelled. A download whose connection breaks off now fails
  instead of waiting for ever.
- A copy to local disk is written under a temporary name and renamed at the
  end, so a transfer that fails leaves the old file, or none, instead of half
  of one.
- Text into a data set with *Long lines: Abort* is checked in full, spooled
  through a temporary file, before anything is sent — the transfer is still
  refused before the host is touched.
- The status bar shows how much has been moved, which is the only measure there
  is for members and spool files, whose size column counts records.
- An empty text file written to a data set becomes an empty member, not one
  with a single blank record.
- Spool files copied to local disk on Windows now get CRLF line endings, like
  data sets and USS files already did.
- Dropdowns in the dialogs are drawn like the text fields next to them — same
  height, border and width, in the theme's dropdown colours — instead of by
  the operating system.
- The bundled Zowe SDKs are updated to 8.38.0.

## 0.9.0 — 2026-09-20

First release. Feature-complete for day-to-day work on the four worlds, but
short of 1.0 on the points listed under *Not yet* below.

- Dual-pane, Total Commander-style file manager for z/OS in a VS Code panel,
  connecting through the existing Zowe `zowe.config.json`.
- Four worlds per pane — local disk, MVS data sets, USS and JES — switched with
  `Alt+1` … `Alt+4`.
- F-key bar: view (`F3`), raw EBCDIC view (`Shift+F3`), edit (`F4`), copy
  between panes and LPARs (`F5`), rename (`F6`), create member, folder or data
  set (`F7`), delete (`F8`), submit JCL (`F9`) and compare (`F10`). `F1` lists
  every shortcut.
- Transfers with text/binary mode, a codepage picker that remembers the choice,
  and a safe default for lines longer than the target LRECL.
- JES jobs shown as folders and spool DDs as files, with an owner/job name
  filter (`Ctrl+F`) and auto-refresh.
- Saved views (`Ctrl+D`), quick filter, column sorting, and panes that reopen
  where they were left.

### Not yet

- Streaming for large transfers — a copy reads and writes the whole buffer, so
  a very large data set or file is held in memory end to end. *(Done since.)*
- Recursive copying of directories and PDSes. `F5` on a folder is refused
  rather than attempted.
- `Alt+F7` search, TSO and console commands on the command line.
- Recall of migrated data sets. They are listed and marked, and opening one
  names the `HRECALL` to run, but the extension will not issue it for you.
- Tests against a real host. The parts that can lose data quietly — the
  EBCDIC tables, LRECL fitting, transfer-mode choice and error parsing —
  are covered by unit tests, but the four providers are not: they need an
  LPAR to talk to.
