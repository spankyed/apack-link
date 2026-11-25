# Reference

Generated from the source by `npm run reference:update`; `npm run reference:check` holds it to the source.

## `@apackdev/link`

### `accept`

Takes connections as they arrive at a backend, each with its owner, and finds each its link. An owner is
whatever the host knows a dialler by, compared as a `Map` compares keys: it is settled by whatever admitted the
connection, and never crosses the link.

- **A session is gone on with only by its owner.** A connection that says another owner's session is told what
  one that says a session nobody has is told, that it is lost, and ends nothing.
- **An owner has one session.** A new session from an owner ends the one it had, which is told `ended`, before
  the new one is handed to `onLink`: a window that reloaded.
- **The host says an owner is gone**, with `gone`, and nothing else ends a session for a dialler that stopped
  coming back: nothing a link sees tells that from one that is slow to.

So no more sessions are kept than there are owners taken and not said to be gone. A link authenticates nobody:
who may connect, and as whom, is settled before a connection is handed here.

```ts
accept<Owner>(onLink: (link: Link, owner: Owner) => void, options?: Options): Accepting<Owner>
```

### `Accepting`

What `accept` returns: what takes each connection with whose it is, says an owner will not be back, and closes all sessions.

```ts
interface Accepting<Owner> {
  /**
   * Takes a connection, and whose it is. Its first word finds it its link: its owner's session where it says that
   * one, and a new session, handed to `onLink`, where it says one that is new. Throws a `RangeError`, having
   * closed it, for a transport that takes no message of `LEAST` bytes.
   */
  take(transport: Transport, owner: Owner): void
  /**
   * Says an owner will not be back. Its session ends, told `ended` where it can be, and every connection taken as
   * its that is still open is closed, whether or not it has said anything. Nothing is kept of the owner after: one
   * taken again is an owner met for the first time.
   */
  gone(owner: Owner): void
  /**
   * Closes every active session with `bye` (`'restarting'` so diallers reconnect, `'ended'` when shutting down for
   * good, or omitted for no goodbye), closes every open connection held by `accept`, and closes any transport passed
   * to `take` after.
   */
  close(bye?: Bye): void
}
```

### `asFrame`

What arrived, as a frame, or nothing when it is not one of the frames there are. An id is a whole number from 1,
a name is text, and a failure is a kind and a message, both text. What a frame carries for a system (`event`,
`args`, `update`, `outcome`) is the system's, and is not looked at. Only what a frame has is handed on: anything
else on what arrived is left behind.

```ts
asFrame(arrived: unknown): Frame | undefined
```

### `Bye`

Why an end went on purpose: `restarting` is to be reached again, and `ended` is not.

```ts
type Bye = 'restarting' | 'ended'
```

### `bytesOf`

How many bytes a text is as UTF-8, which is how it crosses: the one unit a link counts sizes in, and the one a
transport says what it has not written in.

```ts
bytesOf(text: string): number
```

### `Clock`

A clock, handed in: `after` runs something once, that long from now, unless what it returns is called first.

```ts
interface Clock { after(ms: number, run: () => void): () => void }
```

### `Codec`

A list a codec makes is no longer than its parts, one byte between each two, and two more, as JSON's is: a link
counts on it to cut a batch to what carries it. A codec encodes what it decodes.

```ts
interface Codec {
  /** One value in a message's form. Throws for one it cannot hold. */
  encode(value: unknown): Message
  /** Values already encoded, as a list of them. Cannot fail. */
  list(parts: readonly Message[]): Message
  /** Values already encoded, as the fields of a record. Cannot fail. */
  record(fields: ReadonlyArray<readonly [name: string, value: Message]>): Message
  /** What a message holds. Throws for one it did not make. */
  decode(message: Message): unknown
}
```

### `dial`

Makes the end of a link that dials: the one that opened the connection, or, where neither did, the one of the
two chosen to. It says hello first, and ends for what it meets: another link, a session that cannot be gone on
with, something that is not a link. Given a transport, the link is carried on it alone and ends when it
closes: what it sends goes at once, beside its hello. Given what opens a transport, and the clock to pace it on
(`reopen`), it opens one now and another after each one closes, and numbers nothing until the other end has
said hello.

