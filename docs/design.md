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
- **Refused where it was said.** A held frame is put into text as it is held (`Link.prepare`), which is how it is
  known whether it can be sent: a `tell` that cannot be throws to the system that told it, and an answer that
  cannot be is answered `failed` in its place, in its place in the queue. That text is what leaves when the hold
  lets it out: it is put into text once, and what a system said crosses as it was when it was said, whatever the
  system does with the value after.

Why "since it was asked", and not "until every view is idle": measured on elmdb, waiting for every view to be idle
under a steady stream of writes took up to seconds and sometimes did not end. Waiting is for these views to have
run once since the call.

## What a link says about itself

What an end says within one turn crosses as one text, a batch: a JSON array of what it said, in order. Beside
frames, an end says a few things of its own, each an element of a batch like a frame, and none takes a number:
only a frame is numbered. A link that numbered its own words would have more to keep for a resume the longer it sat idle.

| Text | Says |
|---|---|
| `{ "link": 1, "session": s, "taken": n }` | Hello: which link, which session this end is, and the last number it took. First on each connection, and nothing is taken before it. `"resumes": t`, the other end's session, from an end that has met it; absent from one that has met nobody. `"most": m`, the longest message in bytes this end takes on this connection; absent, any |
| `{ "taken": n }` | The last number this end took. In a batch when it has more to say of it |
| `{ "lost": true }` | The session cannot be picked up again; the link ends `lost` |
| `{ "there": n }`, `{ "here": n }` | Whether the other end is there, and that it is, with the same number |
| `{ "bye": "restarting" }` | This end is going on purpose and is to be reached again |
| `{ "bye": "ended" }` | This end is going on purpose and is not coming back |

A frame crosses as `{ "seq": n, "frame": { … } }`, with `"cause"` and `"private"` when it has them, or as parts:
`{ "seq": n, "part": i, "of": count, "data": piece }`. A goodbye is the last thing in the last batch.

```
[{"link":1,"session":"…","taken":0},{"seq":1,"frame":{"kind":"follow","id":1,…}},{"seq":2,"frame":{"kind":"ask","id":1,…}}]
[{"seq":3,"frame":{"kind":"left","id":1}},{"bye":"ended"}]
```

[`wire.md`](wire.md) says all of it once, for whoever speaks to a link without this package, and ends with an
exchange recorded as it crossed, hello to goodbye with one of each frame and each thing an end says of itself.
`tests/wire.spec.ts` makes the same exchange and compares it with that recording text for text, so a change to
anything an end sends is a change to that file.

## What holds, and how

- **Order.** A frame is numbered as it is sent and taken only in turn. What carries a link is expected to keep
  order, as a socket does; the number is how a link knows it did, and what a resumed link will say it has.
- **One bad frame is one refusal.** A frame is encoded and measured before it takes its number, when it is sent,
  and a batch is those encodings joined: joining cannot fail, so nothing that can runs between a number and the
  transport. A frame that cannot be encoded is refused with a `TypeError`. One that is larger, with its
  cause, than a frame may be (`bound.frame`: 64 MiB unless given, and 1024 bytes at least, so that what a peer
  says in place of a value it could not send always fits) is refused with a `RangeError`. Neither ends the link.
  `Link.prepare` does both now for a frame to be sent later, and throws what `send` would: what comes back is
  sent once, by the link that prepared it, as it was encoded then.
- **One write a turn.** A batch leaves when `link`'s `later` says, a microtask unless given, so what one turn says
  is one write. Order is by number, within a batch and across batches. A link that closes sends what it has said
  first.
- **Never more than what carries it takes.** A transport that takes no message longer than some length says so
  (`Transport.most`, in bytes: a stream of bytes does). A batch that would be longer crosses as the fewest
  messages that fit, cut between the things said, in order, the hello still first and a goodbye still last. The
  length a link is carried on and the size of what it sends cannot be set apart from each other: the link
  reads the one and keeps to it. `accept` hands a link the transport's `most` and `waiting` with it.
  - **Found as a connection is handed over.** What takes no message as long as the link may need for one thing it
    numbers does not carry the link: `link`, `carry` and `accept` close it and throw a `RangeError`, and a link
    that opened it for itself counts it as a connection that did not hold. What it may need is a part, or a
    frame no longer than one, with what caused it (1024 bytes at most), 128 bytes around them and the batch's
    two; and never more than a whole frame would need, where a frame may be no longer than a part. A frame
    longer than a part never crosses whole, so what carries a link has to have room for a part and not for a
    frame. So a frame's size is held to one thing, `bound.frame`, known when it is sent; no frame is taken on
    that some later connection cannot carry, and nothing is found out by how large a frame happens to be.
  - **Both ends.** Each end says in its hello the longest message it takes on that connection, and a batch is cut
    to the shorter of what the two take. An end that takes none as long as a frame the other may send is one the
    other cannot talk to: the one that opened the connection ends `{ why: 'too narrow', most, needs }`. A link
    that sends before it has met the other end, one given one transport, cuts to its own until it has.
