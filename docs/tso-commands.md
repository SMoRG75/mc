# TSO commands on the command line — design proposal

Status: written 2026-10-23 from measurements against IBM Z Xplore. The first
step — plain `tso <command>` — is built (`src/zowe/tso.ts`); the placeholders
and the open questions below are not.

## What the user gets

```
tso LISTCAT LEVEL(Z29016)
tso LISTDS 'Z29016.JCL' MEMBERS
tso TIME
```

Typed on the command line under the panes, like `cd` and `submit`. The output
lands in an Output channel of its own, **Mainframe Commander: TSO**, which is
brought to the front without taking the keyboard from the command line, so
the next command can be typed straight away. Each command is echoed before
its output with the profile it went to (the host name for the default
profile), since TEST and PROD answer alike; TSO's closing `READY` is left
out:

```
TEST> LISTCAT LEVEL(Z29016)
NONVSAM ------- Z29016.DIVERSE.LEG
     IN-CAT --- CATALOG.ZOSA
...
```

The command goes to the active pane's host, or the other pane's when the
active one is on the local disk. A failure is shown in the pane like any
other, and written to the channel as well, so the channel stays a complete
record of the session.

Only `tso` sends anything to TSO. An unknown verb is still refused rather
than passed on, as the command line does today: a typo must not become a
TSO command.

An Output channel rather than an editor tab or a terminal: it is read-only,
searchable, copyable, keeps the history of the session, and needs no
document for VS Code to ask about on close. A pseudo-terminal would look more
like TSO but would have to do its own line editing, and the command line
already exists.

## Which z/OSMF API

z/OSMF has two TSO APIs. Both were tried on Z Xplore:

| | Stateless `PUT /zosmf/tsoApp/v1/tso` | Stateful `/zosmf/tsoApp/tso` |
|---|---|---|
| Needs an account number | no | yes — `IZUG1102E … acct` without one; `FB3` on Z Xplore |
| First command | 2.2 s | 2 s to log on, then each command |
| Later commands | ~150 ms | ~150 ms |
| Lifecycle | none for the caller | start, read until `READY`, stop — an address space is left behind if VS Code dies in between |
| Prompting commands | empty `cmdResponse`, `tsoPromptReceived: "N"` | the prompt arrives and could be answered |

**Use the stateless API.** It needs nothing beyond the zosmf profile the user
already has (the `tso` profile in zowe.config.json has `account: ""` on Z
Xplore and would have to be filled in), there is nothing to clean up, and it
is as fast after the first call.

Called directly with `ZosmfRestClient`, as the probe did, rather than through
`IssueTso.issueTsoCmd` from `@zowe/zos-tso-for-zowe-sdk`:

- The SDK asks `/zosmf/info` for the z/OS version on every call — a second
  round trip for each command.
- It turns an empty response into "Did not receive output from the z/OSMF TSO
  API" and drops `tsoPromptReceived`, which is what tells mc *why* the output
  is empty (below). The SDK's own option comment admits the newer API
  "sometimes" returns no output.
- Its fallback to the old API on a 404 needs the account number anyway.

That is about thirty lines in a `src/zowe/tso.ts`, with no new dependency.

A 404 from `/zosmf/tsoApp/v1/tso` means z/OS before 2.4, which is out of
service; mc says so instead of falling back. If someone asks for it, the
stateful API with the `tso` profile's account is the fallback.

### "Stateless" is not quite

On Z Xplore the stateless calls all ran in the same address space: TSO's own
`SESSION-` time kept growing across calls minutes apart. So an `ALLOC` in one
command may well still be there for the next — but nothing promises it, so mc
does not offer `tso` as a way to build up a session, and the F1 text says one
command at a time.

## Concurrency: no ISPT036

This was the question to answer before designing anything. The file services
run in a TSO address space of the user's, and two of those at once collide
over the ISPF profile (`ISPT036 Table in use` on ISPSPROF), which is why
`sessions.fileService` queues every file request that is not a transfer.