```ts
dial(open: () => Transport, options: Options & { readonly reopen: Reopen; }): Link
dial(over: Transport, options?: Options): Link
```

### `DuplexLike`

What a Node `Duplex` has, and all a link uses of one.

```ts
interface DuplexLike {
  write(chunk: Uint8Array): unknown
  /** How much of what was written is not yet handed on. */
  readonly writableLength?: number
  end(): unknown
  /** Lets go of the stream at once, where it can: for one that handed over something that is not a message. */
  destroy?(): unknown
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown
  on(event: 'end' | 'close', listener: () => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
}
```

### `Ending`

Why a link closed.

```ts
type Ending =
  /** This end was closed, or what carried a link that does not come back went. */
  | { readonly why: 'closed' }
  /** The other end said it was going, and which way. */
  | { readonly why: 'goodbye'; readonly bye: Bye }
  /** The other end is a link this one cannot talk to. */
  | { readonly why: 'version'; readonly mine: number; readonly theirs: number }
  /** The session cannot be picked up again: the other end is a new one, or what is needed to go on is not held. */
  | { readonly why: 'lost' }
  | { readonly why: 'out of order'; readonly expected: number; readonly got: number }
  /** What arrived was not something a link says. `size` is how many bytes it was, which is all that is kept of it. */
  | { readonly why: 'not a frame'; readonly size: number }
  /** What waits to be sent passed its bound, with nothing left that could be let go: how much waits, and the bound. */
  | { readonly why: 'overrun'; readonly waiting: Size; readonly bound: Size }
  /**
   * The connection takes no message as long as this end needs: the longest the other end said it takes, or what
   * carries it does where that is less, and how many bytes this end needs. That is what any link needs (`LEAST`), or, where this end keeps something it numbered for a
   * connection that took longer messages, as many bytes as that is.
   */
  | { readonly why: 'too narrow'; readonly most: number; readonly needs: number }
```

### `Failure`

Why an ask failed or a view ended: a kind to act on and a message to read.

```ts
interface Failure { readonly kind: string; readonly message: string }
```

### `Following`

```ts
interface Following {
  stop(): void
  /**
   * Calls `then` once this view has been shown everything kept before the call. `soon` says something is
   * blocked on it. Offered by a system that runs views; one reached across a link has none.
   */
  caughtUp?(then: () => void, soon: boolean): void
}
```

### `Frame`

```ts
type Frame =
  /** Something happened. Nobody waits. */
  | { readonly kind: 'tell'; readonly to: string; readonly event: unknown }
  /** A question, answered once: by `answer`, however it ends. */
  | { readonly kind: 'ask'; readonly id: Id; readonly to: string; readonly name: string; readonly args: unknown }
  /** Whoever asked has gone: what was being done for them can stop. */
  | { readonly kind: 'left'; readonly id: Id }
  /** What the one answering says before it answers. */
  | { readonly kind: 'progress'; readonly id: Id; readonly update: unknown }
  /** How an ask ended. Nothing with its id follows. */
  | { readonly kind: 'answer'; readonly id: Id; readonly outcome: unknown }
  /** Follow a view: its result, and each changed result after it, until `unfollow`. */
  | { readonly kind: 'follow'; readonly id: Id; readonly feature: string; readonly view: string; readonly args: unknown }
  /** What a followed view shows now. */
  | { readonly kind: 'shown'; readonly id: Id; readonly update: unknown }
  /** The follower lets a view go. */
  | { readonly kind: 'unfollow'; readonly id: Id }
  /** The one running a view says it has ended, and why. Nothing more is shown for its id. */
  | { readonly kind: 'over'; readonly id: Id; readonly failure: Failure }
```

### `HoldStall`

Payload-free diagnostic snapshot reported when the peer hold exceeds `bound` because one or more views did not
catch up. Never carries frame payloads, arguments, or causes.

```ts
interface HoldStall {
  /** Ids of the stalled view(s) still blocking the oldest held round, which were ended `over` and stopped. */
  readonly views: readonly Id[]
  /** Frames and encoded bytes waiting in the hold when the bound was exceeded. */
  readonly held: Size
  /** Number of held rounds waiting when the bound was exceeded. */
  readonly rounds: number
  /** The configured hold bound that was exceeded. */
  readonly bound: Size
}
```

