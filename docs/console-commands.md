# Console commands on the command line

Status: built 2026-10-24 (`src/zowe/console.ts`), tried against the virtual
mainframe (VTS1) and with `D T` on IBM Z Xplore.

## On Z Xplore

`D T` answers. The PUT returns the console's attributes beside the answer,
and a Z Xplore user's console has `consoleAuth: "INFO"` — display commands
only — with `consoleMscope: "*ALL"`:

```
"cmd-response": " IEE136I LOCAL: TIME=14.28.31 DATE=2026.297  UTC: TIME=19.28.31 DATE=2026.297",
"cmd-response-key": "C1267387",
"cmd-response-uri": "/zosmf/restconsoles/consoles/defcn/solmsgs/C1267387",
```

The first PUT took about 3 seconds, presumably the EMCS console being
activated. The follow-ups (`solmsgs`) answered `{"cmd-response": ""}`, so
after `D T` mc asks twice more and stops: the answer is in the channel at
once, and the next console command waits about two seconds behind it.
Nothing that needs more than INFO authority was sent.

## What the user gets

```
/D IPLINFO
/$DA
console D A,L
```

`/` and the command, as in SDSF, or `console` and the command. The answer
goes to an Output channel of its own, **Mainframe Commander: Console**, kept
apart from the TSO one, with each command echoed with the profile it went to:

```
TEST> D IPLINFO
IEE254I  IPLINFO DISPLAY
 SYSTEM IPLED AT 21.01.23 ON 10/24/2026
...
```

Like `tso`, it goes to the active pane's host, or the other pane's when the
active one is on the local disk.

A line that starts with `/` and has another `/` in its first word —
`/u/tester` — is refused as a path typed without `cd`, rather than sent to
the console as `U/TESTER`.

Nothing asks before a command is sent, whatever it is. Whether a user may
stop a task or vary a device offline is the console authority's call, as at
any other console, and a confirmation for every `D` would be in the way of
the people the feature is for. The echo names the profile, so TEST and PROD
are told apart in the record.

## The z/OSMF API

`PUT /zosmf/restconsoles/consoles/defcn` with `{"cmd": "...", "async": "N"}`.
`defcn` is z/OSMF's name for the user's default EMCS console. Called directly
with `ZosmfRestClient`, as TSO is, rather than through
`@zowe/zos-console-for-zowe-sdk`, which would be a new dependency for two
requests.

A console answers in pieces: the messages that have come when z/OSMF answers
the PUT, and JES and subsystem commands often more a moment later. So after
the first answer mc asks `GET …/solmsgs/<cmd-response-key>` once a second,
writing each piece to the channel as it comes, until two asks in a row bring
nothing or ten have been made. A failed ask ends it quietly (logged, not
shown): the command was answered already. The virtual mainframe has no
`solmsgs`, answers it 404, and so ends after one ask.

Messages are separated by a bare carriage return; leading blanks are kept,
since console output is laid out in columns.

## Queueing

Console commands queue among themselves, by host and user, so each
command's messages come out in one piece in the order they were asked for.
Not behind the file services or TSO: the console is a service of its own,
with no TSO address space of the user's in it — not measured, but nothing
suggests otherwise.

## What mc says when it goes wrong

- **Authority to the command** (`IEE345I … AUTHORITY INVALID`) is the
  console's answer and is shown as output, like TSO's own messages.
- **A refusal from z/OSMF's console service** comes back with `reason`,
  `msgid`, `return-code` and `reason-code` instead of the file services'
  `message`, so `console.ts` turns it into the message itself. The exact
  shape is from IBM's documentation, not from a host.
- **404 on the PUT** — the z/OS Operator Consoles plug-in of z/OSMF is not
  there; mc says so.

## Open questions, for a real z/OSMF

1. Does z/OSMF refuse a user without any console authority with HTTP 4xx and
   a `reason`, and how does that read? A command beyond INFO authority
   should come back as `IEE345I` in the answer, as on the virtual mainframe,
   but that was not sent on Z Xplore.
2. How late do JES2 replies come on a busy system, and is one second
   between asks right?
3. Does `defcn` clash when the same user is at another EMCS console (SDSF's
   `/` uses one too)?
