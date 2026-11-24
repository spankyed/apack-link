# A window on another machine

Status: deferred, 2026-11-23. Not designed. This records what a window that reaches its backend across a network
would need beyond what a link does now, where each piece would live, and what would make it worth starting. It is
left out of [the plan](../plan.md) on purpose.

## Where it stands

A window and its backend are two processes of one app on one machine, joined by a socket on the loopback address.
There a connection drops almost only because one end died, and an end that died is a new session
([the design](../design.md)): the window starts afresh and its views read the rows again. Resume, a link going on
across a connection that dropped while both ends lived, is built and held to its specs, and on one machine it
rarely has anything to do.

Across a network it does. A connection drops while both ends live, for seconds or for minutes, and comes back.
Resume is what that case is for, which is why it stays in a link's core
([won't do: resume outside the core](../wont-do/resume-outside-the-core.md)). Three more things are needed, and
none is built.

## What it would take

1. **How long an owner is kept, said by the host.** A session is kept until its host says its owner is gone
   ([the design](../design.md), "A session has an owner"). On one machine something knows when that is, the
   process that made the window, and tells the host. Across a network nothing knows, so the host would say an
   owner is gone after a time of its own choosing, on its own clock: a timer that calls `gone`, and nothing of
   a link's. MQTT's Session Expiry Interval was declined for one machine, and this is the case it was made for.
2. **Who is connecting, and a connection nobody else can read.** A link authenticates nothing and encrypts
   nothing, and both stay outside it: TLS on the socket, and whatever says who a connection is before it reaches
   `accept`. What is deferred is the app's choice of each. A token read from a file only the user can open is no
   answer for another machine. Whoever that settles a connection to be is its owner, so a session's id, which
   is told to anything that connects, is not enough to go on with it: no secret of a session's own is needed.
3. **An ask that is not done twice.** Resume sends again what was not taken, while the session is kept. A window
   that asked for something, dropped, and came back after its session was given up cannot tell whether the ask
   was done. On one machine its views say. Across a network it would ask again, so an ask would carry a key the
   backend keeps as a row in the step that does the work, and the same key again is answered with what was done.
   This one is the state kernel's ([spankyed/apack-state](https://github.com/spankyed/apack-state)) and not a
   link's: what was done is in the database, and a link's memory is gone with the session.

## What it costs

- **A policy every host must give.** A wrong one is quiet: too short and a window that was only slow starts
  afresh, too long and a backend keeps what it will never send.
- **Rows that grow.** Keys of asks done are kept until something says they can go, which is one more thing with
  a lifetime to decide.
- **Three repositories**: a link, the state kernel, and the app that chooses the socket and who may open it.

## What would make it worth starting

- **A window that is not on the backend's machine**: a browser reaching a backend on a server, or a desktop
  window on a machine in another room.
- **A backend that outlives its windows on purpose**, kept running while a laptop sleeps and is reached again.

Neither is planned. Until one is, a drop on one machine is rare enough that starting afresh is the whole answer.
