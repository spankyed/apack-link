# The plan: everything a link is to be

Status: built. Steps 0 to 14 are complete.

This is written to be handed to whoever builds it, with nothing else in hand but this repository. It says what to
build, in what order, what each step has to hold, and how each is known to be done. `README.md` says what a link is
for and `docs/design.md` why it exists; read both first.

One thing is left out on purpose and has a plan of its own:
[views from the engine](deferred/views-from-the-engine.md).

## What is being built

A window and its backend each run states. What they say to each other is eight kinds of frame (`src/frames.ts`),
nine with step 1's. A
link is to carry them so that:

1. **Order.** What one end sends, the other takes in the order it was sent, whatever kind each frame is.
2. **Once.** A frame is taken once, across a connection that drops and comes back.
3. **A window hears of a step after its views show it.** What a backend sends a window waits until the views that
   window follows have been shown what the step kept.
4. **Nobody waits on a link that has gone.** Every ask ends, and every view is said to have ended, when the link
   does.
5. **One bad frame is one refusal.** Nothing a single frame holds ends the stream.

Each step below is held to these. A step that would give one up to gain something else is the wrong step: say so
and stop.

## The pieces, and what each is for

```
a system (the kernel's)          this repository                     what carries it
        │
     Port  ◄── join ──►  Peer ──►  Link ──►  Transport  ──►  a socket, a message port, memory
                       asks, views    frames numbered,      text or bytes, in order,
                       the hold       batched, resumed      until it closes
```

- **`Transport`** (`src/transport.ts`): takes text at one end and hands it over at the other, in order, until it
  closes. Built, with two ends in memory.
- **`Link`** (`src/link.ts`): one end. Numbers frames out and takes frames in only in turn. Built. Batching,
  resuming and the bound are added to it.
- **Peer** (to build, `src/peer.ts`): gives meaning to ids. It matches an ask to its answer, a followed view to
  what it is shown, and holds what a step sends until the views have caught up.
- **`Port`**: what one system offers another. It is the kernel's shape, and a peer turns one into frames and
  frames into one:

  ```ts
  /** What one system offers another. */
  export interface Port {
    /** Something happened. Nobody waits. */
    tell(to: string, event: unknown): void
    /** Asks. `heard` takes what is said before the answer, `ended` how it ended. Returns what to call when whoever asked has gone. */
    ask(to: string, name: string, args: unknown, heard: (update: unknown) => void, ended: (outcome: Outcome) => void): () => void
    /** Follows a view. `shown` takes its result and each changed result after it, `over` that it has ended and why. */
    follow(feature: string, view: string, args: unknown, shown: (update: unknown) => void, over: (failure: { kind: string; message: string }) => void): Following
  }
  export interface Following {
    stop(): void
    /**
     * Calls `then` once this view has been shown everything kept before the call. `soon` says something is
     * blocked on it. Offered by a system that runs views; one reached across a link has none.
     */
    caughtUp?(then: () => void, soon: boolean): void
  }
  /** How an ask ended. The kernel's own outcomes pass through as they are; these are the ones a link makes. */
  export type Outcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly failure: { readonly kind: string; readonly message: string } }
  ```

  This is the kernel prototype's `Port` with its verbs named as the frames are. The prototype is in
  `spankyed/apack`, on the branch of pull request 590, at `docs/plans/apack-state/prototype/state.mts`: search it
  for `interface Port`, `carry(`, `toAWindow` and `connect:`. Its link is what steps 1 and 2 move here.

  ```ts
  /** Joins a system to the other end of a link: `mine` is what this system offers, and what is returned is what the other does. */
  export function join(link: Link, mine: Port): Port
  ```

## Rules for every step

These are the repository's (`CLAUDE.md`), and each has broken a design like this one before.

- **Order is the point.** No second stream beside the first, for any kind of frame, for any reason.
- **No clock decides anything.** Nothing is given a fixed time to reply. Step 7 says what a link may know of time.
- **No dependencies at run time.** One source runs in a window and in Node. A socket, a codec and a clock are
  handed in.