- **A batch is taken in order**, and nothing in it after what ended the link.
- **What arrives is checked to be a frame** (`asFrame`, `src/frames.ts`): one of the nine kinds, an id a whole
  number from 1, a name text, a failure a kind and a message, both text. Anything else ends the link
  `not a frame`. What a frame carries for a system (`event`, `args`, `update`, an `outcome`) is not looked at, and
  only what a frame has is handed on.
- **What a listener throws is never the link's.** A listener (`onFrame`, `onEnd`), and so a system joined to the
  link, may throw. Every listener is still called, every frame after it in the batch is still taken and said to
  be taken, and the link does not end. What was thrown is handed to `Options.thrown`; without it, it is thrown
  again in a turn of its own, where nothing of the link's is beneath it. A tap that throws is still the tap's
  alone. A transport that throws where it is handed a batch is a connection that has gone: it is closed, and
  the batch, which is kept, is sent again on the next. What it threw is handed to `thrown` as well: none of the
  transports here throws where it sends, so one that does has something wrong with it, and a link that only
  opened another connection would hide it.
- **Ending is said once**, to both ends, with why (`Ending`, `src/link.ts`). An end that heard a goodbye ends
  `{ why: 'goodbye', bye }`; without one, a backend that restarted and one that ended both look like a connection
  that was lost.
- **An end that says another number is refused**, with `{ why: 'version', mine, theirs }`. Nothing is negotiated:
  both ends ship together, and the number stays 1 until something exists that cannot move with it.
- **A reason never holds what was sent.** What is not a frame ends the link with how many bytes it was, and
  nothing of the text.
- **Closing is in order too.** What an end sent before it closed is handed over before the other end hears that
  it closed. A socket does this, and the ends in memory do: it is what lets a goodbye arrive. `close()` numbers
  what waited for room, past the mark, before it says goodbye: it is the last this end sends. It does so
  wherever what it numbers can arrive no more than once. That is a connection where frames go; and, for an end
  that has never met anybody, any connection it has: it has numbered nothing, and sends nothing again, so what
  it numbers now is taken once or not at all. A window that says one thing and closes is heard. On a connection
  where an end met before has not been met again, what was sent before may be out of step with what the other
  end took, and nothing more is numbered. What waits there, or with no connection, is let go, and a goodbye is
  still said on whatever connection there is.

## A connection that comes back

A link outlives what carries it (`src/link.ts`).

- **Kept until taken.** Each end keeps every frame it sent, as text, until the other says it took it. The other
  says so with `{ taken }` in a batch, and in its hello.
- **A new connection.** Each end's hello says its session, the last number it took, and the session it is going
  on with (`resumes`) once it has met one. Each sends again what the other has not taken, in order, then goes on.
  A frame is taken only in turn, so nothing is taken twice.
- **Nothing is numbered before the other end is met.** On every connection of a link that can come back
  (`link(open)`, `link()`), frames wait until the other end's hello has arrived. So an end that has met nobody
  has sent nothing that anybody could have taken, and whoever it meets first, it starts with afresh: a window
  that opens before its backend listens, or whose first connection went before anything arrived, loses nothing
  and repeats nothing, whether the backend it reaches is the one it dialled or one started since. A link given
  one transport does not come back, and sends at once.
- **Lost.** A link that opened the connection ends `{ why: 'lost' }`, saying `{ lost: true }` to the other end, when the hello is from another
  session than the one it was talking to; says it is going on with a session that is not this one; says it has met
  nobody and yet took something; says it took more than was sent; or wants what it earlier said it had taken, which
  is no longer kept. Every ask and view then ends as when a link closes. Each case is one where what one end holds
  is not what the other thinks. The two that are not lost: neither end has met anybody, which is a start; and one
  end met the other while the other never heard it (its hello went with the connection), which is gone on with,
  the one that met sending again all it sent, since none of it was taken.