### `Id`

A number one end chose, which names an ask or a view for as long as it lasts. Each end numbers its own.

```ts
type Id = number
```

### `join`

Joins a system to the other end of a link: `mine` is what this system offers, and what is returned is what the other does.

```ts
join(link: Link, mine: Port, options?: JoinOptions): Port
```

### `JoinOptions`

Optional controls for `join`: hold bounds, payload-free stall diagnostics, and unexpected `caughtUp` error handling.

```ts
interface JoinOptions {
  /**
   * Maximum frames and encoded bytes that may wait in the hold for views to catch up. Defaults to 16 384 frames and
   * 64 MiB. When exceeded, the stalled view(s) still blocking the oldest round are ended `over` and stopped so the
   * link and all healthy views continue without ever releasing a frame ahead of a live view. Set a field to
   * `Infinity` to leave that dimension unbounded.
   */
  readonly bound?: Partial<Size>
  /** Called with payload-free diagnostics whenever stalled view(s) are ended to keep the hold within `bound`. */
  readonly onStall?: (stall: HoldStall) => void
  /**
   * Handed what a view's `caughtUp` threw (or what a stalled view's `stop` or `onStall` threw). Without it,
   * synchronous `tell` propagates what `caughtUp` threw to its caller, and throws during `ask`, `follow`, or
   * incoming-ask callbacks are thrown again in a turn of their own.
   */
  readonly thrown?: (error: unknown) => void
}
```

### `json`

Text, as JSON. What arrives as bytes is read as UTF-8.

```ts
json: Codec
```

### `LEAST`

The shortest message a link is carried on at all: one that holds the shortest part there is, the longest cause
there may be beside it, what is put around them, and the batch's own two. On anything that takes this, and on
an end that says it does, a link cuts what it sends to fit.

```ts
LEAST: number
```

### `Link`

```ts
interface Link {
  /**
   * Sends a frame, or one this link prepared. Throws if the frame cannot be sent, having sent nothing and taken no
   * number: that one frame is refused, and the link goes on. A `TypeError` for one that cannot be encoded,
   * and a `RangeError` for one larger, with its cause, than `bound.frame`, or whose cause is longer than 1024
   * bytes. While there is no connection it waits,
   * and leaves on the next. After the link has closed it sends nothing.
   */
  send(frame: Frame, how?: Sending): void
  send(prepared: Prepared): void
  /**
   * Encodes a frame now, to be sent later: throws what `send` would, sending nothing, so that what is held
   * is refused where it was said. What comes back is what the frame was when it was prepared, whatever becomes of
   * the frame after, and is sent once, by this link, without being encoded again.
   */
  prepare(frame: Frame, how?: Sending): Prepared
  /**
   * Called with each frame the other end sent, in the order it sent them, once each, with what caused it. One that
   * throws stops nothing: the others are called, the frames after it are taken, and what it threw goes to `thrown`.
   * Returns what stops calling it.
   */
  onFrame(heard: (frame: Frame, cause?: string) => void): () => void
  /** Called with each frame as it is numbered to go out and as it is taken in, as a tap sees it. Returns what stops calling it. */
  onTraffic(seen: (traffic: Traffic) => void): () => void
  /** Called once, when the link has closed, with why. One that throws does not keep the others from being called. Returns what stops calling it. */
  onEnd(ended: (ending: Ending) => void): () => void
  /**
   * Closes the link. Everything sent before leaves first, what waited for room included, wherever it can arrive
   * no more than once: on a connection where the other end has been met, on the only one of a link that does not
   * come back, and on a connection of an end that has never met anybody, which has nothing sent before to be out
   * of step with. Then a goodbye, if one is given, on the connection it is on, so the other end's ending says
   * which it was. What waited with no connection, or on one where an end met before has not been met again,
   * has nowhere to go, and is let go with what was kept. An end that listens says nothing, a goodbye included,
   * on a connection where nobody has said hello, unless it has met nobody at all. This is also how whoever holds a link says the other end
   * is gone for good.
   */
  close(bye?: Bye): void
  /** How many numbers this end keeps because the other has not said it took them: a frame, or a part of one. */
  kept(): number
  /** How many frames wait to be numbered, because the other end is behind or there is no connection. */
  waiting(): number
  /**
   * Says this end is owed something by the other, an answer, so that a quiet connection is watched while it is.
   * Call what it returns when it has come, or is no longer wanted.
   */
  awaiting(): () => void
}
```

