# apack-link

One ordered stream between two systems of [apack](https://github.com/spankyed/apack): a window and its backend, or
any two things that run states. As a package, `@apackdev/link`.

**What one system sends another arrives once, in the order it was sent, or the sender is told it did not.**

Status: started, 2026-11-22. What is here is the frames, one end of a link over anything that carries text, a
pair of ends in memory to run it on, and a schedule that runs a spec under every order. Nothing in apack uses it
yet.

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

A ninth, for a view the one running it ends, is planned.

## What holds

- **Order.** Every frame an end sends is numbered. The other end takes a frame only if it is the next one, and a
  frame lost, doubled or out of place closes the link, saying why.
- **One bad frame is one refusal.** A frame that cannot be put into text throws where it was sent and takes no
  number. The link goes on, with nothing missing before the next frame.
- **Ending is said once, to both ends**, with why. An end going on purpose says goodbye first, as `restarting` or
  `ended`, and the other end's ending says which.
- **An end that cannot be talked to is refused.** The first thing each end says is which link it is, and one that
  says another number is closed on, naming both.
- **A reason never holds what was sent.** An ending names a kind, a number or a size.

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

## Not its job

- **A general RPC library.** It carries what states say to each other and nothing else.
- **Old peers and new.** Both ends ship together. An end that meets another it cannot talk to refuses it; nothing
  is negotiated.
- **What a frame means.** Which system takes an ask, and what a view is, are the kernel's.

## Where it is going

[`docs/plan.md`](docs/plan.md) is the plan, a step at a time, each with what it has to hold and how it is known to
be done:

0. Groundwork: a schedule that runs a spec under every order, a hello and a goodbye. **Built.**
1. Peers: asks matched to their answers, views followed and let go.
2. The hold: what a step sends a window waits until that window's views have caught up.
3. One write a turn.
4. A socket and a message port to be carried on.
5. A connection that comes back, with nothing taken twice.
6. A bound on what waits, with a view's overtaken update let go.
7. Knowing the other end is there by what it does, never by a time to reply.
8. What caused a frame, a tap that never sees what one carries, and frames that are private.
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
