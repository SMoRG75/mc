# Changelog

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
  a very large data set or file is held in memory end to end.
- Recursive copying of directories and PDSes. `F5` on a folder is refused
  rather than attempted.
- `Alt+F7` search, TSO and console commands on the command line.
- Recall of migrated data sets. They are listed and marked, and opening one
  names the `HRECALL` to run, but the extension will not issue it for you.
- Tests against a real host. The parts that can lose data quietly — the
  EBCDIC tables, LRECL fitting, transfer-mode choice and error parsing —
  are covered by unit tests, but the four providers are not: they need an
  LPAR to talk to.