### `LINK`

Which link this is. Both ends ship together, so there is one, and an end that says another is refused.

```ts
LINK: 1
```

### `listen`

Makes the end of a link that listens: the other end of a connection somebody else opened. It says nothing on
a connection until a hello that fits has arrived on it, and numbers nothing until then. Given a transport, the
link is carried on it alone and ends when it closes. Given nothing, it is handed each connection with `carry`,
as a backend's links are by `accept`, and ends for nothing any of them says before a hello that fits.

```ts
listen(over: Transport, options?: Options): Link
listen(over?: undefined, options?: Options): Listener
```

### `Listener`

An end of a link that listens, and is handed each connection it is carried on.

```ts
interface Listener extends Link {
  /**
   * Hands the link a connection, which whoever is at the other end of it opened. The link says nothing on it, and
   * stays on the one it has, until a hello that fits has arrived on it: then it is on this one, and says its own.
   * One whose first word does not fit is closed, told why where it would otherwise wait, and the link goes on:
   * it ends for nothing a connection says before a hello that fits. Only the last handed over waits. Throws a
   * `RangeError`, having closed it, for a transport that takes no message of `LEAST` bytes. One that takes none
   * as long as something this link numbered, and the hello on it does not say was taken, is turned away as one
   * whose hello does not fit.
   */
  carry(transport: Transport): void
}
```

### `memoryPair`

Two ends in memory, joined. What one sends the other hears later, never as it is sent, and an end closing is heard
by the other after everything sent before it, as on a socket. `later` says when what the first end sends arrives,
and `back` the same for the second: a microtask unless given. A test gives them to choose the moment, or a lane
of a schedule each, to run every order there is.

```ts
memoryPair(later?: (run: () => void) => void, back?: (run: () => void) => void): [Transport, Transport]
```

### `Message`

What crosses a transport whole: one batch of what an end said.

```ts
type Message = string | Uint8Array
```

### `MessagePortLike`

```ts
type MessagePortLike = { postMessage(message: unknown): void; close(): void; start?(): void } & (TargetPort | EmitterPort)
```

### `Options`

```ts
interface Options {
  /** What puts the batch off until the end of the turn. A microtask unless given; a spec gives a schedule's lane. */
  later?(run: () => void): void
  /**
   * `kept`: how much sent and not yet taken there may be before a link stops numbering what is sent, counted as
   * well against what the transport says it has not yet written. `waiting`: how much may wait to be numbered
   * before the link ends `overrun`. `frame`: how many bytes one frame and its cause may be, past which it is
   * refused where it is sent; 64 MiB unless given, and 1024 at least.
   */
  bound?: { readonly kept?: Partial<Size>; readonly waiting?: Partial<Size>; readonly frame?: number }
  /**
   * For a connection that can go quiet without closing: how long a connection may be quiet while this end is owed
   * something, and the clock that says when that long has passed. Without it, only a connection closing says the
   * other end has gone, which is all two ends on one machine need.
   */
  there?: { readonly window: number; readonly clock: Clock }
  /** How an end that dials and opens its connections paces opening another. Such a link is not made without it. */
  reopen?: Reopen
  /**
   * Handed what a listener threw (`onFrame`, `onEnd`), what opening a connection threw, or what a transport threw
   * where it was handed something to send. Without it, each is thrown again in a turn of its own, to be reported
   * as anything uncaught is.
   */
  thrown?(error: unknown): void
  /** What batches are encoded in. Both ends are given the same. JSON unless given. */
  codec?: Codec
  /**
   * How many bytes a part may be at most: a frame longer crosses in parts, and a batch longer crosses as more
   * than one message. 1 MiB unless given, and 16 at least. Where what carries the link, or the other end, takes
   * less, a part is as much shorter as fits: nothing has to be set to match.
   */
  part?: number
}
```

