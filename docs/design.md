# The design

Status: started, 2026-11-22.

## What a link is for

Two systems run states: a backend, and each window. Between them a state asks and is answered, tells, and follows a
view. apack-state's rules about a step rest on the order those arrive in:

- nothing a step sends leaves before the step's rows are kept;
- a window hears of a step after its views show what the step kept.

The second is a rule about two kinds of thing, a view's update and a message, and it holds only if both come down
one ordered stream. That stream is the link.

## What was there before, and why it is not enough

apack's windows reach their backend over tRPC on one WebSocket. Read on `spankyed/apack` at `e8cfccf4a5`,
2026-11-22:

- 21 procedures: 14 mutations, 4 queries and 3 subscriptions, in about 950 lines of transport.
- The adapter gives each subscription a loop of its own that pulls its values and sends them. A view's updates are
  one subscription and the bus is another, so the order between a view's update and a message is what the timing of
  two loops gives. Nothing says it, and no option does.
- The app already reaches beneath it in four places, each written against the installed version's internals: the
  encoder (a value `JSON.stringify` cannot take throws inside the loop that drains a subscription and ends the
  window's whole stream), how a connection is told from another, the frames the testing client writes by hand, and
  how a frame is typed where it arrives.

One subscription carrying everything would keep the order, and would leave tRPC carrying one stream. A link is
that stream, with what a general layer cannot know: which frames there are, and what order means between them.

## Frames

`src/frames.ts`. Each is one thing a state says, and an id names an ask or a view for as long as it lasts.

| Frame | From | Ends |
|---|---|---|
| `tell` | either | with itself |
| `ask` | the asker | at its `answer`, or when the link closes |
| `progress` | the answerer | at the `answer` |
| `answer` | the answerer | the ask |
| `left` | the asker | the ask, for the answerer: no answer is wanted |
| `follow` | the follower | at `unfollow`, or when the link closes |
| `shown` | the one that runs the view | at `unfollow` |
| `unfollow` | the follower | the view |

## What holds, and how

- **Order.** A frame is numbered as it is sent and taken only in turn. What carries a link is expected to keep
  order, as a socket does; the number is how a link knows it did, and what a resumed link will say it has.
- **One bad frame is one refusal.** A frame is put into text before it takes its number.
- **Ending is said once**, to both ends, with why.

## Order of work

[`plan.md`](plan.md) has it, a step at a time. What is built: the frames, one end of a link, and two ends in
memory.

## What is not decided

- **How a frame is checked where it arrives.** apack's contracts type what a system takes; whether a link checks a
  frame against them, or hands it to the kernel to refuse, is open.
- **Text or bytes.** JSON now. elmdb answers in msgpack, and a view's result is decoded and encoded again on its
  way to a window.
- **Where secrets travel.** Today they are kept off the bus, in procedures of their own.

## Further off

A view's result that goes from elmdb to a window without passing through the server's JavaScript, as what
changed: [`deferred/views-from-the-engine.md`](deferred/views-from-the-engine.md).
