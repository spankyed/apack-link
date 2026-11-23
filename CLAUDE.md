# apack-link

One ordered stream between two systems of apack. `README.md` says what it is for and what holds; this is what to
know before changing it.

## Layout

- `src/index.ts` is the door: what it exports is the package.
- `src/frames.ts` is every frame there is. A link carries what states say to each other and nothing else, so a new
  frame is a new thing a state can say, and is added with the kernel that says it.
- `src/link.ts` is one end: frames numbered as they are sent, taken only in turn, and the link closed where one
  arrives out of place.
- `src/transport.ts` is what a link is carried on, and two ends of one in memory.
- `docs/design.md` is why a link exists and what holds; `docs/plan.md` is what is to be built, a step at a time,
  and `docs/deferred/` what is left out of it and why.

## Rules

- **Order is the point.** Nothing is added that hands a frame over ahead of one sent before it. A second stream
  beside the first, for any kind of frame, is that.
- **A frame that cannot be sent is refused where it was sent**, and takes no number. Nothing that can fail runs
  between a frame taking its number and its text being handed to the transport.
- **A link never waits on a clock.** What it knows of the other end it knows from what arrives.
- **No dependencies at run time.** It runs in a window and in Node from one source.
- **A spec says what holds, not how.** A case every rewrite that keeps the behaviour would fail is a case about
  the code.

## Commands

```bash
npm run typecheck
npm test
npm run build
```