### `Outcome`

How an ask ended. A system's own outcomes pass through as they are; these are the ones a link makes.

```ts
type Outcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly failure: Failure }
```

### `port`

A transport over a message port. A port closing is not told to the other end everywhere, so closing says so
first, as a message of its own after everything sent before it.

```ts
port(of: MessagePortLike): Transport
```

### `Port`

What one system offers another.

```ts
interface Port {
  /** Something happened. Nobody waits. Throws for an event that cannot be sent, having sent nothing. */
  tell(to: string, event: unknown, how?: Sending): void
  /** Asks. `heard` takes what is said before the answer, `ended` how it ended. Returns what to call when whoever asked has gone. */
  ask(
    to: string,
    name: string,
    args: unknown,
    heard: (update: unknown, how?: Sending) => void,
    ended: (outcome: Outcome, how?: Sending) => void,
    how?: Sending,
  ): () => void
  /** Follows a view. `shown` takes its result and each changed result after it, `over` that it has ended and why. */
  follow(
    feature: string,
    view: string,
    args: unknown,
    shown: (update: unknown, how?: Sending) => void,
    over: (failure: Failure, how?: Sending) => void,
    how?: Sending,
  ): Following
}
```

### `Prepared`

A frame encoded by a link, to be sent by it later: what `prepare` returns. It says the frame's kind and encoded byte size (including cause), and nothing else.

```ts
interface Prepared {
  readonly [PREPARED]: true
  readonly prepared: Frame['kind']
  readonly size: number
}
```

### `Reopen`

How opening a connection again is paced, on a clock handed in. A connection has held once it has stayed up,
after the other end said hello on it, for as long as the wait before it was opened, and for `first` at least.
After one that held, the next is opened as soon as the clock runs something asked for after no time. After one
that did not, met or not, the wait is `first` milliseconds (100 unless given), doubled for each such connection
in a row, and never more than `most` (10 000 unless given).

```ts
interface Reopen { readonly clock: Clock; readonly first?: number; readonly most?: number }
```

### `Sending`

How a frame is sent: what caused it, a short text the kernel makes and a link never reads, 1024 bytes at most as
it crosses; and whether it is private.

```ts
interface Sending { readonly cause?: string; readonly private?: boolean }
```

### `Sent`

A frame as it is on the wire: with its place in everything this end has sent.

```ts
interface Sent {
  /** One more than the frame before it from this end, from 1. */
  readonly seq: number
  readonly frame: Frame
  /** What caused it: a short text the kernel makes, passed on and never read. */
  readonly cause?: string
  /** A tap at either end is told only that it crossed, and its size. */
  readonly private?: true
}
```

### `Size`

How much: a count of frames, and how many bytes they are encoded, text as UTF-8.

```ts
interface Size { readonly frames: number; readonly size: number }
```

### `socket`

A transport over a WebSocket. What is sent while it is still opening waits, and leaves in order once it is open.
Bytes arrive as a `Uint8Array`.

```ts
socket(ws: WebSocketLike, options?: SocketOptions): Transport
```

### `SocketOptions`

```ts
interface SocketOptions {
  /**
   * The longest message, in bytes, the other end of the socket takes, where it takes none longer: a server's limit
   * on a message. The transport says it (`most`), so a link carried on it cuts what it sends to fit, and is not
   * carried on it at all if that is less than `LEAST` or what it still keeps. A socket says nothing of this itself.
   */
  readonly most?: number
}
```

### `stream`

A transport over a stream of bytes. What arrives in pieces is put together, and what arrives together is taken
apart. A stream that hands over something that is not a message, or one longer than `most`, closes, and the
stream beneath it is let go.

```ts
stream(duplex: DuplexLike, options?: StreamOptions): Transport
```

### `StreamOptions`

```ts
interface StreamOptions {
  /**
   * The longest message, in bytes, that is sent or taken: a head that claims more closes the stream, and so does
   * sending more. 128 MiB unless given, and at most `0xffff_ffff` (what a four-byte length can say). The transport
   * says it (`most`), and a link carried on it sends nothing longer, so both ends are to be given the same.
   */
  readonly most?: number
}
```

