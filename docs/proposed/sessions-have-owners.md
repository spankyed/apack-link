# A session has an owner

Status: proposed, 2026-11-23. Not built. This is a design for how a backend's link for a window comes to an end
when the window is gone, without a clock. If it is taken, it becomes a step of [the plan](../plan.md).

## What is wrong now

A link outlives its connection: that is what lets it go on across one that dropped. So a connection closing says
nothing about whether the other end is gone, and [the design](../design.md) leaves that to the host: "the host is
expected to close a window's link when it learns the window is gone".

Nothing helps a host do that, and a host that does nothing is not told it did wrong.

- **`accept` hands `onLink` a link and nothing else.** The host is not told which connection the session began
  on, so it cannot tell which window the link is for.
- **A window that reloads begins a new session.** The old one is still kept, with what it holds, and nothing
  ends it: the window is not gone, so no one says it is.
- **A link nobody closes is kept for good**, a link's bound for each window that ever came and went.
- **In apack the backend does not learn that a window is gone at all.** Read from apack at `eddd825c24`,
  2026-11-23: the backend is a process Electron's main process starts with `spawn`, given its token in the
  environment, and it knows a window only as a socket (`createRpcContext`,
  `packages/server/src/transport/context.ts`). Main is told when a window is destroyed and tells the backend
  nothing. That is enough today because what the backend keeps for a window dies with the socket. With a link
  it is not.

## The rule

**Whoever knows how long the other end lives says whose each connection is, and a link holds a session to its
owner.** A session is never ended for having been quiet, and a host cannot take connections without saying whose
they are.

An owner is a key the host gives: whatever it knows a dialler by. It never crosses the link.

1. **A connection is taken with its owner.** There is no way to hand `accept` a connection without one.
2. **A session is gone on with only by its owner.** A connection that says a session's id and is another owner's
   is a stranger's: it is told nothing of the session and ends none.
3. **An owner has one session.** A new session from an owner ends the one it had, which is told `ended` so that
   it is not dialled again. This is a window that reloaded, or whose page crashed and was loaded again.
4. **The host says an owner is gone**, and its session ends. This is a window that was destroyed.

What `accept` returns would be what takes a connection and what says an owner is gone:

```ts
const backend = accept((link, owner) => { /* a new session, and whose */ }, options)
backend.take(transport, owner)   // a connection, and whose it is
backend.gone(owner)              // that owner will not be back
```

## What it covers

| What happens | What ends the session it had |
|---|---|
| The window is destroyed | The host says its owner is gone |
| The window reloads, or its page crashes and is loaded again | The same owner's new session |
| The connection drops and both ends live | Nothing: it goes on, as now |
| Something else says the session's id | Nothing: it is another owner's, and is turned away |
| The backend ends | Everything it kept goes with it |

So a backend never keeps more sessions than it has owners that are not gone. That is something a run can be held
to under every ordering: an owner reloading, being said to be gone, and dropping its connection, each at any
moment, with the count never above the owners there are and no session ended that its owner could still go on
with.

## What it is not

- **Not a clock.** A session is not given a time to be quiet for. Where a host cannot learn that an owner is
  gone, it says so by a rule of its own, on its own clock, and `gone` is what it calls
  ([a window on another machine](../deferred/remote-windows.md)).
- **Not on the wire.** Whose a connection is comes from how it was admitted, before `take`, and no hello says
  it. `LINK` does not change.
- **Not authentication.** A link still authenticates nobody. An owner is what the host decided on admitting the
  connection, and a link only holds a session to it.

## Why not the smaller changes

- **Handing `onLink` the transport the session began on.** It lets a host that already knows whose each
  connection is close the right link. It does not end a reloaded window's old session, and a host that forgets
  is told nothing. It is what this makes unnecessary.
- **A closed connection means the other end is gone.** It is never wrong, since an end that comes back is told
  its session is lost and starts afresh. It gives up going on across a drop, which is what resume is for
  ([won't do: resume outside the core](../wont-do/resume-outside-the-core.md)), and it leaves a host to do it.
- **A time a session may be quiet for.** MQTT's Session Expiry Interval, declined in the design for one machine.
  A wrong one is quiet both ways: too short ends a window that was slow, too long keeps what will never be sent.

## What apack would do with it

- **The owner is the window.** Main makes a credential for each window as it creates it, hands it to that
  window's preload, and tells the backend which window it names. The window opens its socket with it, as it does
  with the app's token now, and the backend takes the connection with the window as its owner.
- **Main says when a window is gone.** On a window's `closed` it tells the backend, which calls `gone`. Main has
  no channel to the backend today beyond the environment it starts it with; it holds the token and the port, so
  it can call it as any client does.
- **A local tool** that connects with the token from its file (`apack pack dev`) is its own owner for as long as
  its connection, and is gone when that closes.

This is part of the host's work in apack's move to these packages, and is noted in its plan.

## What it does for a window on another machine

Nothing more is needed in a link. The owner is whoever was authenticated, and a time to be kept for is a timer
that calls `gone`. The secret a resume would have had to say
([deferred](../deferred/remote-windows.md), item 2) is not needed: a session is gone on with only by its owner,
and who that is was settled on admission.

## What it costs

- **`accept` changes what it takes and what it returns.** Nothing installs the package yet.
- **A host has to have something to call an owner.** One that has nothing gives each connection its own, and
  says it is gone when the connection closes: that is a link that does not resume, said in one line.
- **Two diallers given one owner** end each other's sessions, the first told `ended`. That is a mistake of the
  host's and is not caught.
