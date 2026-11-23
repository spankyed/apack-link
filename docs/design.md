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
| `over` | the one that runs the view | the view, for the follower: nothing more is shown |

## Peers

`src/peer.ts`, `join`. A link knows nothing of what its frames are for; a peer gives the ids their meaning, for one
system at one end. A system offers a `Port`, and `join(link, mine)` returns the port of the system at the other
end: a call on it leaves as a frame, and a frame arriving is a call on `mine`.

- **Ids.** Each end numbers its own asks and its own views from 1, and an id is used once in a link's life. An
  `ask` or a `follow` whose id is not new is not taken.
- **A frame for an id nobody holds is dropped.** It is one that crossed a `left` or an `unfollow` on the way, or
  came after its `answer` or `over`. Whatever a system does with an ask or a view after it has ended (answers again,
  shows more) goes nowhere: one `answer` and one `over` cross for each.
- **When the link ends**, every ask waiting here ends `{ ok: false, failure: { kind: 'disconnected' } }`, every
  view followed here is `over` with the same, and everything this end was answering or showing is told to stop.
  Each once. An ask or a follow made after is ended there and then.
- **A value that cannot be sent fails the one it belongs to, and no other.** An answer or a progress: the ask is
  answered `failed`, and whoever was answering is told to stop. A view's result: the view is `over` and stopped.
  An ask or a follow: it is ended where it was made. Nothing is thrown into the system, and nobody is left waiting.
  The value is never said: the message is "A value could not be sent".
- **A system that throws where it is asked or followed** fails that one ask or view, `failed`, "It could not be
  taken". What it threw is the system's to report.

## The hold

A window hears of a step after its views show what the step kept. A peer holds what its system says to the other
end until the views it runs for that end have caught up.

- **What is held is everything the system says**: `tell`, `progress`, `answer`, and its own `ask`, `follow`,
  `left` and `unfollow`, as one queue in the order said. Nothing a system says passes something it said before.
- **What is not held is a view's own words**, `shown` and `over`. They are what is waited for.
- **A round.** Each time something is put in the hold, every view the peer runs for the other end that offers
  `caughtUp` is asked to call back, and what was held before that asking leaves once all have, and once every
  round before it has. What is put in after waits for a round of its own.
- **`soon`** is true when an `answer` is among what a round lets out: an asker is blocked on it. A `tell` or
  `progress` alone waits at the views' own pace.
- A view that stops, or is ended by whoever runs it, while it is waited on counts as caught up. A view with no
  `caughtUp` is not waited on. An end that runs no views for the other holds nothing. A view followed after
  something was held is not waited on for it.
- **Refused where it was said.** A held frame is put into text as it is held, to know whether it can be: a `tell`
  that cannot be throws to the system that told it, and an answer that cannot be is answered `failed` in its place,
  in its place in the queue. That is a second encoding of what is held; nothing is held at an end that runs no
  views, and an end that does is the backend.

Why "since it was asked", and not "until every view is idle": measured on elmdb, waiting for every view to be idle
under a steady stream of writes took up to seconds and sometimes did not end. Waiting is for these views to have
run once since the call.

## What a link says about itself

What an end says within one turn crosses as one text, a batch: a JSON array of what it said, in order. Beside
frames, an end says a few things of its own, each an element of a batch like a frame, and none takes a number:
only a frame is numbered. A link that numbered its own words would have more to keep for a resume the longer it sat idle.

| Text | Says |
|---|---|
| `{ "link": 1, "session": s, "taken": n }` | Hello: which link, which session this end is, and the last number it took. First on each connection, and nothing is taken before it. `"again": true` on every connection after an end's first |
| `{ "taken": n }` | The last number this end took. In a batch when it has more to say of it |
| `{ "lost": true }` | The session cannot be picked up again; the link ends `lost` |
| `{ "bye": "restarting" }` | This end is going on purpose and is to be reached again |
| `{ "bye": "ended" }` | This end is going on purpose and is not coming back |

A frame crosses as `{ "seq": n, "frame": { … } }`. A goodbye is the last thing in the last batch.

```
[{"link":1,"session":"…","taken":0},{"seq":1,"frame":{"kind":"follow","id":1,…}},{"seq":2,"frame":{"kind":"ask","id":1,…}}]
[{"seq":3,"frame":{"kind":"left","id":1}},{"bye":"ended"}]
```

## What holds, and how

- **Order.** A frame is numbered as it is sent and taken only in turn. What carries a link is expected to keep
  order, as a socket does; the number is how a link knows it did, and what a resumed link will say it has.
- **One bad frame is one refusal.** A frame is put into text before it takes its number, when it is sent, and a
  batch is those texts joined: joining cannot fail, so nothing that can runs between a number and the transport.
