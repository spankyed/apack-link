# The design

Status: started, 2026-11-22. The first step of the order of work below is built.

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

1. **Frames, one end of a link, two ends in memory.** Built.
2. **The kernel's link on it.** apack-state's prototype joins a window to its backend with a link of its own, in
   its kernel. That moves here: asks matched to their answers by id, a view followed and let go, `left` when an
   asker goes, and what a step sends a window held until that window's views have been shown what the step kept.
   The hold waits for each view to have caught up since the step, by name, and not for every view to be idle:
   measured on elmdb, waiting for idle under a steady stream of writes took up to seconds and sometimes did not
   end.
3. **A WebSocket transport**, in a window and in Node, with apack's token in the handshake as it is now.
4. **What is sent within one turn crosses as one write.**
5. **Reconnecting that resumes.** Each end says the last number it took; what came after is sent again. An ask is
   delivered at most once, and one whose answer was lost is answered again from what was kept, for a while.
6. **A bound on what waits to be sent.** A view's update overtaken before it left is let go, since only the last
   matters. Progress gathers. What cannot be let go and does not fit closes the link, saying so.
7. **Knowing the other end is there by what it does.** A link that has heard nothing while it is owed something
   asks, and closes when that goes unanswered while nothing else arrives either. No fixed time to reply.
8. **Other things to be carried on**: in one process, Electron's own channels, another machine.
9. **Every order there is, in a test.** `memoryPair` already takes what says when a text arrives. apack-state's
   schedule gives that, and runs a scenario under every order.
10. **Each frame naming the step that caused it.**
11. **Frames that are never logged or broadcast.**

## What is not decided

- **How a frame is checked where it arrives.** apack's contracts type what a system takes; whether a link checks a
  frame against them, or hands it to the kernel to refuse, is open.
- **Text or bytes.** JSON now. elmdb answers in msgpack, and a view's result is decoded and encoded again on its
  way to a window.
- **Where secrets travel.** Today they are kept off the bus, in procedures of their own.

## Further off

A view's result leaves elmdb as bytes, becomes JavaScript objects in the server, and is put into text again for the
socket. If elmdb kept each view current from what a commit changed, and sent only what changed, a view's update
would not pass through the server's JavaScript at all. That needs a view to be a query elmdb can keep, not a
function, and is elmdb's to design (its `docs/roadmap/incremental-views.md`).