- **Nothing that can fail runs between a frame taking its number and its text reaching the transport.**
- **What a frame carries is never put in an error, a log or a trace.** A reason names a kind, an id and a size.
  (`Ending`'s `'not a frame'` carries the length of the text.)
- **A spec says what holds, not how.** Where order matters, the spec runs every order (step 0's schedule), and a
  scenario that cannot fail is shown able to: the same scenario with the guarantee taken out has to fail.
- **Mutate a copy.** Before a step is called done, change the code in a copy of the tree, one guarantee at a time,
  and see a spec fail for each. A change no spec notices is a spec to write. Say in the pull request what was
  changed and what caught it. Never mutate the working tree itself.
- **Comments say what the code is**, for whoever opens the file cold. What it used to be is the commit's to say.
- **One pull request a step**, into `master`, with `README.md`, `docs/design.md` and this file brought up to
  what the step made true. No attribution lines in commits or pull requests.

## Step 0. Groundwork

Built. The schedule is `@apackdev/orderings`, a package of its own, with `scheduledPair` here for two ends in memory whose
directions are lanes. `memoryPair` takes what says when a text arrives for each direction, and hands an end's
closing over after what that end sent before it. An end that says another number ends the link
`{ why: 'version', mine, theirs }`; a goodbye is `link.close('restarting')` or `link.close('ended')`, and the
other end ends `{ why: 'goodbye', bye }`. What was read of DDP and the Language Server Protocol is in
`docs/design.md`; MQTT is read before step 5.

Small things every later step stands on.

- **A reason never carries what was sent.** `Ending`'s `'not a frame'` gives the length of what arrived, not its
  text.
- **A schedule, for specs**, `@apackdev/orderings`. It stands in for the event loop:
  everything put off goes into a lane, a lane keeps its order, and `explore` runs a scenario under every choice
  between lanes, `sample` under a seed's worth, `replay` one again. `memoryPair` already takes what says when a
  text arrives: given a lane of the schedule for each direction, a link's two directions and anything else a spec
  adds are run in every order.
- **The scenarios are a kit, and not only this package's specs.** Every scenario from step 1 on is written
  against `Port`, `Link` and `Transport` as they are exported and reaches into nothing else, and is exported from
  `@apackdev/link/testing` to be run over any pair of ends it is handed. Another implementation of an end, in
  another language behind a transport, is then held to the same file. WebSocket and WAMP each have such a suite,
  and it is what keeps two implementations one protocol.
- **What was read.** Before step 1, Meteor's DDP specification and the base protocol of the Language Server
  Protocol (its requests, notifications, progress and cancelling); before step 5, MQTT's rules for a session.
  `docs/design.md` gets a section saying what was taken from each and what was declined, with why, so that it is
  not argued again.
- **Hello.** The first thing each end sends is `{ link: 1 }`. An end that hears another number closes, with an
  ending that names both. The number is 1 and stays 1 until something exists that cannot move with it: both ends
  ship together.
- **What a link says about itself takes no number.** Hello is the first of these, and steps 5 and 7 add what was
  taken and whether the other end is there. Only a frame is numbered, kept to be sent again, and counted against
  a bound. A link that numbered its own words would keep more for a resume the longer it sat idle.
- **Goodbye.** An end that is going on purpose, a backend restarting, says `{ bye: 'restarting' }` or
  `{ bye: 'ended' }` before it closes. The other end's ending then says which: one that is restarting is to be
  reached again, and one that ended is not. Without it both look like a connection that was lost.

Done when: the specs there are pass under `explore` where they have more than one lane, an end that says
`{ link: 2 }` is refused by name, and each kind of goodbye ends the other end saying which it was.

## Step 1. Peers

Built. `src/peer.ts` is `join`, `Port`, `Following` and `Outcome`; `over` is the ninth frame. The scenarios are
`peers` in `src/testing/scenarios.ts`, exported from `@apackdev/link/testing` with `desk` (a system that notes
what reaches it), `asking`, `watching` and `memoryEnds`. Beyond what is below: a system that throws where it is
asked or followed fails that one; a value a view shows that cannot be sent ends the view `over`; and an `ask` or
`follow` with an id already used is not taken.

`src/peer.ts`, `join`.

- **An ask.** `ask` on the returned port sends `ask` with a new id and remembers `heard` and `ended` under it.
  `progress` with that id calls `heard`, `answer` calls `ended` and forgets it. What it returns sends `left` and
  forgets it: nothing that arrives for the id after is heard. On the other end `ask` arrives, `mine.ask` is called,
  and what it is told goes back as `progress` and `answer`. `left` arriving calls what `mine.ask` returned.
- **A view.** The same shape: `follow`, `shown`, `unfollow`, with `stop` letting go at both ends.
- **A view the one running it ends.** A pack reloads, or the view is not there to follow: the follower has to be
  told, and `unfollow` is the follower's alone. A ninth frame, `over`, with the view's id and a kind and a
  message as a failed ask has, says the view has ended and nothing more will be shown. `Port.follow` takes what
  to call with it, beside `shown`. A `follow` of a view there is not is answered `over` at once. Meteor's DDP has
  this as `nosub`.
- **A tell** is a frame each way.
- **Ids.** Each end numbers its own asks and its own views from 1. An id is used once in a link's life.
- **When the link ends**, every ask waiting at this end ends `{ ok: false, failure: { kind: 'disconnected', … } }`,
  once; everything this end was answering is told its asker has gone; every view this end runs for the other is
  stopped. A frame for an id nobody holds is dropped: it is one that crossed a `left` or an `unfollow` on the way.
- **A frame that cannot be sent.** `Link.send` throws for a frame that cannot be put into text. For an `answer` or
  a `progress`, the peer answers the ask `failed`, saying a value could not be sent, and does not throw into the
  system that was answering. For an `ask`, the asker's `ended` is called with the same. Nobody is left waiting.

Specs, each under every order of the two directions: an ask is answered once; progress is heard before its answer
and in the order sent; an ask left before its answer hears nothing after; two asks cross each way at once; a view
shown, changed, and let go; a view ended by the one running it, and one there is not; the link ending with an ask waiting, an ask being answered and a view followed, each
ended once and none twice; an answer that cannot be sent fails that ask and the next ask is answered.

Done when: those hold, and the mutants are caught: an answer delivered twice, an ask not ended when the link ends,
`left` not passed on, a frame for a forgotten id delivered.

## Step 2. The hold

Built, in `join`. The scenarios are `hold` in `src/testing/scenarios.ts`, run against `made`
(`src/testing/views.ts`), the stand-in for views; `withoutTheHold` is the same with views that offer no
`caughtUp`, and each is shown to fail. Two things go beyond what is below: what is held is everything the system
says, its own `ask`, `follow`, `left` and `unfollow` too, so that nothing it says passes something it said before;
and `over`, like `shown`, is not held.

What a system sends the other end waits until the views that end follows have caught up. In `join`.

- A peer knows the views it runs for the other end: each is a `Following` that `mine.follow` returned.
- What `mine` sends toward the other end is one queue, in the order it was handed over: `tell`, `progress`,
  `answer`. `shown` is not held: it is what is waited for.
- When something is put on an empty queue, or more is put on one already waiting, the peer asks each view it runs
  that offers `caughtUp` to call it back, and sends what was queued **before that was asked** once all have. What
  is queued after waits for a round of its own.
- `soon` is true when an `answer` is among what waits: an asker is blocked on it. A `tell` or `progress` alone
  waits at the views' own pace.
- A view that stops while waited on counts as caught up. A view with no `caughtUp` is not waited on. An end that
  follows nothing is held for nothing.
- A view followed after something was queued is not waited on for it: what was queued came before the view.

Why "since it was asked", and not "until every view is idle": measured on elmdb, waiting for every view to be idle
under a steady stream of writes took up to seconds and sometimes did not end (twelve views, a write every 2 ms).
Waiting is for these views to have run once since the call.

Specs, with a stand-in for views whose `caughtUp` calls back in a lane of its own: asked for one thing and then
another, and for two at once, the asker is answered and told only after its view was shown the thing, under every
order; with the hold taken out there is an order in which it is told first; an end that follows nothing is told at
once; a view stopped while waited on does not hold the queue; what is queued after a round began waits for the
next; `soon` is passed for an answer and not for progress alone.

Done when: those hold, and the mutants are caught: nothing held, everything released at the first callback,
`shown` held too, `soon` always or never.

## Step 3. One write a turn

Built, in `src/link.ts`. `dial(transport, { later })` takes what puts the batch off. `close` sends what was said
before it closes, with a goodbye last.

What an end sends within one turn of the event loop crosses as one text.

- The wire's unit becomes a batch: `[hello?, ...Sent]` as one text. A frame is put into text when it is sent, so
  one that cannot be still throws there alone; the batch is those texts joined.
- The batch leaves on a microtask. `Link` takes what puts something off, as `memoryPair` does, so a schedule can
  choose when.
- Order is unchanged: within a batch and across batches, by number.

Done when: a thousand frames sent in one turn are one text and arrive in order, a frame refused in the middle
leaves no gap, and the specs of steps 1 and 2 pass unchanged.

## Step 4. Things to be carried on

Built: `src/socket.ts`, `src/port.ts`, `src/stream.ts`. `Transport` is `send(message)`, `onData`, `onClose`,
`close`, with `Message = string | Uint8Array`. The scenarios run over each in `tests/scenarios.spec.ts`: every order
over memory, twenty over each of the others, since a real connection per order makes every order too slow to run.

- **A socket**: `socket(webSocketLike): Transport`, taking anything with `send`, `close` and the events a browser's
  `WebSocket` and Node's `ws` share. Neither is imported. The token apack sends as a subprotocol is the host's to
  set when it opens the socket.
- **A message port**: `port(messagePortLike): Transport`, for a browser's `MessagePort`, Node's `worker_threads`
  and Electron's.
- **Text or bytes.** `Transport` carries `string | Uint8Array`, for step 9.
- **A stream of bytes**: `stream(duplexLike): Transport`, for a Unix domain socket or a named pipe. A stream has
  no edges between messages, so each text crosses with its length before it.

Which of these apack's windows and tools are carried on is apack's to decide, and is not decided: its deferred plan
is `docs/plans/deferred/what-a-window-reaches-its-backend-over.md` (spankyed/apack#623). A link is the same over
each, which is what lets that be decided later.

Specs run a real `ws` server and client in one process (a development dependency), a `worker_threads` pair, and
a `node:net` server on a socket path: steps 1 and 2's scenarios once more over each. A stream that hands over
half a text, and two texts at once, is one of them.

Done when: the same scenario file runs over memory, a socket, a message port and a stream of bytes, named in its
output.

## Step 5. A connection that comes back

Built, in `src/link.ts`: `dial(open)`, `listen()` with `carry`, `accept`, and `kept()`. The scenarios are `resume` in
the kit, run over `droppingMemoryEnds`, whose connection a lane drops, or whose second end a lane restarts. Two
things beyond what is below. A hello says which session it is going on with (`resumes`) once its end has met
one, and a link that can come back numbers nothing until it has met the other end: an end that has met nobody
has handed nothing to anybody, so a window whose first connection reached nobody, or dropped before it heard
anything, starts afresh with whichever backend it meets, and a backend that restarted finds a window going on
with another session and says `lost`. And `open` is called again when a clock handed in says
(`Options.reopen`, without which such a link is not made), waiting longer for each connection in a row that did
not hold, and not at all after one that did.

A link outlives what carries it.

- `link` is given what opens a transport, and opens another when one closes without the link having been ended.
- Each end keeps what it has sent until the other says it took it. Every batch says the last number its sender has
  taken (`taken`), and what was sent up to that number is let go.
- A new connection's hello says who it is and where it got to: `{ link: 1, session, taken }`. The other end sends
  again everything after `taken`, in order, and then goes on. A frame is still taken only in turn, so nothing is
  taken twice.
- An end that does not know the session, or no longer holds what is asked for, says so, and the link ends
  `{ why: 'lost' }`: step 1's ending then ends every ask and stops every view, as when a link closes.
- While there is no connection, what is sent waits, within step 6's bound.
- **Whoever holds a link says when the other end is gone for good.** A window that crashed will not come back, and
  nothing a link can see tells that from one that is slow to return. A link is not given a time to wait: the host
  says whose each connection is as `accept` takes it, and says an owner is gone with `gone(owner)`, which ends
  its session; an owner that begins a session ends the one it had (the design, "A session has an owner"). What was kept for
  that end is let go then. Until it is said, what is kept is bounded by step 6 and by nothing else. MQTT and TCP
  each answer this with a timer, which is what is not done here.
- An end that said goodbye as `restarting` is one to open a connection to again, and its hello may start a new
  session: then the link ends `lost` as above, and whoever holds it joins anew. One that said `ended` is not
  reached again.
- **An ask is delivered at most once**, because a frame is. An answer that was lost on the way is one of the
  frames sent again. Nothing has to remember answers apart from that.

Specs under every order, with a transport that a lane of the schedule closes at any moment: an ask made, the
connection dropped before the ask arrives, as it is answered, and after the answer left: answered once each time,
and the answerer asked once; a view goes on being shown after a drop, with nothing shown twice; a link that cannot
be resumed ends, and every ask with it.

Done when: those hold, and the mutants are caught: nothing sent again, everything sent again, `taken` never
advanced, a resume that should be refused taken.

## Step 6. A bound

Built, in `src/link.ts`, with `Transport.waiting()` on a socket and a stream. Two things differ from what is
below. An overtaken `shown` is replaced in place, the later result in the earlier one's place, not dropped: what
was said between them must not pass a result that shows it. And what is kept never passes its bound, because
numbering stops at the mark. So nothing kept is let go, and a resume is never refused for it.

- What waits to be sent, and what is kept until it is taken, each have a size, counted in frames and in bytes of
  text, set where the link is made.
- **What can be let go is.** A `shown` for a view that has a later `shown` waiting behind it, not yet numbered, is
  dropped: only the last matters. Nothing else is dropped.
- **How far behind the other end is, is what it has not said it took.** Every batch says the last number its
  sender has taken (step 5), so the frames sent and not yet taken are counted the same over anything a link is
  carried on. Past a mark, a link stops numbering and lets frames wait where they can still be let go. A message
  port, which has no buffer to ask about and pushes back on nothing, is why this is the measure and not the
  transport's own. A transport that can say how much it has not yet written (`waiting(): number`) is asked as
  well. HTTP/2 and AMQP have the one receiving say how much it will take, for the same reason.
- An end says what it has taken when it has handed a batch over, without waiting for another batch of its own to
  carry the word: an end that only listens still has to say.
- **Past the bound with nothing left to let go**, the link ends `{ why: 'overrun' }`, saying which bound and by how
  much. A link that grew without end would end the process instead.
- What is kept for resuming and passes its bound is let go, oldest first, and a resume that needs it is refused
  (step 5's `lost`). A connection that is up is not ended for it.

Done when: a view that changes ten thousand times while nothing is taken is one frame when taking goes on, over
memory and over a message port; ten thousand answers past the bound end the link by name; an end that only
listens is not taken for one that is behind; the order of what does arrive is the order sent.

## Step 7. Knowing the other end is there

Built, in `src/link.ts`: `Options.there = { window, clock }`, `Clock.after(ms, run)`, and `Link.awaiting()`, which
a peer calls for each ask it waits on. It asks at half the window and lets the connection go at the whole of it.

- **What carries a link saying it closed is the first word, and for two ends on one machine the only one needed.**
  A process that ends closes its sockets.
- For a transport that can go quiet without closing (another machine): while this end is owed something, an
  answer or a `taken`, and nothing at all has arrived, it sends `{ there: n }`, which is answered `{ here: n }`.
  It ends the connection, to be opened again by step 5, only after a window in which **nothing of any kind**
  arrived. Anything arriving starts the window again. The window's length and its clock are handed in.
- Nothing is ever given a time to answer in. An ask that takes an hour is not a link that has gone.

Done when, with a clock the spec moves: a link that is owed nothing sends nothing however long it is idle; one
that is owed something and hears nothing asks, and reconnects after the window; any frame arriving resets it; an
ask outstanding for many windows with progress arriving is left alone.

## Step 8. What caused a frame, and what may be seen of it

Built, in `src/link.ts` and `src/peer.ts`: `send(frame, { cause, private })`, `onFrame(heard(frame, cause))`,
`onTraffic`, `bytesOf` in `src/frames.ts`, and `how?: Sending` across `Port` methods and callbacks.

- **Cause.** `send(frame, cause?)`, and a frame arrives with the cause it was sent with. A cause is a short text
  the kernel makes, naming the step that sent the frame. A link passes it on and never reads it.
- **Tap.** `link.onTraffic(seen)` is told of each frame out and in: its direction, number, kind, id, the name of an
  ask or a view, the size of its text, and its cause. **Never what it carries.**
- **Private.** A frame may be marked private. A tap is told a private frame crossed and its size, and nothing
  else of it: no name, no id. This is what a secret travels in.

Done when: a tap sees every frame in order, a cause crosses, and a spec that puts a marker in every payload and
every private frame's name finds it in nothing a tap, an ending or a thrown error holds.

## Step 9. Bytes, and frames too large for one write

Built: `src/codec.ts` (`Codec`, `json`), `Options.codec` and `Options.part`, and `Link.prepare`. A codec encodes one
value and joins values already encoded, which is what lets a frame still be refused alone where it is sent.

- **A codec is handed in**: what turns a batch into `string | Uint8Array` and back. JSON is the one built in.
  msgpack is given by a host that has it; a spec runs one as a development dependency.
- **A large frame crosses in parts.** A frame whose text passes a size set where the link is made is sent as
  parts, each a unit of the batch, and put together where it arrives. Its place in the order is the place of its
  first part, and nothing is taken between its parts. This bounds one write and lets a resume pick up within a
  large frame; it does not let another frame pass a large one, which order forbids.

Done when: steps 1, 2 and 5's scenarios pass with msgpack; a frame of fifty megabytes crosses a socket in parts,
arrives whole and in its place, and survives a drop part-way.

## Step 10. Releases

Built: `.github/workflows/packages.yml` (a `pkg-<commit>` release for each `master` commit whose CI's `ci-pass`
passed), `scripts/package-smoke.mjs` (the tarball installed into an empty project, each entry imported, and the
README's first example run there as it is written), `scripts/reference.mjs` with `REFERENCE.md`, which also fails
for an export no spec uses, `scripts/workflows-check.mjs` (no workflow publishes to npm or holds a token for it),
and `docs/wire.md` with `tests/wire.spec.ts`. Naming the package in apack's `external-packages.mjs` is apack's,
and is not done here.

As apack's other repositories do: each commit on `master` packs the package and attaches the tarball to a release
tagged `pkg-<commit>`, which apack names in its `overrides` and moves with `npm run deps:pin`. The tarball is
`apackdev-link-0.1.0.tgz`. `spankyed/apack-git`'s workflow is the one to follow, and
`spankyed/apack`'s `scripts/lib/external-packages.mjs` the table it is named in.

Also here:

- `npm run reference:check` and `:update`, a `REFERENCE.md` made from what `src/index.ts` exports, as `apack-git`
  has, so that a change to what the package offers shows in a diff.
- **Everything needed to speak a link is exported, and the wire is written down once.** A test client, a tool and
  an agent driving the app each reach a backend, and none should work the wire out again: apack's testing
  package wrote tRPC's frames by hand from its built files. `docs/wire.md` says every text an end may send, and a
  spec holds the package to it: a recorded exchange, hello to goodbye with one of each frame, compared text for
  text. A change to the wire then shows as a change to that file.

Done when: a commit on `master` has a release with the tarball, a fresh project that installs it by that address
runs the README's example, and a change to any text an end sends fails the wire's spec until `docs/wire.md` and
the recording say the same.

## Step 11. A model, and every run held to it

Built: `src/testing/model.ts` (`model`, `underModel`), which `memoryEnds` and `droppingMemoryEnds` take, and
`tests/model.spec.ts`. The scenarios over memory, over each thing a link is carried on, and the ones that drop and
restart are all run under it.

A scenario checks what its systems saw, and says nothing of what it did not think to look at. The model is the
whole of what a link is for, in a few lines: a queue each way, a view's result that may take the place of the last
of its view still crossing, and ends that are handed nothing once they are gone. A link is put under it where a
scenario is handed it, and every send, hand-over and ending is held to what the model could do next.

Done when: every scenario passes under the model in every order it is run in, and a spec shows the model finding
each of a frame out of turn, twice, changed, from nowhere or after an ending; an ending for what crossed; a
session lost with every end there; and what was sent and not handed over at rest.

## Step 12. What an end does, apart from what does it

Built: `src/core.ts` (`core`, `setup`, `start`, `ready`, with `State`, `Event` and `Effect`), `src/link.ts` as what
tells it each thing that happens and does what it says, `tests/support/space.ts` and `tests/core.spec.ts`. Nothing
that crosses changed, and no spec that was there before did.

A link was one closure: what it held, its transports, its clocks and its listeners in one place, each reaching the
others in the middle of whatever it was doing. Every fix to it touched three or four of those at once. Here what an
end does is a function of what it holds and what happened, returning what is to be done, and everything real is
outside it. A step is whole before anything it asked for is done, so nothing a listener or a transport does
arrives in the middle of one.

Done when: every spec there was passes as it was written, the recorded exchange in `docs/wire.md` is the same text
for text, and the core is run from every state two ends can reach under a script (sending, dropping, restarting,
closing, a watched connection), each state held to the model and to what an end holds adding up.

## Step 13. An end that dials, and one that listens

Built: `dial` and `listen` in place of `link`, `Listener` (a `Link` with `carry`), `role` and `connections` in the
core's `Setup`, and `tests/roles.spec.ts`. What crosses changed: an end that listens says nothing on a connection
before a hello that fits, and tells a link of another number which link it is.

An end was one of three kinds, by what it was made with, and both said hello at once; who waited for whom was a
case inside one of them. Here the two ends are named for what they are. The one that opened the connection says
hello first and ends for what it meets, and the other answers, and ends for nothing a stranger says.

Done when: every scenario passes over an end that dials and one that listens, in every order and from every
state; an end that listens says nothing before a hello that fits, on one connection or handed many; it is ended
by nothing said before one; and an end cannot be set to dial and be handed connections, or to listen and open them.

## Step 14. Parts cut to fit

Built: a part as long as a connection has room for, `LEAST`, and `narrowest` and `around` in the core.

How long a part was, how large a frame might be and how long a message the transport took had to agree, and a link
left as it came was refused by a server that took a megabyte. Now a frame is cut, where it is numbered, to what
the transport and the other end take; `part` is only the most a part may be; and the least a link is carried on
is one number, 1144 bytes, that depends on nothing it is set with: the shortest part, the longest cause, the
102 bytes JSON puts around a thing numbered at the most, and the batch's two. What is kept is sent again as it
was, so the one thing still refused is a connection narrower than what is kept, and not yet taken, was cut for.

Done when: a link left as it comes is carried on anything that takes 1144 bytes, at either end, with a frame as
large as one may be; and nothing sent is longer than either end takes, whatever a frame holds and however far
the numbering has got.

## What is not this plan's to build

These land with apack-state, by whoever is doing that work, and are here so the seam is known.

- **elmdb's `caughtUp()`** on a watch: what step 2's `Following.caughtUp` is over, in the app. Step 2 is built
  and proven against a stand-in.
- **The kernel on a link.** apack-state's kernel takes a `Port` for the other end where it now reaches into
  another system, and gives one for its own.
- **The host.** Opening the socket with apack's token, checking a frame against a pack's contract before the
  kernel takes it, and taking tRPC out.

## Order, and what can be done at once

Steps 0 to 3 in order: each is the ground the next stands on. After step 3, steps 4, 8 and 10 touch different
files and can be done side by side. Step 5 needs 3; 6 and 7 need 5; 9 needs 4 and 5. Step 11 needs 5, and is the ground for anything that changes how a
link does what it does. Step 12 needs 11, 13 needs 12, and 14 needs 13.