- **Who ends, and who turns away.** The end that opened a connection ends for what it meets there: it chose where
  to connect, and a hello that does not fit means what it was talking to is gone. A link that is handed its
  connections opened none of them, and anybody may be on one. Before a hello that fits, whatever such a link is
  told (a hello that does not fit, one of another link, something that is not a link's at all) closes that
  connection and nothing else, and the link is there for the next. `accept` makes no link for a connection whose
  first word is not a hello that starts something, and closes it.
- **A connection takes a link's place only once it fits.** A link on a connection where the other end has been
  met, when it is handed another, keeps the one it has: it says nothing on the new one, and goes on taking and
  sending on the old, until a hello that fits arrives on the new. Then it closes the old, says its own hello on
  the new, with what it had taken by then, and goes on there. So the end that opened a connection speaks first
  on it, which a window does. Were the link to speak first, its hello would say what it had taken before frames
  still arriving on the old connection, and the other end would send those again. Only the last connection
  handed over waits. Without this, a connection that only said a session's id would close the connection the
  session was on.
- **Who opens.** `link(open)` opens a connection now, and another after each one closes. `link()` waits to be
  handed each connection with `carry`. `accept` takes connections as they arrive at a backend: a new session is a
  new link, a known one goes back to its link, and one that says it `resumes` something, from a session it does
  not know, is told `lost`: it is from before this backend began.
- **Opening again is paced, on a clock handed in.** `link(open)` is not made without one (`Options.reopen`): a
  link that opened again with nothing to pace it would spin for as long as its connections failed, and there is
  no way to pace without a clock that does not. `timers` is one on `setTimeout`, exported for a host to hand in;
  the link reaches for none itself.
  - **Held.** A connection has held once it has stayed up, after the other end said hello on it, for as long as
    the wait before it was opened, and for `first` at least. Meeting the other end is not enough: an end that
    says hello and goes, every time, is no more there than one that never answers.
  - **The wait.** After a connection that held, the next is asked of the clock after no time. After one that did
    not, met or not, the wait is `first` milliseconds (100), doubled for each such connection in a row, and
    `most` (10 000) at most. What could not be opened at all, `open` throwing, is one that did not hold.
  - Doubling with a ceiling, and no jitter: the ends are a window and its backend, not a crowd arriving
    together.
- **Admission is not the link's.** A link authenticates nothing. A connection that says a session's id and a
  hello that does not fit is turned away, and cannot end that session's link or close what it is on. One that
  says a hello that fits takes the link's place: and what fits is not secret, since a session's id and what it
  has taken are told to anything that connects, and a hello that claims to have met nobody fits a link that has
  let nothing go. Who may connect at all has to be settled by what takes the connections, before one reaches
  `accept`: apack's token on the socket, a socket path only the user can open.
- **Goodbye.** `ended` ends the other end, which is not reached again. `restarting` does not end a link that comes
  back: it reconnects, and an end that restarted is a new session, which is lost.
- **Gone for good** is the host's to say, with `close()`. Nothing a link sees tells a crashed window from a slow
  one, and a link is given no time to wait. What is kept is bounded by step 6 and by nothing else. So a link
  nobody closes keeps what it has for a window that is gone, for good, and `accept` keeps the link: a backend
  whose windows come and go without their links being closed grows by one link's bound for each. The host is
  expected to close a window's link when it learns the window is gone (Electron says when a window is
  destroyed), or, where it cannot learn that, by a rule of its own, on its own clock. None is built in.

An ask is delivered at most once, because a frame is: an answer lost on the way is one of the frames sent again.

## A bound

- **How far behind the other end is, is what it has not said it took.** It is counted the same over anything a
  link is carried on: a message port has no buffer to ask about and pushes back on nothing. A transport that can
  say how much it has not yet written (`waiting()`: a socket's `bufferedAmount`, a stream's `writableLength`) is
  counted as well.
- **One unit.** A size is bytes, of text as UTF-8 (`bytesOf`): what is kept, what waits, a frame as a tap is told
  of it, what was not a frame, and what a transport says it has not written. A length in characters is none of
  these, and for text past ASCII is less than half of some.
