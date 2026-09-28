# Changelog

## 0.12.0 — 2026-09-28

- `Alt+F7` finds files below where the pane is standing, in any of the four
  worlds: by name, with `*` and `?` and several patterns at once
  (`*.jcl;*.cbl`), and by text inside them — in what F3 would show, converted
  from the codepage, so æøå is found in a member. It goes down through
  folders, libraries and jobs, so a search from a data set filter looks in
  every member, and one from JES in every spool file. Hits appear as they are
  found, with the line the text is on; Enter shows the hit in the pane.
- A file is read only as far as the first line with the text on it. Migrated
  data sets are left unread, since reading one starts a recall, and so are the
  binary names in `mc.transfer.binaryExtensions`; the dialog says how many.
- Listings and the other z/OSMF file requests that are not transfers go one at
  a time per user. With two at once z/OSMF starts a second TSO address space,
  which finds the user's ISPF profile held by the first and stops at `ISPT036
  Table in use` — "received TSO Prompt when expecting
  TSO_SERVLET_DISPATCHER_READY". Opening the panel lists both panes at once,
  which was enough. Reproduced with Zowe CLI alone on IBM's Z Xplore: four
  listings at once failed 3 times in 12, one after another never. Reading and
  writing content was measured not to collide, so transfers stay parallel.
- When `ISPT036` does come — from another client using z/OSMF as the same user
  at that moment — the message says what it is.
- Opening the panel no longer builds two sessions for one profile.

## 0.11.1 — 2026-09-28

- A pane asks z/OSMF for no more entries than it shows (`mc.list.pageSize`),
  where it used to ask for all of them and drop the rest. z/OSMF builds a
  listing one entry at a time in the user's TSO address space and gives up
  after 30 seconds: on IBM's Z Xplore that is about 30 ms an entry, so `/z`,
  which holds every user's home directory, timed out every time. It now lists
  the first page, marked as cut off. A copy of a folder still lists all of it.
- A cut-off data set or member list says `1000+`, not the one extra entry that
  was only fetched to find out there were more.
- A TSO timeout is explained as what it usually is — more than z/OSMF could do
  in 30 seconds — before the stuck address space it can also be.
- The log takes out anything that looks like a credential, whatever wrote it,
  and a failed operation's z/OSMF detail is written once rather than twice.

## 0.11.0 — 2026-09-28

- `F5` copies folders. A directory, a PDS or a job is copied with everything
  in it, empty folders included: to another LPAR, between USS and local disk,
  or from a folder of files into a new PDS. A PDS is allocated like the
  original — organisation, record format, length, block size and space — and a
  directory going to MVS becomes an FB 80 PDS/E, sized for its files, named the
  way TSO reads an unquoted name. A job becomes a folder of its spool files.
- Copying into a folder that is already there merges into it, and the
  overwrite question offers *Overwrite All* and *Skip All* when more than one
  thing is being copied.
- What a copy has to leave out is listed with the reason, and the rest still
  goes: a folder that would go inside a PDS, a load library, two files that
  would become the same member (`a.jcl` and `a.txt` are both `A`).
- A file can no longer be copied onto itself. With both panes in the same
  place, *Overwrite* would have read and rewritten the same file at once.
- Spool files are named with their spool id, `JOB01234.004.SYSPRINT.txt`: the
  DD name alone repeats in every step, and copying several spool files of one
  job made them overwrite each other.
- The copy dialog says what it is about to copy — `2 folders and 5 files`.
- A pane showing where a copy is going re-lists a few times a second at most,
  not once per finished file.
- A log of its own in the Output panel, *Mainframe Commander* (also *Mainframe
  Commander: Show Log*). `mc.log.level` decides how much goes in: errors with
  their full z/OSMF detail by default, each transfer and which host each
  profile connects to at `info`, and at `debug` every pane operation and every
  z/OSMF request with its status and time. Headers are never written, so
  neither are passwords or tokens.
- When z/OSMF's TSO address space for the user is stuck at a prompt or not
  answering, the message says so — naming the address space, so an operator
  can cancel it — instead of repeating z/OSMF's `TSO_SERVLET_DISPATCHER_READY`
  or `TsoServerConnection` text. It shows up in any world, USS included,
  because z/OSMF runs all its file services there.

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
