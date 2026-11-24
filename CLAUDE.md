# apack-link

One ordered stream between two systems of apack. `README.md` says what it is for and what holds; this is what to
know before changing it.

## Layout

- `src/index.ts` is the door: what it exports is the package.
- `src/frames.ts` is every frame there is, and what tells one from anything else that arrives (`asFrame`). A link
  carries what states say to each other and nothing else, so a new frame is a new thing a state can say, and is
  added with the kernel that says it.
- `src/core.ts` is what one end does, with nothing done: given what an end holds and one thing that happened, what
  it holds after and what is to be done. Frames numbered as they are sent, taken only in turn, and the link closed
  where one arrives out of place. It imports no transport and no clock, and calls nobody.
- `src/link.ts` is one end on what it is handed, `dial` the one that opened the connection and `listen` the other: it tells the core what happened, and does what the core says, on
  transports, clocks and listeners. Nothing is decided there.
- `src/codec.ts` is what batches are encoded in: JSON built in, any other handed in.
- `src/transport.ts` is what a link is carried on, and two ends of one in memory. `src/socket.ts`, `src/port.ts`
  and `src/stream.ts` are a WebSocket, a message port and a stream of bytes, none of them imported.
- `src/peer.ts` is `join`: what gives a link's ids their meaning, between a link and the `Port` a system offers.
- `src/testing/` is what specs are written with, exported as `@apackdev/link/testing`: two ends in memory
  whose directions are lanes of a schedule, and the scenarios every end is held to (`scenarios.ts`), written against what the package exports and nothing else. `model.ts` is what a link
  is with nothing about how, a queue each way, and what holds a run of real ends to it.
- `tests/support/space.ts` runs the core from every state two ends can reach, each state once.
- `docs/wire.md` is everything an end sends, ending in a recorded exchange that `tests/wire.spec.ts` holds the
  package to text for text. `REFERENCE.md` is every export, made by `npm run reference:update`.
- `scripts/` is what CI and a release run: the reference, the package smoke, and the check that no workflow
  publishes to npm.
- `docs/design.md` is why a link exists and what holds; `docs/plan.md` is what is to be built, a step at a time,
  and `docs/deferred/` what is left out of it and why.

## Rules

- **Order is the point.** Nothing is added that hands a frame over ahead of one sent before it. A second stream
  beside the first, for any kind of frame, is that.
- **A frame that cannot be sent is refused where it was sent**, and takes no number: one that cannot be put into
  text, and one too large. Nothing that can fail runs between a frame taking its number and its text being handed
  to the transport, and nothing about one frame ends the link.
- **A link never waits on a clock.** What it knows of the other end it knows from what arrives. Where a pause is
  wanted (a quiet connection, opening one again) it is on a `Clock` handed in, and without one nothing is timed:
  a link that would need one to be safe is not made without it.
- **The end that listens says nothing on a connection before a hello that fits, and ends for nothing said before
  one.** It turns the connection away, and keeps the one it is on until another fits. Only the end that dials
  speaks first, and only it ends for what it met there.
- **What a listener or a system throws is never the link's.** Everything after it is still taken and handed over,
  and what was thrown goes to `thrown`.
- **A size is in bytes**, of text as UTF-8 (`bytesOf`), wherever one is counted, compared or reported.
- **The wire is one number.** Until a release exists that an end could be left on, a change to what crosses is
  made at both ends at once and `LINK` stays as it is. From the first release on, any change to what crosses
  takes a new number, and an end that says another is refused.
- **The core does nothing.** Whatever sends, closes, waits or calls a listener is `link.ts`, doing what a step
  returned. A step asks for a frame to be handed over last, and what an end holds stays values that can be copied.
- **No dependencies at run time.** It runs in a window and in Node from one source. The schedule specs are run
  under is `@apackdev/orderings`, a package of its own that the kit names only in its types: installed here to run
  the specs, and by whoever uses `@apackdev/link/testing`.
- **A spec says what holds, not how.** A case every rewrite that keeps the behaviour would fail is a case about
  the code.

## Commands

```bash
npm run typecheck
npm test
npm run build
npm run reference:check
npm run package:smoke
```