- **One write a turn.** A batch leaves when `link`'s `later` says, a microtask unless given, so what one turn says
  is one write. Order is by number, within a batch and across batches. A link that closes sends what it has said
  first.
- **A batch is taken in order**, and nothing in it after what ended the link.
- **Ending is said once**, to both ends, with why (`Ending`, `src/link.ts`). An end that heard a goodbye ends
  `{ why: 'goodbye', bye }`; without one, a backend that restarted and one that ended both look like a connection
  that was lost.
- **An end that says another number is refused**, with `{ why: 'version', mine, theirs }`. Nothing is negotiated:
  both ends ship together, and the number stays 1 until something exists that cannot move with it.
- **A reason never holds what was sent.** What is not a frame ends the link with the length of its text, and
  nothing of the text.
- **Closing is in order too.** What an end sent before it closed is handed over before the other end hears that
  it closed. A socket does this, and the ends in memory do: it is what lets a goodbye arrive.

## A connection that comes back

A link outlives what carries it (`src/link.ts`).

- **Kept until taken.** Each end keeps every frame it sent, as text, until the other says it took it. The other
  says so with `{ taken }` in a batch, and in its hello.
- **A new connection.** Each end's hello says its session and the last number it took. Each sends again what the
  other has not taken, in order, then goes on. A frame is taken only in turn, so nothing is taken twice. On a
  connection after an end's first, nothing new goes out until hellos have crossed. On the first connection, frames
  go at once.
- **Lost.** A link ends `{ why: 'lost' }`, saying `{ lost: true }` to the other end, when the hello is from another
  session than the one it was talking to, or says it took more than was sent, or wants frames no longer kept. It
  also ends lost when the hello says `again` on this end's own first connection: the other end is going on with
  something, and this end is new. That last rule is what stops a window whose first connection dropped before it
  heard anything from handing its frames to a backend that restarted. The window never learned the old backend's
  session, so it cannot tell. Every ask and view then ends as when a link closes.
- **Who opens.** `link(open)` opens a connection now, and another each time one closes, at once. Whoever gives
  `open` decides when it actually connects. `link()` waits to be handed each connection with `carry`. `accept`
  takes connections as they arrive at a backend: a new session is a new link, a known one goes back to its link,
  and one that says `again` for a session it does not know is told `lost`.
- **Goodbye.** `ended` ends the other end, which is not reached again. `restarting` does not end a link that comes
  back: it reconnects, and an end that restarted is a new session, which is lost.
- **Gone for good** is the host's to say, with `close()`. Nothing a link sees tells a crashed window from a slow
  one, and a link is given no time to wait. What is kept is bounded by step 6 and by nothing else.

An ask is delivered at most once, because a frame is: an answer lost on the way is one of the frames sent again.

## What a link is carried on

A `Transport` hands over whole messages, `string | Uint8Array`, in order, and says once when nothing more will
arrive. A link sends text today and takes either: bytes are read as UTF-8.

- **`socket`**, over anything shaped like a browser's `WebSocket` (Node's `ws` is). Sent while opening, it waits
  and leaves in order once open. Bytes arrive as `ArrayBuffer` and are handed over as `Uint8Array`.