- **Past a mark** (`bound.kept`, in frames and in bytes) a link stops numbering. What is sent then waits,
  in order, and is numbered as room comes back. A link looks again whenever anything arrives, since a transport
  that has written its backlog says nothing when it does. Nothing sent passes what waits.
- **What can be let go is.** A `shown` waiting for a view that already has one waiting takes that one's place: the
  later result, in the earlier one's place in the order. Letting the earlier one go and keeping the later where it
  was would put what was said between them, an answer among it, ahead of any result showing it. That would break
  the hold. Nothing else is let go.
- **An end says what it took** with its next batch, and sends a batch for that alone when it has none of its own
  to send: an end that only listens still says.
- **Past the bound on what waits** (`bound.waiting`), with nothing left to let go, the link ends
  `{ why: 'overrun', waiting, bound }`, each in frames and bytes. A link that grew without end would end the
  process instead. One frame is bounded apart from this (`bound.frame`), and refused, not ended for.
- **What is kept is never let go before it is taken.** Numbering stops at its mark, so it does not pass its
  bound, and a resume never finds what it needs gone.

## Knowing the other end is there

- **What carries a link saying it closed is the first word**, and for two ends on one machine the only one needed:
  a process that ends closes its sockets.
- **For a connection that can go quiet without closing**, a link is given a window and a clock (`there`). While it
  is owed something (a `taken` for what it sent, or an answer: a peer says so with `link.awaiting()` for each ask
  it waits on) and nothing at all has arrived for half the window, it sends `{ there: n }`. The other end answers
  `{ here: n }` at once. After a whole window in which nothing of any kind arrived, it closes the connection, and
  step 5 opens another. Anything arriving starts the window over; what this end sends does not.
- **Owed nothing, it sends nothing**, however long it is quiet.
- **Nothing is given a time to answer in.** An ask that takes an hour, with the other end there, is left alone.

## What caused a frame, and what may be seen of it

- **Cause.** `send(frame, { cause })`. A cause is a short text the kernel makes, naming the step that sent the
  frame. It crosses beside the frame (`{ "seq", "frame", "cause" }`), and `onFrame` hears it. A link never reads
  it. It is 1024 bytes at most as it crosses, and a frame sent with a longer one is refused where it is sent: it
  crosses whole beside a frame or its first part, so what a link needs of what carries it counts it in. A result that overtook another while waiting carries its own cause.
