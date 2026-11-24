# apack-link

One ordered stream between two systems of [apack](https://github.com/spankyed/apack): a window and its backend, or
any two things that run states. As a package, `@apackdev/link`.

**What one system sends another arrives once, in the order it was sent, or the sender is told it did not.**

Everything in [the plan](docs/plan.md) is built, steps 0 to 14. Nothing in apack uses it yet, so no end can be
left behind on an older one: the wire is link 1, and a change to what crosses is made at both ends at once.

| To | Read |
|---|---|
| use it | this page |
| look up an export | [`REFERENCE.md`](REFERENCE.md): every export, its doc comment and signature |
| speak to a link without this package | [`docs/wire.md`](docs/wire.md): everything an end sends, and an exchange recorded as it crossed |
| know why it is this way | [`docs/design.md`](docs/design.md) |
| change it | [`CLAUDE.md`](CLAUDE.md): where things are, and the rules; [`docs/plan.md`](docs/plan.md): each step and how it is known to be done |

## Why it exists

apack's states talk across a boundary in a handful of ways: one asks and is answered, one tells, one follows a
view and is shown what it holds. The design those states are written to
([apack-state](https://github.com/spankyed/apack/blob/master/docs/plans/apack-state.md)) rests on the order
between them. A window that is answered "created" has to have been shown the thing first, so the view's update
and the answer have to arrive in the order they were sent.

A general RPC layer does not promise that. It gives each subscription a pump of its own, and order between two
of them is whatever the timing gives. A link carries exactly what states say to each other, as frames on one
stream, and so can keep all of it in order.

## Use

A system offers a `Port`: what it can be told, asked and have followed. `join` puts one at an end of a link and
returns the port of the system at the other end.

```ts
import { dial, join, listen, memoryPair, type Port } from '@apackdev/link'

const backend: Port = {
  tell: (to, event) => {},
  ask: (to, name, args, heard, ended) => { ended({ ok: true, value: { id: 'THR-1' } }); return () => {} },
  follow: (feature, view, args, shown, over) => { shown(0); return { stop: () => {} } },
}
const [left, right] = memoryPair()
join(listen(right), backend)
const toBackend = join(dial(left), { tell: () => {}, ask: () => () => {}, follow: () => ({ stop: () => {} }) })

toBackend.ask('threads', 'CREATE', { topic: 'one' }, (update) => {}, (outcome) => console.log(outcome))
```

What `ask` returns is to be called when whoever asked has gone: the other end is told, and nothing more is heard
for it. A `Following`'s `stop` does the same for a view.

A system that runs views gives each `Following` a `caughtUp(then, soon)`: call `then` once this view has been
shown everything kept before the call. `soon` is true when an asker is blocked on it. With it, an answer reaches
the other end after the views that end follows show what the answer is about.

### Two ends that are not alike

The end that opened the connection dials. The other listens. Where neither opened it, a pair of message ports,
one of the two is chosen to dial: two that both listen never say anything.

| Made with | What it is |
|---|---|
| `dial(transport)` | Dials on one connection, and ends when it closes. What it sends goes at once, beside its hello |
| `dial(open, { reopen })` | Dials, opens its own connections, and opens another after each one closes. Numbers nothing until the other end has said hello |
| `listen(transport)` | Listens on one connection, and ends when it closes |
| `listen()` | Listens, and is handed each connection with `carry`: a `Listener` |
| `accept(onLink)` | A backend's: takes each connection with whose it is, makes a link that listens for an owner's new session, and hands a connection that says the session its owner has back to that session's link |

The end that dials says hello first, and ends for what it meets there. The end that listens says nothing on a
connection until a hello that fits has arrived on it, and ends for nothing said before one: what does not fit
is turned away, told why, and the link goes on with the connection it has.

```ts
import { accept, dial, socket, timers } from '@apackdev/link'

// A window: opens a socket now, and another after each one closes, on the clock it is handed.
const toBackend = dial(() => socket(new WebSocket(url, [token])), { reopen: { clock: timers } })

// A backend: each connection is taken with whose it is. An owner's new session is a new link, and a
// connection that says the session its owner has is handed back to that session's link.
const backend = accept((link, owner) => { /* join(link, backendPort) */ })
server.on('connection', (ws, request) => backend.take(socket(ws), windowOf(request)))
// When the host learns a window will not be back:
backend.gone(window)
```

### A link by itself

`join` is what most hosts use, and is written on what a link offers. `dial`, `listen` and `accept` each give a
`Link`:

| | |
|---|---|
| `send(frame, { cause, private })` | Sends a frame. Throws for one that cannot be sent, having taken no number. With no connection it waits |
| `prepare(frame, how)` | Encodes a frame now and returns what `send` takes later, once, without encoding it again |
| `onFrame((frame, cause) => …)` | Each frame the other end sent, once each, in the order it sent them |
| `onTraffic((traffic) => …)` | Each frame as it is numbered to go out and as it is taken in, as a tap sees it |
| `onEnd((ending) => …)` | Once, when the link has ended, with why |
| `close(bye)` | Ends the link, having sent what was sent, with a goodbye if one is given: `restarting` or `ended` |
| `kept()` | How many numbers this end keeps because the other has not said it took them |
| `waiting()` | How many frames wait to be numbered |
| `awaiting()` | Says this end is owed something, so that a quiet connection is watched while it is. What it returns is called when that has come |

`listen()` gives a `Listener`, which has one more: `carry(transport)` hands it a connection.

### What a backend has to do itself

- **Say who may connect, and whose each connection is.** A link authenticates nobody. Who may connect is settled
  by whatever takes the connections, before one is handed to `accept`: a token on the socket, a socket path only
  the user can open. The same place says whose it is, the owner it is taken with: whatever the host knows a
  dialler by, a window's id for one. It never crosses the link.
- **Say when an owner is gone.** A link outlives its connections, so a connection closing does not say the window
  is gone, and nothing ends a link by a clock. A session is held to its owner:
  - it is gone on with only by its owner, and a connection of anybody else's that says it is told it is lost;
  - an owner has one, so a window that reloads ends the session it had as it begins another;
  - `gone(owner)` ends an owner's session and closes its connections, when the host learns it will not be back.

  So a backend keeps no more sessions than it has owners it has not said are gone. A host with nothing to call
  an owner gives each connection its own, and says it is gone when the connection closes: a link that does not
  go on across a drop. What a window on another machine would need beyond this is
  [left out, with why](docs/deferred/remote-windows.md).

## What it carries

| Frame | Says |
|---|---|
| `tell` | Something happened. Nobody waits |
| `ask`, `answer` | A question, and how it ended. Answered once |
| `progress` | What the one answering says before it answers |
| `left` | Whoever asked has gone, and the work for them can stop |
| `follow`, `shown`, `unfollow` | A view: its result, and each changed result after it |
| `over` | The one running a view has ended it, and why |

Nothing else. A new frame is a new thing a state can say, and is added with the kernel that says it.

## What holds

### Once, and in order

- **Every frame is numbered, and taken only in turn.** A frame lost, doubled or out of place ends the link,
  saying why. So does anything that is not one of the frames above: an id is a whole number from 1, a name is
  text, a failure is a kind and a message. What a frame carries for a system is not looked at.
- **A window hears of a step after its views show it.** What a system says to the other end waits until the
  views it runs for that end have caught up with what was kept before it was said. A view's own updates are what
  is waited for, and go at once.
- **One message a turn.** What an end sends within one turn of the event loop crosses as one message, where it
  fits in one.

### Across a connection that drops

- **A link outlives what carries it.** Each end keeps what it sent until the other says it took it, and a new
  connection picks up where each end got to, within a frame in parts too. Nothing is taken twice.
- **Nothing is handed to a stranger.** An end that opens its own connections sends nothing until it has met the
  other end, so a window that starts before its backend listens starts with whichever backend it meets.
- **A connection takes a link's place only once it fits.** The end that listens keeps the connection it has
  until a hello that fits arrives on another. A hello that does not fit is turned away, and learns nothing of
  the session.
- **Opening again is paced on a clock handed in.** A link has no clock of its own, and one that opens its own
  connections is not made without one (`timers` is a clock on `setTimeout`, to hand it). After a connection that
  held, the next is opened at once. After one that did not, the wait is `first` milliseconds, doubled for each
  such connection in a row, `most` at the most. A connection has held once it has stayed up, after the other
  end said hello on it, for as long as the wait before it, and for `first` at least.

### What cannot be sent

- **One bad frame is one refusal.** A frame that cannot be sent throws where it was sent and takes no number:
  a `TypeError` for one that cannot be encoded, a `RangeError` for one larger than a frame may be
  (`bound.frame`) or sent with a cause longer than 1024 bytes. The link goes on, with nothing missing before
  the next frame. Through `join`, the one ask or view it belonged to fails, and no other.
- **`prepare(frame)` encodes a frame now, to be sent later** without being encoded again: what a peer holds for
  its views is refused where it was said, and crosses as it was when it was said.

### Sizes

Every size a link counts or reports is in bytes, of text as UTF-8.

- **Nothing has to be set to match.** A frame is cut, where it is numbered, to what the transport takes
  (`Transport.most`) and what the other end says it takes (each says so in its hello). It crosses whole where it
  fits, and otherwise as parts, each numbered and each as long as fits, and is handed over whole in the place of
  its first. `part` is only the most a part may be.
- **A batch is cut the same way:** into the fewest messages that fit, between the things said, in order.
- **`LEAST` is 1144 bytes,** and is the least any link is carried on, whatever it is set with: the shortest part
  (16), the longest cause (1024), what JSON puts around a thing numbered at the most (102), and the batch's two.
  A transport that takes less is closed as it is handed over, with a `RangeError`: thrown by `dial`, `listen`,
  `carry` and `accept`, and, for a connection a link opened for itself later, handed to `thrown` and counted as
  one that did not hold. A hello that says the other end takes less is `too narrow`.
- **What is kept is sent again as it was.** So a connection that takes less than something an end still keeps,
  and the hello on it does not say was taken, cannot carry it. That is found at the hello: the end that listens
  turns the connection away, and the end that dialled ends `too narrow`.

### Bounded

- **How far behind the other end is, is what it has not said it took.** Past a mark (`bound.kept`) a link stops
  numbering what is sent, and it waits.
- **Only a view's overtaken result is let go.** One that a later result of the same view overtakes while it
  waits is dropped: only the last matters. Nothing else is.
- **Past the bound on what waits (`bound.waiting`) the link ends `overrun`,** saying by how much.

### Knowing the other end is there

- **Never a time to answer in.** What carries a link saying it closed is how an end knows the other has gone.
  An ask that takes an hour is not a link that has gone.
- **A connection that can go quiet without closing is watched** only where a clock is handed in (`there`), and
  only while this end is owed something, a `taken` or an answer. With nothing at all arriving for half the
  window it asks whether the other end is there, and after a whole window it lets the connection go and another
  is opened.

### Listeners, closing and ending

- **A listener that throws loses nothing.** Every frame of the batch is still taken, in order, every other
  listener is still called, and the link goes on. What was thrown goes to `thrown`. A system joined to a link is
  a listener.
- **A transport that throws where it is handed something to send is a connection that has gone.** What it was
  handed is sent again on the next, and what it threw goes to `thrown`.
- **Closing sends what was sent.** `close()` sends everything sent before it, what waited for room included,
  and then the goodbye, wherever it can arrive no more than once: on a connection where the other end has been
  met, and on any connection of an end that has never met anybody. What waited with nowhere to go is let go.
- **Ending is said once, to both ends, with why.** Every ask waiting ends `disconnected`, every view followed is
  said to be over, and whatever an end was answering or showing for the other is told to stop.

### What may be seen

- **What caused a frame crosses with it.** `send(frame, { cause })`, and `onFrame` hears the cause.
- **A tap never sees what a frame carries.** `onTraffic` is told of each frame out and in: its direction,
  number, kind, id, name, size and cause. Of one sent `{ private: true }`, only that it crossed, its number and
  its size.
- **Nothing a link reports holds what a frame carries.** An ending names a kind, a number or a size, and what is
  thrown for a frame that cannot be encoded is the link's own.

## How a link ends

`onEnd` is called once, with one of these.

| `why` | It ended because | Also says |
|---|---|---|
| `closed` | this end was closed, or the one connection of a link that does not come back went | |
| `goodbye` | the other end said it was going | `bye`: `restarting` or `ended` |
| `lost` | the session cannot be gone on with: the other end is a new one, or does not hold what is needed | |
| `version` | the other end is another link | `mine`, `theirs` |
| `out of order` | a number arrived that was not the next | `expected`, `got` |
| `not a frame` | what arrived was not something a link says | `size` |
| `overrun` | what waits to be sent passed its bound, with nothing left to let go | `waiting`, `bound` |
| `too narrow` | the connection takes no message as long as this end needs | `most`, `needs` |

Only the end that dials ends for the first thing said on a connection, `lost`, `version`, `too narrow` or
`not a frame`: the end that listens turns the connection away and goes on.

## What a link is set with

`dial`, `listen` and `accept` take the same options. Two things have to agree between the ends, and nothing
else: both are given the same `codec`, and the end a frame arrives at is given a `bound.frame` no less than the
end that sent it.

| Option | What it sets | Unless given |
|---|---|---|
| `reopen: { clock, first, most }` | The clock an end that opens its connections paces them on, and the first wait and the longest, in milliseconds | No default clock: `dial(open)` throws without one. `first` 100, `most` 10 000 |
| `there: { window, clock }` | How long a connection may be quiet while this end is owed something | Nothing is watched |
| `bound.kept: { frames, size }` | How much sent and not yet taken there may be before nothing more is numbered | 1024 frames, 16 MiB |
| `bound.waiting: { frames, size }` | How much may wait to be numbered before the link ends `overrun` | 16 384 frames, 64 MiB |
| `bound.frame` | How many bytes one frame and its cause may be. 1024 at least. A larger one is refused where it is sent, and one arriving in parts that add up to more ends the link `not a frame` | 64 MiB |
| `part` | The most a part, and a message of several things, may be, in bytes. 16 at least | 1 MiB |
| `codec` | What batches are encoded in. One that puts more around a frame than JSON does is refused | JSON |
| `thrown(error)` | Handed what a listener, opening a connection, or a transport's `send` threw | Thrown again in a turn of its own |
| `later(run)` | What puts a batch off until the end of the turn. A spec gives a schedule's lane | A microtask |

## What it is carried on

A `Transport` is anything that takes a message, text or bytes, at one end and hands it over at the other, in
order, until it closes. It may say the longest message it carries (`most`) and how much it has not yet written
(`waiting`). Four are here, and none imports what it is carried on:

| | Carried on |
|---|---|
| `socket(ws, { most })` | A browser's `WebSocket`, Node's `ws`: anything with their shared `send`, `close`, `readyState` and events. `most` is the longest message the server takes, where it has a limit. What is sent while it is opening waits for it to open |
| `port(p)` | A browser's `MessagePort`, Node's `worker_threads` port, Electron's `MessagePortMain` |
| `stream(duplex, { most })` | A Unix domain socket or a named pipe: each message crosses with its kind and length before it. One longer than `most` bytes (128 MiB unless given) closes the stream, as does anything that is not a message, and the stream beneath is destroyed |
| `memoryPair()` | Two ends in memory, for specs |

Whoever holds the socket opens it, with whatever it needs to be let in.

## Specs under every order

`@apackdev/link/testing` is what this package's own specs are written with. A schedule stands in for the event
loop: each direction of a link is a lane, a lane keeps its order, and a scenario is run once for every way of
choosing between lanes.

```ts
import { dial, listen } from '@apackdev/link'
import { everyOrder, scheduledPair } from '@apackdev/link/testing'

await everyOrder((schedule) => {
  const [left, right] = scheduledPair(schedule)
  const a = dial(left)
  const b = listen(right)
  // ... what each end does ...
  return () => { /* what must hold once everything has come to rest */ }
})
```

A failure names the order that led to it and the choices to `replay` it with.

**The scenarios are a kit.** Each in `peers` and `hold` is written against what the package exports and
nothing else, and plays over whatever two ends it is handed, so an end built another way, or carried on
something else, is held to the same file:

```ts
import { everyOrder, hold, memoryEnds, peers } from '@apackdev/link/testing'

for (const scenario of [...peers, ...hold]) await everyOrder((schedule) => scenario.play(schedule, memoryEnds(schedule)))
```

Over something real, `carried(schedule, [left, right])` puts what arrives at each end into a lane of its
direction, and a run waits for what is on its way: this package runs every scenario over a WebSocket, a message
port and a stream of bytes as well as over memory. The scenarios in `resume` play over two
ends whose connection can be dropped and whose backend can be restarted: `droppingMemoryEnds` is that, in memory.

**A run can be held to the model:** a queue each way between two ends, and whether each end is still there.
`model()` is that, and each link put under it is noted as it is sent to, hands over and ends. Its `check` throws
for the first thing an end did that the model could not have, with what led to it: a frame out of turn, twice,
changed, with another cause or from nowhere, anything handed over after an ending, an ending for what crossed,
a session lost with both ends still there, and at rest, what was sent and never handed over. `underModel` puts
its check after a scenario's own:

```ts
import { everyOrder, memoryEnds, peers, underModel } from '@apackdev/link/testing'

for (const scenario of peers) await everyOrder((schedule) => underModel((held) => scenario.play(schedule, memoryEnds(schedule, {}, held))))
```

`withoutTheHold` is the hold's scenarios with views that offer no `caughtUp`: each fails in some order, which is
how the scenarios are known to be able to.

## Not its job

- **A general RPC library.** It carries what states say to each other and nothing else.
- **Old peers and new.** Both ends ship together. An end that meets another it cannot talk to refuses it;
  nothing is negotiated.
- **What a frame means.** Which system takes an ask, and what a view is, are the kernel's.
- **Who is at the other end.** That is for whatever takes the connections.

Decided against, each with why: [causal delivery in place of the hold](docs/wont-do/causal-delivery.md),
[credit the other end grants](docs/wont-do/credit-based-flow-control.md) and
[resume outside the core](docs/wont-do/resume-outside-the-core.md). Left out for now, each with a plan of its
own: [a window on another machine](docs/deferred/remote-windows.md) and
[views that never pass through the server's JavaScript](docs/deferred/views-from-the-engine.md).

## Getting it

Never from npm. Each commit on `master` whose CI passed is released as `pkg-<commit>`, with the tarball attached:

```bash
npm install https://github.com/spankyed/apack-link/releases/download/pkg-<commit>/apackdev-link-0.1.0.tgz
```

It has no dependencies at run time, and runs in a window and in Node from one source.

## Developing

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run reference:check    # REFERENCE.md as the source says; :update writes it
npm run package:smoke      # the tarball installed elsewhere, and the README's first example run from it
```

Node 24.12 or later.

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option; the npm package ships
both texts.