Measured with a read-only probe (data set and USS listings, `TIME`):

| At the same time | File requests failed | TSO failed |
|---|---|---|
| 3 listings (control) | 0/18 | – |
| 4 listings (control) | 9/40 | – |
| stateless TSO + 1 listing | 0/8 | 0/8 |
| stateless TSO + 3 listings | 0/12 | 0/4 |
| stateless TSO + 4 listings | 6/24 | 0/6 |
| stateful address space held open + 4 listings | 4/16 | 0/1 |
| stateful address space held open, a command + 1 listing | 0/4 | 0/4 |
| stateful logon + 1 listing | 0/4 | 0/4 |

The failures only appear with four file requests at once, with or without TSO
— about one per round either way. TSO neither collides nor takes a place from
the file services.

So:

- **TSO commands do not go through `sessions.fileService`.** A command must
  not wait behind a slow listing, and nothing was gained by making it.
- **TSO commands queue among themselves**, in a `Serializer` of their own,
  keyed by host and user like the file one. Two TSO commands at once were
  *not* measured; a queue costs nothing for something typed by hand, and the
  output comes out in the order it was asked for.

## Context from the pane

The mockup promised commands "starting from the pane's own context". Total
Commander's button bar has placeholders for that, and the same ones fit here:

| | MVS pane | USS pane |
|---|---|---|
| `%N` | the row under the cursor, quoted: `'Z29016.JCL(BACKUP)'` | its full path |
| `%P` | the pane's place, quoted: `'Z29016.JCL'` | the directory |

`tso LISTDS %N MEMBERS`. `%%` is a literal `%`. A placeholder that has no
meaning in the pane (`%N` on JES) is refused. This is a second step; plain
`tso <command>` comes first.

## What mc says when it goes wrong

- **No `READY`, `tsoPromptReceived: "N"`** — the command stopped to ask for
  something it will never get (`LU * TSO NORACF` does this on Z Xplore, with
  no output at all). What came is shown, and then: *"LU stopped to ask for
  something, and mc cannot answer TSO prompts."*
- **ISPF.** `ISPSTART` under z/OSMF's logon procedure (IZUFPROC) abends on Z
  Xplore with `Panel 'ISPPFT01' error - Panel not found` and `IKJ56641I`.
  That depends on the site's logon procedure, so the output is shown as it is;
  the F1 note says that ISPF dialog services (`ISPEXEC`) may not be available.
- **Authority, syntax** — TSO's own messages, shown as output. They are
  answers, not errors of mc's.
- **HTTP errors** go through `describeError` like everything else.

## Open questions, to measure before or while building

1. Two TSO commands at the same time — do they share the address space, wait,
   or get a second one?
2. A long-running command (a REXX loop): how long does the stateless call
   wait, and what does z/OSMF return when it gives up? Can the wait be
   cancelled, and does the command keep running if it is?
3. How much output fits: `LISTCAT` of a large level.
4. Whether `SUBMIT` from TSO should refresh a JES pane, as F9 does.

## Not in this step

- **Console commands** (`/zosmf/restconsoles`) go through a different service,
  need console authority Z Xplore users may not have, and were not measured.
  They get a proposal of their own.
- Answering TSO prompts, which needs the stateful API.
- Command history on the command line (Up/Down) — useful for `cd` as much as
  `tso`, and separate.

## Tests

- Unit: parsing the stateless response — output lines, `READY` removed, the
  empty-with-no-prompt case.
- Host (`test/host/tso.host.ts`): `tso TIME` answers `IKJ56650I`; and the
  concurrency probe in small form — one TSO command with three listings,
  nothing fails. Read-only, so it needs neither `MC_HOST_PDS` nor
  `MC_HOST_USS_DIR`.
- F1 and the README's command-line table get the `tso` row; the 1.2 item in
  the README is checked off when it ships.