- **Tap.** `onTraffic(seen)` is told of each frame as it is numbered to go out, and as it is taken in: direction,
  number, kind, id, name (a tell's `to`, an ask's name, a view's name), bytes of its text, and cause. Never what it
  carries. A tap that throws is the tap's to answer for; the link goes on.
- **Private.** `send(frame, { private: true })` marks it on the wire (`"private": true`). A tap at either end is
  told only that it crossed, its number and its size: no kind, id, name or cause. This is what a secret travels
  in. The frame itself reaches the other end as any other does.
- **Nothing a link reports holds what a frame carries.** A frame that cannot be put into text is refused with
  `TypeError('A frame could not be put into text')`: what JSON says of a value it cannot take names its keys, and a
  key is something a frame carries. An ending holds kinds, numbers and sizes.

## Bytes, and frames too large for one write

- **A codec is handed in** (`src/codec.ts`): it encodes one value, joins values already encoded as a list or as the
  fields of a record, and decodes. A link encodes each thing it says where it is said, so what cannot be encoded
  is refused there alone, and builds batches and numbered records by joining, which cannot fail. JSON is built in.
  A host with msgpack hands its own; this package's specs run one (`tests/support/msgpack.ts`) over the
  `@msgpack/msgpack` development dependency.
- **`link.prepare(frame)`** encodes a frame now, to be sent later as it was now. The hold uses it, so what it holds
  is encoded once, refused where it was said, and sent as it was when it was said.
- **A frame longer than a part** (`part`, 1 MiB unless given, in bytes), and no larger than a frame may be,
  crosses as parts: `{ seq, part, of, data }`, each numbered, one after another, the first carrying the cause and whether it is
  private. The other end takes each in turn and says it took it, so a resume picks up within the frame, and hands
  the frame over whole once the last has arrived, in its first part's place. Anything between its parts other than
  the next one is not a frame.
- **A part is no longer than a part as it crosses.** What a part carries is a piece of the frame's encoding, said
  as data, and a piece can be longer as data than it was: text in JSON has each quote and backslash in it said in
  two. By how much is the codec's to know, so a piece is tried: one too long as data is tried again shorter by as
  much as it was too long (in proportion first, which is right where all of it grows alike as data; then by every
  byte it was still too long by, which always fits, since no byte is less than one as data), and one with room
  to spare longer by as much as it had, between the longest found to fit and the shortest found not to, until
  it is within a character or two of a part or nothing lies between.
  Text that says nothing in two takes two tries a part, and nothing takes more than six: after that the longest
  found to fit is taken as it is, so the work of cutting a frame stays in proportion to the frame whatever it
  holds, and a part of text that is plain in one place and all quotes in the next may be shorter than it could be. `part` is 16 bytes at least, so that one character
  always fits. With what goes around it, a part is then never longer than what carries the link was found wide
  enough for, whatever the frame holds, and no part but the last is much shorter than it may be.
- **What a frame's parts add up to is bounded where they arrive.** An end keeps the parts of one frame until the
  last, and takes no more of them than a frame may be (`bound.frame`), nor one that holds nothing: past that the
  link ends `not a frame`, however many parts were said to be coming. Without it, what an end kept would be
  bounded by nothing the moment a frame was said to be in parts.
- **A batch longer than a part crosses as more than one message**, cut between what was said, so no one write is
  much longer than a part, and a resume sends again what was kept the same way. All of it leaves at the end of
  the turn, as any batch does: nothing is handed to what carries a link while whoever is sending is still in
  `send`, so nothing a transport does there, throwing among it, comes back to them.
- **A tap's `size`** is how many bytes a frame is as it crosses, numbered and with its cause: for a frame in parts,
  all of its parts, the same at both ends.

## What a link is carried on

A `Transport` hands over whole messages, `string | Uint8Array`, in order, and says once when nothing more will
arrive. A link sends text today and takes either: bytes are read as UTF-8.

- **`socket`**, over anything shaped like a browser's `WebSocket` (Node's `ws` is). Sent while opening, it waits
  and leaves in order once open. Bytes arrive as `ArrayBuffer` and are handed over as `Uint8Array`. A socket
  does not say how long a message the other end takes, and a server that takes none past some length closes on
  one that is: `socket(ws, { most })` is told it, and says it as any transport does, so the link cuts to it and
  is not opened to a server too narrow for it. Without it, what keeps a link under a server's limit is only
  that a part is shorter.