### `timers`

A clock on the timers a window and Node both have, for whoever makes a link to hand it. A link reaches for no
clock itself: it has this one only where it is given it.

```ts
timers: Clock
```

### `Traffic`

A frame crossing, as a tap sees it: never what it carries. `name` is a tell's `to`, an ask's name or a view's
name. Of a private frame, only that it crossed, its number and its size.

```ts
type Traffic =
  | {
    readonly direction: 'out' | 'in'
    /** Its number; for a frame in parts, its first part's. */
    readonly seq: number
    readonly kind: Frame['kind']
    readonly id?: number
    readonly name?: string
    /** How many bytes it is as it crosses, numbered, with its cause: for a frame in parts, all of its parts. */
    readonly size: number
    readonly cause?: string
  }
  | { readonly direction: 'out' | 'in'; readonly seq: number; readonly private: true; readonly size: number }
```

### `Transport`

```ts
interface Transport {
  send(message: Message): void
  /** Called with each message the other end sent, in the order it was sent. */
  onData(heard: (message: Message) => void): void
  /** Called once, when nothing more will arrive: either end closed it, or what carried it went. */
  onClose(closed: () => void): void
  /** Closes this end now. The other end is handed what was sent before this, and then hears that it closed. */
  close(): void
  /** How many bytes of what was sent it has not yet written, where it can say. A link counts it against its bound. */
  waiting?(): number
  /**
   * The longest message it carries, in bytes, where there is one. A link hands it nothing longer: a batch that
   * would be crosses as more than one, and a frame that would be is cut into parts.
   */
  readonly most?: number
}
```

### `WebSocketLike`

What a browser's `WebSocket` and Node's `ws` both have, and all a link uses of either.

```ts
interface WebSocketLike {
  /** 0 opening, 1 open, 2 closing, 3 closed. */
  readonly readyState: number
  /** How much of what was sent is not yet written to the network. */
  readonly bufferedAmount: number
  binaryType: string
  send(data: string | Uint8Array): void
  close(): void
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void
}
```

## `@apackdev/link/testing`

### `Asked`

An ask as the system asked sees it.

```ts
interface Asked {
  readonly to: string
  readonly name: string
  readonly args: unknown
  readonly cause?: string
  heard(update: unknown, how?: Sending): void
  ended(outcome: Outcome, how?: Sending): void
  /** How many times it was told whoever asked has gone. */
  left: number
}
```

### `asking`

```ts
asking(of: Port, to: string, name: string, args: unknown, how?: Sending): Asking
```

### `Asking`

An ask as whoever made it sees it: what it heard and how it ended, in order, and `leave` to go.

```ts
interface Asking {
  readonly heard: unknown[]
  readonly ended: Outcome[]
  /** Everything that reached the asker and what the asker did, in the order it happened. */
  readonly log: string[]
  leave(): void
}
```

### `carried`

Wraps two joined transports so that what crosses them is run in a lane of the schedule for each direction.

```ts
carried(schedule: Schedule, pair: readonly [Transport, Transport], names?: readonly [string, string]): [Transport, Transport]
```

### `desk`

A system that notes what reaches it. `tell`, `ask` and `follow` are called as each arrives, to answer or show
there and then or to put it off into a lane; `follow` may return what the view's `Following` has beside `stop`.

```ts
desk(does?: { tell?(to: string, event: unknown, how?: Sending): void; ask?(asked: Asked): void; follow?(viewed: Viewed): Pick<Following, "caughtUp"> | void; }): Desk
```

### `Desk`

```ts
interface Desk {
  readonly port: Port
  readonly told: Array<{ to: string; event: unknown; cause?: string }>
  readonly asks: Asked[]
  readonly views: Viewed[]
}
```

### `Dropping`

```ts
interface Dropping extends Ends {
  /** Drops the connection the two are on. The first end opens another, and the second is handed it. */
  drop(): void
  /**
   * The second end goes, closing the connection from its side, and a new one with a session of its own takes the
   * next connection.
   */
  restart(): void
  /** The second end as it is now: after a restart, the new one. */
  readonly now: Link
  /** How many connections have been opened. */
  readonly connections: number
}
```