- **`port`**, over a message port that takes listeners as an event target (a browser's, Node's) or as an emitter
  handing over an event (Electron's). A port closing is not heard at the other end everywhere, so closing posts
  `null` first, after what was sent before it; a port's own `close` event is heard as well.
- **`stream`**, over a byte stream with no edges between messages. Each message crosses as one byte for its kind
  (0 text, 1 bytes), four for its length, most significant first, and the message. What arrives in pieces is put
  together and what arrives together taken apart. A kind that is neither closes it.

Which of these apack's windows and tools are carried on is apack's to decide; a link is the same over each.

## How it is known to hold

Where order matters, a spec is run under every order. `src/testing/schedule.ts` stands in for the event loop:
everything put off goes into a lane, a lane keeps its order, and `explore` runs a scenario once for every way of
choosing between lanes. Each direction of a link in memory is a lane, and a spec adds lanes for what it does
itself. It is exported as `@apackdev/link/testing`, since from step 1 on the scenarios are a kit: written against
what the package exports and nothing else, to be run over any pair of ends, so that another implementation of an
end is held to the same file.

`tests/scenarios.spec.ts` runs every scenario over memory under every order, and over a WebSocket (a real `ws`
server and client), a `worker_threads` message port and a `node:net` socket path under forty orders each, from a
seed. Over something real, `carried` (`src/testing/carried.ts`) puts what arrives at each end into a lane of its
direction, so the schedule chooses among what has arrived, and `Schedule.outside` keeps a run from coming to rest
while a message or a close is on its way.

## What was read, and what was taken from it

Read 2026-11-22, before peers were built. Written down so that it is not argued again.

**Meteor's DDP** (`packages/ddp/DDP.md`, version 1).

- Taken: **`nosub`**. A subscription the server ends, or one there is not, is said to the client, with an error.
  It is step 1's `over`.
- Taken: **a version said first.** DDP's `connect` names a version. Declined is what goes with it there: a list of
  versions the client supports and a `failed` that suggests another. Both ends of a link ship together, so an end
  that says another number is refused and nothing is tried next.
- Declined: **`updated`.** DDP has the hold's problem and answers it with a message: `updated` names the methods
  whose writes have reached the client as data, and no order is required between it and a method's `result`, so
  a client keeps each result until both have come. A link holds the answer where it is sent until the views have
  been shown the change, so the order it arrives in already says it, and nothing at the window has to pair two
  messages up.
- Declined: **`added`, `changed`, `removed`.** DDP sends a collection as its documents' changes. A view's result
  crosses whole; what changed is [left for later](deferred/views-from-the-engine.md). `ready` goes with them: a
  view's first `shown` is its whole result.
- Declined: **`ping` at any time.** Either side may ping whenever it likes and DDP sets no time to answer in.
  Step 7 asks only while an end is owed something and has heard nothing.
- Noted: `connect` may carry a `session` to come back to, and the specification does not say what a server does
  with one. Step 5 says what a link does.

How it is shown, for peers: each scenario in `src/testing/scenarios.ts` has whatever a system does in answer to
something arriving done in a lane of its own, so it falls in every place among what crosses the link.

**MQTT** 5.0's sessions (Clean Start, Session Expiry Interval, session state, Keep Alive, Receive Maximum).

- Taken: **both ends keep state, and a reconnect says whether there is a session.** MQTT keeps unacknowledged
  messages on both sides and has the server say `Session Present`. Here each hello says its session and where it
  got to, and either end can find the session lost.
- Taken: **a client with no state that is told there is one closes.** That is the `again` rule turned around.
- Declined: **Session Expiry Interval.** MQTT discards a session after a time. Whoever holds a link says when the
  other end is gone (`close()`); a link is given no time to wait.
- Declined: **acknowledgement per message, and QoS 2's four-step handshake.** Exactly-once here comes from
  numbering in one ordered stream and taking only in turn. One number, the last taken, acknowledges everything
  before it.
- Declined: **Keep Alive's one and a half times the interval.** Step 7 has a link ask only while it is owed
  something.
- Kept for step 6: **Receive Maximum**, the receiver saying how much it will take. A bound counted by what the
  other end has not said it took is the same idea.

**The Language Server Protocol's base protocol** (3.17).

- Taken: **the three shapes.** A request and its response are `ask` and `answer`, a notification is `tell`.
- Taken: **progress before the answer, and cancelling.** They are `progress` and `left`.
- Declined: **a cancelled request is still answered.** LSP has the server respond to what was cancelled, with an
  error saying so. `left` says no answer is wanted, and nothing that arrives for the id after it is heard: the
  asker has gone, and there is nobody to hand an answer to.
- Declined: **progress against a token of its own.** LSP's progress names a token the request carried, apart from
  the request's id, since progress may also be the server's own. Here the only thing progress is made on is an
  ask, so it carries the ask's id.
- Declined: **responses in roughly the order of the requests.** LSP lets a server answer out of order where that
  changes nothing. Each answer here is a frame, in the one order everything is in.
- Declined: **a header before each message.** `Content-Length` is there because a stream of bytes has no edges. A
  transport hands over whole texts; step 4's stream of bytes puts a length before each and no header.

## Order of work

[`plan.md`](plan.md) has it, a step at a time. What is built: the frames, one end of a link, two ends in
memory, step 0 (the schedule, hello and goodbye), step 1 (peers), step 2 (the hold), step 3 (one write a turn)
step 4 (a socket, a port and a stream) and step 5 (a connection that comes back).

## What is not decided

- **How a frame is checked where it arrives.** apack's contracts type what a system takes; whether a link checks a
  frame against them, or hands it to the kernel to refuse, is open.
- **Text or bytes.** JSON now. elmdb answers in msgpack, and a view's result is decoded and encoded again on its
  way to a window.
- **Where secrets travel.** Today they are kept off the bus, in procedures of their own.

## Further off

A view's result that goes from elmdb to a window without passing through the server's JavaScript, as what
changed: [`deferred/views-from-the-engine.md`](deferred/views-from-the-engine.md).
