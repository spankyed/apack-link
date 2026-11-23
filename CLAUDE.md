# apack-link

One ordered stream between two systems of apack. `README.md` says what it is for and what holds; this is what to
know before changing it.

## Layout

- `src/index.ts` is the door: what it exports is the package.
- `src/frames.ts` is every frame there is, and what tells one from anything else that arrives (`asFrame`). A link
  carries what states say to each other and nothing else, so a new frame is a new thing a state can say, and is
  added with the kernel that says it.
- `src/link.ts` is one end: frames numbered as they are sent, taken only in turn, and the link closed where one
  arrives out of place.
- `src/transport.ts` is what a link is carried on, and two ends of one in memory. `src/socket.ts`, `src/port.ts`
  and `src/stream.ts` are a WebSocket, a message port and a stream of bytes, none of them imported.
- `src/peer.ts` is `join`: what gives a link's ids their meaning, between a link and the `Port` a system offers.
- `src/testing/` is what specs are written with, exported as `@apackdev/link/testing`: a schedule that runs a
  scenario under every order, two ends in memory whose directions are lanes of it, and the scenarios every end is
  held to (`scenarios.ts`), written against what the package exports and nothing else.
- `docs/design.md` is why a link exists and what holds; `docs/plan.md` is what is to be built, a step at a time,
  and `docs/deferred/` what is left out of it and why.

## Rules

- **Order is the point.** Nothing is added that hands a frame over ahead of one sent before it. A second stream
  beside the first, for any kind of frame, is that.
- **A frame that cannot be sent is refused where it was sent**, and takes no number. Nothing that can fail runs
  between a frame taking its number and its text being handed to the transport.
- **A link never waits on a clock.** What it knows of the other end it knows from what arrives. Where a pause is
  wanted (a quiet connection, opening one again) it is on a `Clock` handed in, and without one nothing is timed.
- **What a listener or a system throws is never the link's.** Everything after it is still taken and handed over,
  and what was thrown goes to `thrown`.
- **A size is in bytes**, of text as UTF-8 (`bytesOf`), wherever one is counted, compared or reported.
- **No dependencies at run time.** It runs in a window and in Node from one source.
- **A spec says what holds, not how.** A case every rewrite that keeps the behaviour would fail is a case about
  the code.

## Commands

```bash
npm run typecheck
npm test
npm run build
```