### `droppingMemoryEnds`

The first end is given what opens a connection, as a window is; the second is handed each one, as a backend is.
What crosses one way is one lane however many connections there are, as on one socket at a time, and the first
end opens another connection in the lane of what it sends: after what it sent on the one before. The first `unreachable` connections reach nobody: each closes
with nothing having crossed, as one does to a backend that is not listening yet. What else
`options` holds, a codec or a part, is given to every link made here. Given a model, every link made here is put
under it.

```ts
droppingMemoryEnds(schedule: Schedule, options?: Options & { readonly unreachable?: number; }, held?: Model): Dropping
```

### `DroppingScenario`

```ts
interface DroppingScenario {
  readonly name: string
  /** How many of the first end's connections are to reach nobody before one does: `droppingMemoryEnds` is given it. */
  readonly unreachable?: number
  play(schedule: Schedule, ends: Dropping): () => void
}
```

### `Ends`

Two ends of one link.

```ts
interface Ends { readonly a: Link; readonly b: Link }
```

### `hold`

Step 2's: what a system says waits until the views it runs for the other end have caught up.

```ts
hold: readonly KitScenario[]
```

### `holds`

Throws unless it holds.

```ts
holds(held: boolean, what: string): void
```

### `KitScenario`

```ts
interface KitScenario {
  readonly name: string
  play(schedule: Schedule, ends: Ends): () => void
}
```

### `laneClock`

A clock that keeps no time, for a link on a schedule: what is asked for runs when the schedule gets to it in the
lane given, however long was asked for, unless it is called off first. Pass `resource` (e.g. a link's DPOR
resource) so timer firings and cancellations attribute directly to that resource even on no-op or state-only turns.

```ts
laneClock(schedule: Schedule, lane: Lane, options?: TaskOptions & { readonly resource?: Resource; }): Clock
```

### `made`

Things made, and the views of how many. `offers: false` is views that offer no `caughtUp`, which is the hold
taken out. A view called `stuck` never calls back.

```ts
made(schedule: Schedule, options?: { offers?: boolean; }): Made
```

### `Made`

```ts
interface Made {
  /** How many things have been made. */
  readonly count: number
  /** Makes one. Each view followed is shown the new count, later, in its lane. Returns the new count. */
  make(): number
  /** What a desk's `follow` is given: shows the count now, and each change in the view's lane after. */
  follow(viewed: Viewed): Pick<Following, 'caughtUp'> | void
  /** Every `soon` a view was asked with, in order. */
  readonly soon: boolean[]
}
```

### `MakeEnds`

What a pair of ends is made over: given a schedule, two links.

```ts
type MakeEnds = (schedule: Schedule) => Ends
```

### `memoryEnds`

Two ends of a link in memory, on a schedule, made with `options`: the first dials and the second listens. What
this package's own scenarios are run over. Given a model, each end is put under it (with cross-end ending checks
attributed to a shared model resource when `tracked: true` so wakeup-tree DPOR remains sound).

```ts
memoryEnds(schedule: Schedule, options?: Options & { readonly tracked?: boolean; readonly names?: readonly [string, string]; }, held?: Model): Ends
```

### `model`

Makes a model to hold ends to: every link of one scenario is put under the same one.

```ts
model(options?: ModelOptions): Model
```

### `Model`

```ts
interface Model {
  /** Puts a link under the model, before anything is sent on it or listens to it. What comes back is the link to use. */
  end<L extends Link>(link: L, name: string): L
  /**
   * What must hold once everything has come to rest. Throws for the first thing an end did that the model could
   * not have, with what led to it; and for what an end that is still there was sent, by the one end still there
   * that it could be talking to, and has not been handed.
   */
  check(): void
}
```

### `ModelOptions`

```ts
interface ModelOptions {
  /** What the ends' frames are encoded in, which is how one is known again once it has crossed. JSON unless given. */
  readonly codec?: Codec
  /**
   * Endings that are let pass. Without it, no end is `out of order`, `not a frame`, `version` or `too narrow`:
   * between two ends of this package set alike, on something that carries what it is handed, each is a defect.
   * And no end is `lost` while every end it could be talking to is still there: `'lost'` here lets that pass,
   * for a scenario where an end goes without its link being closed.
   */
  readonly may?: ReadonlyArray<Ending['why']>
  /** Whether what was sent and never handed over is let pass at rest: for a scenario that leaves ends unable to reach each other. */
  readonly unfinished?: boolean
}
```

