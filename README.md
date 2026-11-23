# apack-link

One ordered stream between two systems of [apack](https://github.com/spankyed/apack): a window and its backend, or
any two things that run states. As a package, `@apackdev/link`.

**What one system sends another arrives once, in the order it was sent, or the sender is told it did not.**

Status: started, 2026-11-22. What is here is the frames, one end of a link over anything that carries text, and a
pair of ends in memory to run it on. Nothing in apack uses it yet.

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

## What holds

- **Order.** Every frame an end sends is numbered. The other end takes a frame only if it is the next one, and a
  frame lost, doubled or out of place closes the link, saying why.
- **One bad frame is one refusal.** A frame that cannot be put into text throws where it was sent and takes no
  number. The link goes on, with nothing missing before the next frame.
- **Ending is said once, to both ends**, with why.

## Use

```ts
import { link, memoryPair } from '@apackdev/link'

const [left, right] = memoryPair()
const window = link(left)
const backend = link(right)

backend.onFrame((frame) => { /* an ask, a tell, a follow */ })
window.send({ kind: 'ask', id: 1, to: 'threads', name: 'CREATE', args: { topic: 'one' } })
```

A `Transport` is anything that takes text at one end and hands it over at the other, in order, until it closes.

## Not its job

- **A general RPC library.** It carries what states say to each other and nothing else.
- **Old peers and new.** Both ends ship together. An end that meets another it cannot talk to refuses it; nothing
  is negotiated.
- **What a frame means.** Which system takes an ask, and what a view is, are the kernel's.

## Where it is going

In the order it would be built. [`docs/design.md`](docs/design.md) has each in more words.

1. **The kernel's link on it**: asks matched to their answers, views followed and let go, and what a step sends a
   window held until that window's views have been shown what the step kept.
2. **A WebSocket transport**, and the handshake that carries apack's token.
3. **A frame at a time across a turn**: what is sent within one turn crosses as one write.
4. **Reconnecting that resumes**: what was not received is sent again, and an ask is delivered at most once.
5. **A bound on what waits to be sent**, with a view's update that was overtaken before it left let go.
6. **Knowing the other end is there by what it does**, never by a clock.
7. **The same link in one process, over Electron's own channels, and to another machine.**
8. **Every order there is, in a test**: what carries a link is handed the moment each text arrives.
9. **Each frame naming the step that caused it**, so that a timeline crosses processes and a session replays.
10. **Frames that are never logged or broadcast**, for what a secret travels in.

## Developing

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Node 24.12 or later.
