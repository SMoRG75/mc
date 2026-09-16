# Changelog

## 0.1.0

First release.

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
