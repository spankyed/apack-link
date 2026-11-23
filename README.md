# apack-link

One ordered stream between two systems of [apack](https://github.com/spankyed/apack): a window and its backend, or
any two things that run states. As a package, `@apackdev/link`.

**What one system sends another arrives once, in the order it was sent, or the sender is told it did not.**

Status: started, 2026-11-22. What is here is the frames, one end of a link over anything that carries text, a
peer that matches asks to answers and views to what they show and holds what a system says until its views have
caught up, things to carry it on (a WebSocket, a message port, a stream of bytes, and two ends in memory), and a
schedule that runs a spec under every order. Nothing in apack uses it yet.

## Why it exists

apack's states talk across a boundary in a handful of ways: one asks and is answered, one tells, one follows a view
and is shown what it holds. The design those states are written to
([apack-state](https://github.com/spankyed/apack/blob/master/docs/plans/apack-state.md)) rests on the order between
them. A window that is answered "created" has to have been shown the thing first, so the view's update and the
answer have to arrive in the order they were sent.

A general RPC layer does not promise that. It gives each subscription a pump of its own, and order between two of
them is whatever the timing gives. A link carries exactly what states say to each other, as frames on one stream,
and so can keep all of it in order.

## What it carries

| Frame | Says |
|---|---|
| `tell` | Something happened. Nobody waits |
| `ask`, `answer` | A question, and how it ended. Answered once |
| `progress` | What the one answering says before it answers |
| `left` | Whoever asked has gone, and the work for them can stop |
| `follow`, `shown`, `unfollow` | A view: its result, and each changed result after it |
| `over` | The one running a view has ended it, and why |

## What holds

- **Once, across a connection that drops.** A link outlives what carries it. Each end keeps what it sent until
  the other says it took it, and a new connection picks up where each end got to. Nothing is taken twice. A link
  that can come back sends nothing until it has met the other end, so a window that starts before its backend
  listens has handed nothing to anybody, and starts with whichever backend it meets.
- **Order.** Every frame an end sends is numbered. The other end takes a frame only if it is the next one, and a
  frame lost, doubled or out of place closes the link, saying why. So does anything that is not one of the frames
  below: an id is a whole number from 1, a name is text, a failure is a kind and a message. What a frame carries
  for a system is not looked at.
- **A window hears of a step after its views show it.** What a system says to the other end waits until the views
  it runs for that end have caught up with what was kept before it was said. A view's own updates are what is
  waited for, and go at once.
- **One bad frame is one refusal.** A frame that cannot be sent throws where it was sent and takes no number: a
  `TypeError` for one that cannot be put into text, a `RangeError` for one larger than a frame may be
  (`bound.frame`, 64 MiB unless given) or than what the link is carried on takes. The link goes on, with nothing
  missing before the next frame. Through `join`, the one ask or view it belonged to fails, and no other.
- **One write a turn.** What an end sends within one turn of the event loop crosses as one text. Where what
  carries it takes no message that long (`Transport.most`), it crosses as the fewest that fit, cut between
  frames, in order: a link never hands a transport more than it takes.
- **Bounded.** How far behind the other end is, is what it has not said it took. Past a mark a link stops
  numbering what is sent, and a view's result that a later one overtakes while it waits is let go: only the last
  matters. Nothing else is let go. Past the bound on what waits, the link ends `overrun`, saying by how much.
  `link(transport, { bound: { kept, waiting, frame } })` sets them, in frames and in bytes. Every size a link counts or
  reports is in bytes of text as UTF-8, which is what a transport counts what it has not written in.
- **Never a time to answer in.** What carries a link saying it closed is how an end knows the other has gone. For
  a connection that can go quiet without closing, `link(open, { there: { window, clock } })`: while this end is
  owed something, a `taken` or an answer, and nothing at all has arrived for half the window, it asks whether the
  other end is there. After a whole window with nothing arriving, it opens another connection. An ask that takes an
  hour is not a link that has gone.
- **A listener that throws loses nothing.** Every frame of the batch is still taken, in order, every other
  listener is still called, and the link goes on. What was thrown is handed to `link(…, { thrown })`, or thrown
  again in a turn of its own, to be reported as anything uncaught is. A system joined to a link is a listener:
  one that throws where it is told, answered or shown is told, answered and shown everything after.
- **Closing sends what was sent.** `close()` sends everything sent before it, what waited for room included, and
  then the goodbye, wherever it can arrive no more than once: on a connection where the other end has been met,
  and on any connection of an end that has never met anybody, so a window that says one thing and closes is
  heard. What waited with no connection, or on one where an end met before has not been met again, has nowhere
  to go and is let go.
- **Ending is said once, to both ends**, with why. Every ask waiting ends `disconnected`, every view followed is
  said to be over, and whatever an end was answering or showing for the other is told to stop. An end going on purpose says goodbye first, as `restarting` or
  `ended`, and the other end's ending says which.
- **An end that cannot be talked to is refused.** The first thing each end says is which link it is, and one that
  says another number is closed on, naming both.
- **Nothing a link reports holds what a frame carries.** An ending names a kind, a number or a size, and a frame
  that cannot be put into text is refused with a `TypeError` of the link's own.
- **What caused a frame crosses with it, and a tap never sees what one carries.** `send(frame, { cause })`, and
  `onFrame` hears the cause. `onTraffic` is told of each frame out and in: its direction, number, kind, id, name,
  size and cause. A frame sent `{ private: true }` is told of only as having crossed, with its number and size.

## Use

A system offers a `Port`: what it can be told, asked and have followed. `join` puts one at an end of a link and
returns the port of the system at the other end.

```ts
import { join, link, memoryPair, type Port } from '@apackdev/link'

const backend: Port = {
  tell: (to, event) => {},
  ask: (to, name, args, heard, ended) => { ended({ ok: true, value: { id: 'THR-1' } }); return () => {} },
  follow: (feature, view, args, shown, over) => { shown(0); return { stop: () => {} } },
}
const [left, right] = memoryPair()
join(link(right), backend)
const toBackend = join(link(left), { tell: () => {}, ask: () => () => {}, follow: () => ({ stop: () => {} }) })

toBackend.ask('threads', 'CREATE', { topic: 'one' }, (update) => {}, (outcome) => console.log(outcome))
```

What `ask` returns is to be called when whoever asked has gone: the other end is told, and nothing more is heard
for it. A `Following`'s `stop` does the same for a view.

A system that runs views gives each `Following` a `caughtUp(then, soon)`: call `then` once this view has been
shown everything kept before the call. `soon` is true when an asker is blocked on it. With it, an answer reaches
the other end after the views that end follows show what the answer is about.

A link that comes back is given what opens a connection, and a backend takes connections as they arrive and hands
each to its link:

```ts
import { accept, link, socket, timers } from '@apackdev/link'

// A window: opens a socket now, and another after each one closes, on the clock it is handed.
const toBackend = link(() => socket(new WebSocket(url, [token])), { reopen: { clock: timers } })

// A backend: a new session is a new link; a known one is handed back to the link it was.
const take = accept((link) => { /* join(link, backendPort) */ })
server.on('connection', (ws) => take(socket(ws)))
```

A link has no clock of its own, and one that opens its own connections is not made without being handed one:
`link(open, { reopen: { clock, first, most } })` (`timers` is a clock on `setTimeout`, to hand it). A connection
has held once it has stayed up, after the other end said hello on it, for as long as the wait before it was
opened, and `first` at least. After one that held, the next is opened at once. After one that did not, met or
not, the link waits `first` milliseconds (100), doubled for each such connection in a row, `most` (10 000) at
most. So a backend that is not there, and one that says hello and goes every time, are each dialled ever more
slowly, and a connection that drops after doing its work is dialled again at once.

A transport that throws where it is handed something to send is a connection that has gone: what it was handed
is sent again on the next, and what it threw goes to `thrown`, since none of the transports here throws.

Whoever holds a link says when the other end is gone for good, with `close()`: until then what was sent is kept.
`accept` keeps each link until it ends, so a backend closes the link of a window it knows is gone; nothing ends
one by a clock.

A session's id is all a connection says to be handed that session's link. Who may connect is settled by whatever
takes the connections, before one is handed to `accept`: a token on the socket, a socket path only the user can
open.

A `Transport` is anything that takes a message, text or bytes, at one end and hands it over at the other, in
order, until it closes. Four are here, and none imports what it is carried on:

| | Carried on |
|---|---|
| `socket(ws)` | A browser's `WebSocket`, Node's `ws`: anything with their shared `send`, `close`, `readyState` and events. What is sent while it is opening waits for it to open |
| `port(p)` | A browser's `MessagePort`, Node's `worker_threads` port, Electron's `MessagePortMain` |
| `stream(duplex, { most })` | A Unix domain socket or a named pipe: each message crosses with its kind and length before it. One longer than `most` bytes (128 MiB unless given) closes the stream, as does anything that is not a message, and the stream beneath is destroyed. A link carried on it is told `most`, and sends nothing longer |
| `memoryPair()` | Two ends in memory, for specs |

Whoever holds the socket opens it, with whatever it needs to be let in.

## Specs under every order

`@apackdev/link/testing` is what this package's own specs are written with. A schedule stands in for the event
loop: each direction of a link is a lane, a lane keeps its order, and a scenario is run once for every way of
choosing between lanes.

```ts
import { link } from '@apackdev/link'
import { everyOrder, scheduledPair } from '@apackdev/link/testing'

await everyOrder((schedule) => {
  const [left, right] = scheduledPair(schedule)
  const a = link(left)
  const b = link(right)
  // ... what each end does ...
  return () => { /* what must hold once everything has come to rest */ }
})
```

A failure names the order that led to it and the choices to `replay` it with.

The scenarios are a kit. Each in `peers` is written against what the package exports and nothing else, and plays
over whatever two ends it is handed, so an end built another way, or carried on something else, is held to the
same file:

```ts
import { everyOrder, memoryEnds, peers } from '@apackdev/link/testing'

for (const scenario of [...peers, ...hold]) await everyOrder((schedule) => scenario.play(schedule, memoryEnds(schedule)))
```

Over something real, `carried(schedule, [left, right])` puts what arrives at each end into a lane of its direction,
and a run waits for what is on its way: this package runs every scenario over a WebSocket, a message port and a
stream of bytes as well as over memory.

`withoutTheHold` is the hold's scenarios with views that offer no `caughtUp`: each fails in some order, which is
how the scenarios are known to be able to.

## Not its job

- **A general RPC library.** It carries what states say to each other and nothing else.
- **Old peers and new.** Both ends ship together. An end that meets another it cannot talk to refuses it; nothing
  is negotiated.
- **What a frame means.** Which system takes an ask, and what a view is, are the kernel's.

## Where it is going

[`docs/plan.md`](docs/plan.md) is the plan, a step at a time, each with what it has to hold and how it is known to
be done:

0. Groundwork: a schedule that runs a spec under every order, a hello and a goodbye. **Built.**
1. Peers: asks matched to their answers, views followed and let go. **Built.**
2. The hold: what a step sends a window waits until that window's views have caught up. **Built.**
3. One write a turn. **Built.**
4. A socket, a message port and a stream of bytes to be carried on. **Built.**
5. A connection that comes back, with nothing taken twice. **Built.**
6. A bound on what waits, with a view's overtaken update let go. **Built.**
7. Knowing the other end is there by what it does, never by a time to reply. **Built.**
8. What caused a frame, a tap that never sees what one carries, and frames that are private. **Built.**
9. Bytes, and frames too large for one write.
10. Releases apack can pin, and the wire written down once.

Left out on purpose, with a plan of its own:
[views that never pass through the server's JavaScript](docs/deferred/views-from-the-engine.md).

## Developing

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Node 24.12 or later.