### `peers`

Steps 1's: asks matched to their answers, views followed and let go, and everything ended when the link is.

```ts
peers: readonly KitScenario[]
```

### `resume`

Step 5's: a link that outlives what carries it, with nothing taken twice. Each drops at a moment the schedule picks.

```ts
resume: readonly DroppingScenario[]
```

### `same`

Throws unless the two are the same all the way down. `what` says what was being looked at.

```ts
same(actual: unknown, expected: unknown, what: string): void
```

### `ScheduledOptions`

Options for `scheduledPair` when opting into wakeup-tree DPOR tracking.

```ts
interface ScheduledOptions {
  /**
   * Marks both directions as tracked for wakeup-tree DPOR: allocates one `Resource` per end (or uses `resources`) so
   * deliveries, sends, listener changes, and closes on disjoint ends commute while operations on the same end
   * conflict. Only enable when listeners attached to both ends report their own shared-state accesses. Defaults to `false`.
   */
  readonly tracked?: boolean
  /** Pre-allocated resources `[a, b]` for the two ends, for callers that share them with `trackedLink` or `trackedJoin`. */
  readonly resources?: readonly [Resource, Resource]
  /** Pre-allocated lanes `[aToB, bToA]` to reuse across multiple connections of the same pair (e.g. `reopen`). */
  readonly lanes?: readonly [Lane, Lane]
}
```

### `scheduledPair`

Two ends in memory on a schedule: each direction is a lane of its own, so what crosses one way keeps its order
and the schedule chooses between the two, and whatever else a spec adds.

```ts
scheduledPair(schedule: Schedule, names?: readonly [string, string], options?: ScheduledOptions): [Transport, Transport]
```

### `trackedJoin`

Joins `link` and `mine` while attributing every peer-hold, port-call, async answer/view callback, and `caughtUp`
callback mutation on this end to `resource` for wakeup-tree DPOR.

```ts
trackedJoin(link: Link, mine: Port, schedule: Schedule, resource: Resource, options?: JoinOptions): Port
```

### `trackedLater`

Returns a `Link` `Options.later` callback that schedules each batch flush on `lane` as a tracked DPOR task and
records a write to `resource` even if the link already flushed or closed before the turn runs.

```ts
trackedLater(schedule: Schedule, lane: Lane, resource: Resource): (run: () => void) => void
```

### `trackedLink`

Wraps a `Link` (or `Listener`) so direct calls and listener subscriptions on this end record `read()`/`write()`
against `resource` for wakeup-tree DPOR, keeping pure protocol activity on disjoint ends commutative.

```ts
trackedLink<L extends Link>(link: L, schedule: Schedule, resource: Resource): L
```

### `underModel`

Runs what a scenario builds with a model to put its ends under, and returns its check with the model's after it:
`everyOrder((schedule) => underModel((held) => scenario.play(schedule, memoryEnds(schedule, {}, held))))`.

```ts
underModel(play: (held: Model) => () => void, options?: ModelOptions): () => void
```

### `Viewed`

A followed view as the system running it sees it.

```ts
interface Viewed {
  readonly feature: string
  readonly view: string
  readonly args: unknown
  readonly cause?: string
  shown(update: unknown, how?: Sending): void
  over(failure: Failure, how?: Sending): void
  /** How many times it was stopped. */
  stopped: number
}
```

### `watching`

```ts
watching(of: Port, feature: string, view: string, args: unknown, how?: Sending): Watching
```

### `Watching`

A view as whoever follows it sees it.

```ts
interface Watching {
  readonly shown: unknown[]
  readonly over: Failure[]
  readonly log: string[]
  stop(): void
}
```

### `withoutTheHold`

The hold's scenarios with the hold taken out: views that offer no `caughtUp`. Each fails in some order.

```ts
withoutTheHold: readonly KitScenario[]
```