- **`port`**, over a message port that takes listeners as an event target (a browser's, Node's) or as an emitter
  handing over an event (Electron's). A port closing is not heard at the other end everywhere, so closing posts
  `null` first, after what was sent before it; a port's own `close` event is heard as well.
- **`stream`**, over a byte stream with no edges between messages. Each message crosses as one byte for its kind
  (0 text, 1 bytes), four for its length, most significant first, and the message. What arrives in pieces is put
  together and what arrives together taken apart: what arrives is kept as the pieces it came in and a message
  joined once, when all of it is here, so the work is in proportion to the bytes however small the pieces. A
  kind that is neither, text that is not UTF-8, or a head that claims more than `most` bytes closes it, and the
  stream beneath is destroyed, or ended where it cannot be: a stream that said something that is not a message
  is not listened to further. `most` is 128 MiB unless given, and the transport says it, so a link carried on it
  sends nothing longer; the two ends of a stream are to be given the same. Sending more than `most`, which a
  link does not, closes the stream too.

Which of these apack's windows and tools are carried on is apack's to decide; a link is the same over each.

## What an end does, and what does it

An end is in two pieces. `src/core.ts` is what an end does with nothing done: it is handed what the end holds and
one thing that happened (a frame sent, a message arriving on a connection, a connection closing, a turn ending, a
clock running out) and it changes what the end holds and returns what is to be done about it: write these to that
connection, close it, say when this turn is over, put this on a clock, open a connection, hand this frame over, say
the link has ended. It sends nothing, waits on nothing and calls nobody. `src/link.ts` is what does it: it holds
the transports, the clocks and the listeners, tells the core each thing that happens, and does what comes back, in
order.

Three things follow, and they are why it is built so.

- **A step is whole before anything it asked for happens.** A listener that sends or closes as it is called, and a
  transport that says it closed as it is closed, find the end as that step left it, and what they do is a step of
  its own. Nothing of the link's is half done under anything it calls. A frame handed over is the last thing a
  step asks for: once whoever it was handed to has been called, the rest of the message it came in is taken, so a
  listener that closes the link is handed nothing after.
- **What an end holds is values.** Each connection and each thing on a clock is a number. So an end can be copied,
  compared and written down, and a copy goes on as the original would have.
- **What an end does can be run with nothing real under it.** `tests/support/space.ts` steps the cores of two ends
  by hand over a network that is only values, and from every state tries everything that can happen next. A state
  reached by a thousand orders is looked at once.

What the core is given beside what happened is whatever it would otherwise have had to ask for: how many bytes a
transport has not yet written comes with the event it is counted for. What an end is set with (`Setup`) does not
change while it lasts.

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

Every one of those runs is held to a model as well as to what its scenario checks. The model
(`src/testing/model.ts`) is what two ends are to each other with nothing about how: a queue each way, where an end
that is there puts a frame last, or a view's result in the place of the last result of that view still in the
queue, and is handed the first; and whether each end is still there, after which it is handed nothing. Each link
a scenario is given is put under it, and what it is sent, what it hands over, with what caused each, and how it
ends are noted as they happen. The first of those the model could not have done fails the run, with what led to it. So does an ending
that only a defect brings between two ends set alike (`out of order`, `not a frame`, `version`, `too narrow`), a
session lost while every end is still there, a goodbye nobody said, and, at rest, anything an end still there was
sent by the one it is talking to and has not been handed. A scenario says what its systems should see. The model
says what no scenario has to: that whatever else happened, nothing was handed over that a queue would not have
handed over. `tests/model.spec.ts` shows it able to fail, on ends that are wrong in one way each.

And the core is run from every state two ends can reach (`tests/core.spec.ts`): both sending, a connection that
drops, more sent than may be kept, a first connection that reaches nobody, a listener that restarts, a goodbye from
either end, a quiet connection watched and let go, a connection that goes at one end before the other so that the next
reaches an end still on it, a view's results overtaken where they wait, and a frame in parts across a drop. Each state is held to the same model, kept as counts (a
frame handed over is the next one the other end sent, by the one end this one talks to), to no ending for what
crossed and no session lost with every end there, and to what an end holds adding up: what is kept is exactly what
was numbered and not let go, and the sizes counted are the sizes held. At rest, two ends still there have each been
handed all the other sent. An end that has ended holds nothing and has nothing on a clock, and one that has not
has on a clock exactly what it holds a number for. More can happen here than on a schedule: a clock runs out and a turn ends at any
moment, where a schedule keeps each in a lane. For one frame each way and one drop that is 7,004 states, where the
schedule runs 10,992 orderings of fewer. The same spec spoils what a step asked for, one way at a time, and each is
found.

What a consumer gets is held too. `npm run reference:check` compares `REFERENCE.md` with what each entry exports,
and fails for an export no spec uses, read from the type checker. `npm run package:smoke` packs the package,
installs the tarball into a project of its own, imports each entry by its name and runs the README's first example
there as it is written. CI runs both, and a release is made only from a commit where they passed.

## How it is released

Never to npm. Each commit on `master` whose CI passed is packed, and the tarball, `apackdev-link-<version>.tgz`,
is attached with its checksum to a GitHub release tagged `pkg-<commit>`, which is never replaced. apack names that
address in its `overrides` and moves it with its `deps:pin`, as it does for its other repositories' packages.

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
- Taken: **a client with no state that is told there is one closes.** Here a hello names the session it is going
  on with, and an end that is not that session finds the link lost.
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
step 4 (a socket, a port and a stream) step 5 (a connection that comes back), step 6 (a bound), step 7 (knowing the other end is there), step 8 (cause, tap and private frames), step 9 (a codec, and
frames in parts) and step 10 (releases, the reference and the wire written down).

## What is not decided

- **How what a frame carries is checked where it arrives.** A link checks that what arrived is a frame, and no
  more. apack's contracts type what a system takes; whether a link checks an ask's `args` or an answer's
  `outcome` against them, or hands it to the kernel to refuse, is open.
- **Which codec apack uses.** A codec is handed in. elmdb answers in msgpack, and a view's result is decoded and
  encoded again on its way to a window; handing msgpack in is the host's to decide.
- **Where secrets travel.** Today they are kept off the bus, in procedures of their own.

## Further off

A view's result that goes from elmdb to a window without passing through the server's JavaScript, as what
changed: [`deferred/views-from-the-engine.md`](deferred/views-from-the-engine.md).
