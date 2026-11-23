// One end of a link: frames out, frames in, each in the order it was sent, once, across connections that drop and
// come back.
//
// Every frame an end sends is numbered, one more than the last. The other end takes a frame only if it is the next
// one, so a frame lost, doubled or out of place is found where it arrives and the link is closed, saying why: a
// link that went on would be handing over frames in an order nobody sent them in.
//
// Beside frames, a link says a few things about itself, none of them numbered: a hello first on each connection,
// saying which session this end is and the last number it has taken; with a batch, the last number taken; a
// goodbye when it goes on purpose; that a session cannot be resumed; and whether the other end is there. Only a
// frame, or a part of one, is numbered, and kept.
//
// What an end says within one turn crosses as one message: a batch, a list of what it said. A frame is encoded when
// it is sent, so one that cannot be is refused there alone, and the batch is those encodings joined, by the codec
// handed in (JSON unless given). The batch leaves when `later` says, a microtask unless given, as more than
// one message where it is longer than a part. A frame longer than a part crosses as parts, each numbered, one after another, and is
// handed over whole once the last has arrived.
//
// A link outlives what carries it. Each end keeps what it has sent until the other says it took it. A new
// connection's hellos say where each end got to and which session each believes it is going on with, each sends
// again what the other has not taken, in order, and goes on; since a frame is taken only in turn, nothing is taken
// twice, and a resume can pick up within a frame in parts. A link that can come back numbers nothing until it has met the other end, so an end that has met nobody
// has sent nothing anybody could have taken, and starts afresh with whoever it meets. A link given what opens a
// connection opens another when one closes, when the clock it was given says; a link made with nothing is handed
// each connection (`carry`), as a backend's are by `accept`. Neither is given a time to wait for the other end
// in: whoever holds a link says when the other end is gone, with `close`.
//
// What is kept is bounded. How far behind the other end is, is what it has not said it took: past a mark, a link
// stops numbering, and what is sent waits unnumbered, where a view's result that a later one has overtaken can be
// let go. What waits is bounded too, and past it, with nothing left to let go, the link ends `overrun`. One frame
// is bounded as well, and one past it is refused where it is sent. Every size is in bytes, of text as UTF-8.
//
// What carries a link may take no message longer than it says (`most`), and each end says in its hello the
// longest it takes. A batch that would be longer than either crosses as more than one, cut between frames, in
// order. A link is not carried on what takes no message as long as a frame it may send.
//
// A connection handed to a link that is on one where the other end has been met waits: the link says nothing on
// it, and keeps the one it has, until whoever is on the new one has said a hello that fits. One that does not is
// turned away. And a link that is handed its connections turns a connection away for anything said on it before a
// hello that fits, and goes on: only the end that opened a connection ends for what it met there.
//
// What carries a link saying it closed is the first word that the other end has gone. For a connection that can go
// quiet without closing, a link given a window and a clock watches while it is owed something, a `taken` or an
// answer: quiet for half the window, it asks whether the other end is there; quiet for the whole of it, with nothing
// of any kind arriving, it closes the connection, to be opened again. Nothing is given a time to answer in.
//
// What a listener throws is never the link's. Every listener is still called and every frame of a batch still
// taken, and what was thrown is handed to `thrown`, or thrown again in a turn of its own.
import { head, joined, json, lengthOf, sizeOf, slice, type Codec } from './codec.ts'
import { asFrame, type Frame } from './frames.ts'
import type { Message, Transport } from './transport.ts'

/** Which link this is. Both ends ship together, so there is one, and an end that says another is refused. */
export const LINK = 1

/** Why an end went on purpose: `restarting` is to be reached again, and `ended` is not. */
export type Bye = 'restarting' | 'ended'

/** Why a link closed. */
export type Ending =
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
   * The other end takes no message as long as a frame this end may send: the longest it said it takes, and how
   * many bytes a frame may be here. The two ends are not set to talk to each other.
   */
  | { readonly why: 'too narrow'; readonly most: number; readonly needs: number }

/** How much: a count of frames, and how many bytes they are encoded, text as UTF-8. */
export interface Size { readonly frames: number; readonly size: number }

/** How a frame is sent: what caused it, a short text the kernel makes and a link never reads, and whether it is private. */
export interface Sending { readonly cause?: string; readonly private?: boolean }

/**
 * A frame crossing, as a tap sees it: never what it carries. `name` is a tell's `to`, an ask's name or a view's
 * name. Of a private frame, only that it crossed, its number and its size.
 */
export type Traffic =
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

export interface Link {
  /**
   * Sends a frame, or one this link prepared. Throws if the frame cannot be sent, having sent nothing and taken no
   * number: that one frame is refused, and the link goes on. A `TypeError` for one that cannot be encoded,
   * and a `RangeError` for one larger, with its cause, than `bound.frame`. While there is no connection it waits,
   * and leaves on the next. After the link has closed it sends nothing.
   */
  send(frame: Frame | Prepared, how?: Sending): void
  /**
   * Encodes a frame now, to be sent later: throws what `send` would, sending nothing, so that what is held
   * is refused where it was said. What comes back is what the frame was when it was prepared, whatever becomes of
   * the frame after, and is sent once, by this link, without being encoded again.
   */
  prepare(frame: Frame, how?: Sending): Prepared
  /**
   * Called with each frame the other end sent, in the order it sent them, once each, with what caused it. One that
   * throws stops nothing: the others are called, the frames after it are taken, and what it threw goes to `thrown`.
   */
  onFrame(heard: (frame: Frame, cause?: string) => void): void
  /** Called with each frame as it is numbered to go out and as it is taken in, as a tap sees it. */
  onTraffic(seen: (traffic: Traffic) => void): void
  /** Called once, when the link has closed, with why. One that throws does not keep the others from being called. */
  onEnd(ended: (ending: Ending) => void): void
  /**
   * Closes the link. Everything sent before leaves first, what waited for room included, wherever it can arrive
   * no more than once: on a connection where the other end has been met, on the only one of a link that does not
   * come back, and on a connection of an end that has never met anybody, which has nothing sent before to be out
   * of step with. Then a goodbye, if one is given, on whatever connection there is, so the other end's ending
   * says which it was. What waited with no connection, or on one where an end met before has not been met again,
   * has nowhere to go, and is let go with what was kept. This is also how whoever holds a link says the other end
   * is gone for good.
   */
  close(bye?: Bye): void
  /**
   * Hands the link a connection to be carried on, in place of the one it has. While the link is on one where the
   * other end has been met, it keeps that one, and says nothing on the new one, until a hello that fits has
   * arrived on the new one: the end that opened a connection speaks first on it. One whose hello does not fit is
   * closed, and the link goes on. Throws a `RangeError`, having closed it, for a transport that takes no message
   * as long as a frame this link may send.
   */
  carry(transport: Transport): void
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

/** A frame encoded by a link, to be sent by it later: what `prepare` returns. It says the frame's kind and nothing else. */
export interface Prepared { readonly prepared: Frame['kind'] }

/** What an end says of itself. None takes a number. */
/**
 * `resumes` is the other end's session, from an end that has met it: absent, this end has met nobody. `most` is
 * the longest message, in bytes, this end takes on this connection: absent, any.
 */
type Hello = { readonly link: number; readonly session: string; readonly taken: number; readonly resumes?: string; readonly most?: number }
type Taken = { readonly taken: number }
type Goodbye = { readonly bye: Bye }
type Lost = { readonly lost: true }
/** Whether the other end is there, and that it is. */
type There = { readonly there: number }
type Here = { readonly here: number }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !ArrayBuffer.isView(value)
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
/** Whether what arrived is a hello of this link's number, as far as its shape goes. */
const isHello = (said: unknown): said is Hello => isObject(said) && said.link === LINK && typeof said.session === 'string' && isCount(said.taken)
  && (said.resumes === undefined || typeof said.resumes === 'string') && (said.most === undefined || (isCount(said.most) && said.most > 0))

export interface Options {
  /** What puts the batch off until the end of the turn. A microtask unless given; a spec gives a schedule's lane. */
  later?(run: () => void): void
  /**
   * `kept`: how much sent and not yet taken there may be before a link stops numbering what is sent, counted as
   * well against what the transport says it has not yet written. `waiting`: how much may wait to be numbered
   * before the link ends `overrun`. `frame`: how many bytes one frame and its cause may be, past which it is
   * refused where it is sent; 64 MiB unless given, and 1024 at least.
   */
  bound?: { readonly kept?: Size; readonly waiting?: Size; readonly frame?: number }
  /**
   * For a connection that can go quiet without closing: how long a connection may be quiet while this end is owed
   * something, and the clock that says when that long has passed. Without it, only a connection closing says the
   * other end has gone, which is all two ends on one machine need.
   */
  there?: { readonly window: number; readonly clock: Clock }
  /** How a link given what opens a connection paces opening another. Such a link is not made without it. */
  reopen?: Reopen
  /**
   * Handed what a listener threw (`onFrame`, `onEnd`), what opening a connection threw, or what a transport threw
   * where it was handed something to send. Without it, each is thrown again in a turn of its own, to be reported
   * as anything uncaught is.
   */
  thrown?(error: unknown): void
  /** What batches are encoded in. Both ends are given the same. JSON unless given. */
  codec?: Codec
  /** How many bytes a part may be: a frame longer crosses in parts, and a batch leaves once it is this long. 1 MiB unless given. */
  part?: number
}

/**
 * How opening a connection again is paced, on a clock handed in. A connection has held once it has stayed up,
 * after the other end said hello on it, for as long as the wait before it was opened, and for `first` at least.
 * After one that held, the next is opened as soon as the clock runs something asked for after no time. After one
 * that did not, met or not, the wait is `first` milliseconds (100 unless given), doubled for each such connection
 * in a row, and never more than `most` (10 000 unless given).
 */
export interface Reopen { readonly clock: Clock; readonly first?: number; readonly most?: number }

/** A clock, handed in: `after` runs something once, that long from now, unless what it returns is called first. */
export interface Clock { after(ms: number, run: () => void): () => void }

/**
 * A clock on the timers a window and Node both have, for whoever makes a link to hand it. A link reaches for no
 * clock itself: it has this one only where it is given it.
 */
export const timers: Clock = {
  after: (ms, run) => {
    const timer = setTimeout(run, ms)
    return () => { clearTimeout(timer) }
  },
}

/** A link a little behind sends at once; one far behind lets a view's results be overtaken; one past it ends. */
const KEPT: Size = { frames: 1024, size: 16 * 1024 * 1024 }
const WAITING: Size = { frames: 16384, size: 64 * 1024 * 1024 }
/** How many bytes one frame and its cause may be, unless given. */
const FRAME = 64 * 1024 * 1024
/** The least `bound.frame` may be: more than anything a peer says in place of what could not be sent. */
const SMALLEST = 1024
/**
 * More than everything a link puts around a frame and its cause where it numbers it, or around a part of one: the
 * numbers, and the names.
 */
const AROUND = 128
/** The least a part may be: more than any one character is as a part's data, so that a frame can always be cut to it. */
const SHORTEST = 16
/** How many bytes a part may have to spare and be taken as full: a character or two. */
const SPARE = 8
/** How many bytes what caused a frame may be, as it crosses: it is a short text, and it crosses whole beside a frame or its first part. */
const CAUSE = 1024
/**
 * The shortest message that holds any one thing a link numbers: a frame no longer than a part, or a part of a
 * longer one, with its cause; what is put around it; and the batch's own two. Never more than a whole frame of
 * `largest` bytes would be.
 */
const needs = (largest: number, part: number): number => Math.min(largest, part + CAUSE) + AROUND + 2
/** Throws for what takes no message as long as the link may need to send, having closed it: a link is not carried on that. */
const wideEnough = (transport: Transport, needed: number): void => {
  if (transport.most === undefined || transport.most >= needed) return
  try { transport.close() } catch { /* it is not this link's to report */ }
  throw new RangeError(`What a link is carried on takes messages of ${needed} bytes at least, for what it may send`)
}

/** How long a link waits to open a connection after the first that did not hold, and the most it waits. */
const REOPEN_FIRST = 100
const REOPEN_MOST = 10_000
const PART = 1024 * 1024

/** What a tap may be told of a frame. */
interface About {
  readonly kind: Frame['kind']
  readonly id?: number
  readonly name?: string
  readonly cause?: string
  readonly private: boolean
}
const aboutOf = (frame: Frame, how: Sending): About => ({
  kind: frame.kind,
  ...('id' in frame ? { id: frame.id } : {}),
  ...(frame.kind === 'tell' ? { name: frame.to } : frame.kind === 'ask' ? { name: frame.name } : frame.kind === 'follow' ? { name: frame.view } : {}),
  ...(how.cause === undefined ? {} : { cause: how.cause }),
  private: how.private === true,
})
/** A frame crossing, as a tap is told of it: of a private one, nothing but that it crossed. */
const seen = (direction: 'out' | 'in', seq: number, size: number, about: About): Traffic => about.private
  ? { direction, seq, private: true, size }
  : { direction, seq, kind: about.kind, ...(about.id === undefined ? {} : { id: about.id }), ...(about.name === undefined ? {} : { name: about.name }), size, ...(about.cause === undefined ? {} : { cause: about.cause }) }

/** Encodes a frame, or refuses it with an error of the link's own: what a codec says of a value names its keys. */
const encodeFrame = (codec: Codec, frame: Frame): Message => {
  try { return codec.encode(frame) } catch { throw new TypeError('A frame could not be put into text') }
}

/**
 * Makes one end of a link. Given a transport, the link is carried on it alone and ends when it closes: what it
 * sends goes at once. Given what opens a transport, and the clock to pace it on (`reopen`), it opens one now and
 * another after each one closes. Given nothing, it waits to be handed each connection with `carry`. A link of the
 * last two kinds can come back, and numbers nothing until the other end has said hello.
 */
export function link(open: () => Transport, options: Options & { readonly reopen: Reopen }): Link
export function link(over?: Transport, options?: Options): Link
export function link(over?: Transport | (() => Transport), options: Options = {}): Link {
  const pace = options.reopen
  // Opening again with nothing to pace it is a link that spins while its connections fail: not one to be made.
  if (typeof over === 'function' && !pace) throw new TypeError('A link that opens its own connections is given a clock to open them on')
  const later = options.later ?? queueMicrotask
  const codec = options.codec ?? json
  const part = options.part ?? PART
  if (part < SHORTEST) throw new RangeError(`part is ${SHORTEST} bytes at least`)
  const mine = crypto.randomUUID()
  /** The other end's session, once it has said it. A connection from another is not this link's. */
  let theirs: string | undefined
  let sent = 0
  let heard = 0
  /** The last number the other end said it took: what was sent up to it is no longer kept. */
  let released = 0
  /** What was sent and not yet taken, as it is on the wire, oldest first, and the size of all of it. */
  let kept: Array<{ readonly seq: number; readonly encoded: Message; readonly size: number }> = []
  let keptSize = 0
  const mark = { ...KEPT, ...options.bound?.kept }
  const bound = { ...WAITING, ...options.bound?.waiting }
  const largest = options.bound?.frame ?? FRAME
  // Less would refuse what a peer says in place of something that could not be sent, and leave an ask unanswered.
  if (largest < SMALLEST) throw new RangeError(`bound.frame is ${SMALLEST} bytes at least`)
  /** The shortest message that holds any one thing this link numbers. */
  const needed = needs(largest, part)
  /** A frame encoded, with what is told of it and, for a view's result, which view. */
  interface Ready { encoded: Message; size: number; about: About; readonly view?: number }
  /** What was sent and waits to be numbered, each frame encoded, oldest first, and the size of all of it. */
  let waiting: Ready[] = []
  /** What this link prepared and has not sent. */
  const prepared = new WeakMap<Prepared, Ready>()
  let waitingSize = 0
  /** For each view with a result waiting, that result: a later one takes its place. */
  const showing = new Map<number, (typeof waiting)[number]>()
  /** The parts of a frame arriving in parts, so far, and how many bytes they were as they crossed. */
  let parting: { readonly first: number; readonly of: number; readonly pieces: Message[]; bytes: number; size: number; readonly cause?: string; readonly private: boolean } | undefined
  let ending: Ending | undefined
  const hears: Array<(frame: Frame, cause?: string) => void> = []
  const taps: Array<(traffic: Traffic) => void> = []
  /** Tells each tap. A tap that throws is not this link's to report, and does not stop it. */
  const tap = (traffic: Traffic): void => { for (const seen_ of taps) try { seen_(traffic) } catch { /* the tap's */ } }
  const ends: Array<(ending: Ending) => void> = []
  /** Hands on what a listener threw: to `thrown`, or to a turn of its own, where nothing of the link's is under it. */
  const report = (error: unknown): void => {
    let thrown = error
    if (options.thrown) try { options.thrown(error); return } catch (again) { thrown = again }
    queueMicrotask(() => { throw thrown })
  }
  /** Whether this link is carried on one connection alone, and ends with it. */
  const once = typeof over === 'object'
  /** Whether this link is handed its connections: it opened none of them, and ends for nothing said on one before a hello that fits. */
  const handed = over === undefined
  /** How many connections in a row have gone without having held, and what calls off the next being opened. */
  let failed = 0
  let reopening: (() => void) | undefined
  /** What calls off finding that the connection this link is on has held. */
  let holding: (() => void) | undefined
  /** How long the wait is before a connection is opened, after that many in a row that did not hold. */
  const wait = (after: number): number => (after ? Math.min(pace?.most ?? REOPEN_MOST, (pace?.first ?? REOPEN_FIRST) * 2 ** (after - 1)) : 0)
  /** How many things this end is owed beside a `taken`, and the watch on a quiet connection while it is owed any. */
  let owed = 0
  let watching: (() => void) | undefined
  let asked = 0
  /** What a link says of itself, encoded. These are its own values, which a codec can always hold. */
  const word = (value: Hello | Taken | Goodbye | Lost | There | Here): Message => codec.encode(value)

  /** The connection a link is on now, with what is said on it this turn. */
  interface Connection {
    readonly transport: Transport
    /** Whether the other end has said hello on it. Nothing else is taken before it. */
    met: boolean
    /** Whether what is sent goes out on it now: at once on the one connection of a link that does not come back, and on any other once the other end has said hello. */
    live: boolean
    /** Whether it has held: stayed up, once the other end was met, for as long as the wait before it. */
    held: boolean
    /** The last number this end has said, on this connection, that it took. */
    told: number
    /** The longest message the other end said it takes, once it has said. */
    takes: number
    /** What is said on it this turn, and how many bytes each is. */
    batch: Message[]
    sizes: number[]
    due: boolean
  }
  let now: Connection | undefined
  /** A connection handed over while the link is on one where the other end has been met: not yet heard to fit. */
  let pending: Transport | undefined

  /** Opens the next connection of a link given what opens one, when the clock says. */
  const reopen = (): void => {
    const open = over as () => Transport
    let off = false
    const stop = pace!.clock.after(wait(failed), () => {
      if (off) return
      reopening = undefined
      if (ending || now) return
      // What cannot be opened, or carried, is a connection that did not hold.
      try { carry(open()) } catch (error) { failed++; reopen(); report(error) }
    })
    reopening = () => { off = true; stop() }
  }
  /** A connection has gone: a link that does not come back ends, and one that opens its own opens another. */
  const dropped = (on: Connection): void => {
    if (now !== on) return
    now = undefined
    holding?.()
    holding = undefined
    if (ending) return
    if (once) { end({ why: 'closed' }); return }
    failed = on.held ? 0 : failed + 1
    if (typeof over === 'function') reopen()
  }
  /** Puts something in what is said on a connection this turn. */
  const put = (on: Connection, encoded: Message, size = sizeOf(encoded)): void => { on.batch.push(encoded); on.sizes.push(size) }

  const flush = (on: Connection): void => {
    on.due = false
    if (ending || now !== on) return
    if (!on.batch.length && !(on.met && heard > on.told)) return
    // What this end has taken goes with it, when there is more to say of it: last, behind a hello if there is one.
    if (on.met && heard > on.told) { put(on, word({ taken: heard })); on.told = heard }
    const { batch, sizes } = on
    on.batch = []
    on.sizes = []
    // One message, unless it would be longer than a part, or than what carries it or the other end takes: then as
    // few as it takes, cut between what was said, in order, so that no one write is much longer than a part. A
    // list of `n` things is no more than their bytes, one between each two, and two more. One thing longer than a
    // part by itself, a part with what goes around it, is a message of its own: it fits what carries the link,
    // which is on nothing too narrow for what it may send.
    const most = Math.min(on.transport.most ?? Infinity, on.takes, part)
    const texts: Message[] = []
    let from = 0
    let bytes = 2
    for (let at = 0; at < batch.length; at++) {
      const size = sizes[at]!
      if (at > from && bytes + 1 + size > most) {
        texts.push(codec.list(batch.slice(from, at)))
        from = at
        bytes = 2
      }
      bytes += size + (at > from ? 1 : 0)
    }
    texts.push(codec.list(from ? batch.slice(from) : batch))
    // A transport that cannot send is a connection that has gone. Every frame in the batch is kept, and is sent
    // again on the next. None of those here throws, so what one threw is handed on as well.
    try { for (const text of texts) on.transport.send(text) } catch (error) {
      dropped(on)
      try { on.transport.close() } catch { /* it has gone already */ }
      report(error)
    }
  }
  const say = (on: Connection, encoded: Message, size?: number): void => {
    put(on, encoded, size)
    if (on.due) return
    on.due = true
    later(() => flush(on))
  }

  const end = (why: Ending): void => {
    if (ending) return
    ending = why
    watching?.()
    watching = undefined
    reopening?.()
    reopening = undefined
    holding?.()
    holding = undefined
    kept = []
    waiting = []
    showing.clear()
    parting = undefined
    const was = now
    now = undefined
    const waited = pending
    pending = undefined
    try { waited?.close() } catch (error) { report(error) }
    try { was?.transport.close() } catch (error) { report(error) }
    for (const ended of ends) try { ended(why) } catch (error) { report(error) }
  }
  /**
   * Lets go of what the other end says it took. A number past what was sent is not one it could have taken, and one
   * before what it said last asks for what is no longer kept.
   */
  const letGo = (taken: number): boolean => {
    if (taken > sent || taken < released) return false
    released = taken
    let first = 0
    while (first < kept.length && kept[first]!.seq <= taken) keptSize -= kept[first++]!.size
    if (first) kept = kept.slice(first)
    return true
  }

  /** Whether what is sent now can be numbered: there is a connection, and the other end is not too far behind. */
  const roomy = (): boolean => !!now?.live && kept.length < mark.frames && keptSize < mark.size && (now.transport.waiting?.() ?? 0) < mark.size
  /** Numbers one unit and puts it in this turn's batch. Joining what is encoded cannot fail, nor can encoding a number or a text. */
  const unit = (fields: Array<readonly [string, Message]>, about: About, first: boolean): number => {
    sent++
    if (first) {
      if (about.cause !== undefined) fields.push(['cause', codec.encode(about.cause)])
      if (about.private) fields.push(['private', codec.encode(true)])
    }
    const encoded = codec.record([['seq', codec.encode(sent)], ...fields])
    const size = sizeOf(encoded)
    kept.push({ seq: sent, encoded, size })
    keptSize += size
    say(now!, encoded, size)
    return size
  }
  /**
   * A frame's encoding as the data of its parts, in order, each no longer than a part as it crosses, and none but
   * the last more than a character or two shorter. A piece of the encoding may be longer as data than it was (text
   * in JSON has two around it, and each quote in it said in two), and by how much is the codec's to know. So a
   * piece is tried, and tried again shorter by as much as it was too long, or longer by as much as it had to
   * spare, between the longest found to fit and the shortest found not to, until what is to spare is next to
   * nothing or there is nothing between the two.
   */
  const partsOf = (encoded: Message): Message[] => {
    const all: Message[] = []
    let rest = encoded
    while (lengthOf(rest)) {
      let fits: { readonly want: number; readonly taken: number; readonly data: Message } | undefined
      let over = Infinity
      let want = part
      for (;;) {
        const taken = head(rest, want)
        const data = codec.encode(slice(rest, 0, taken))
        const size = sizeOf(data)
        if (size <= part) {
          fits = { want, taken, data }
          if (part - size < SPARE || taken === lengthOf(rest) || want + 1 >= over) break
          want = Math.min(over - 1, want + Math.max(1, Math.floor((part - size) * want / size)))
        } else {
          over = want
          // One character is taken however long it is as data: a part is long enough for any one.
          if (want <= 1) { fits = { want, taken, data }; break }
          if (fits && fits.want + 1 >= over) break
          want = Math.max(fits ? fits.want + 1 : 1, Math.min(want - 1, Math.floor(want * part / size)))
        }
      }
      all.push(fits.data)
      rest = slice(rest, fits.taken)
    }
    return all
  }
  /** Numbers a frame, in parts if it is longer than a part, each in turn. */
  const number = (encoded: Message, size: number, about: About): void => {
    const first = sent + 1
    let crossing = 0
    if (size <= part) crossing = unit([['frame', encoded]], about, true)
    else {
      const pieces = partsOf(encoded)
      pieces.forEach((data, at) => { crossing += unit([['part', codec.encode(at)], ['of', codec.encode(pieces.length)], ['data', data]], about, at === 0) })
    }
    tap(seen('out', first, crossing, about))
    watch(false)
  }

  /**
   * Watches a quiet connection while this end is owed something. `again` starts the window over, as anything
   * arriving does; without it, a watch already running goes on.
   */
  const watch = (again: boolean): void => {
    const there = options.there
    if (!there) return
    if (watching && !again) return
    watching?.()
    watching = undefined
    const on = now
    if (ending || !on?.met || (!kept.length && !owed)) return
    const half = there.window / 2
    watching = there.clock.after(half, () => {
      watching = undefined
      // Owed nothing now: nothing to ask.
      if (now !== on || ending || (!kept.length && !owed)) return
      asked++
      say(on, word({ there: asked }))
      watching = there.clock.after(there.window - half, () => {
        watching = undefined
        // Nothing of any kind arrived for the whole window: this connection is let go, and another is made.
        if (now === on && !ending) on.transport.close()
      })
    })
  }
  /** Numbers the oldest of what waits. */
  const next = (): void => {
    const one = waiting.shift()!
    waitingSize -= one.size
    if (one.view !== undefined && showing.get(one.view) === one) showing.delete(one.view)
    number(one.encoded, one.size, one.about)
  }
  /** Numbers what waits, oldest first, for as long as there is room. */
  const pump = (): void => { while (waiting.length && !ending && roomy()) next() }

  /** Why a first thing said on a connection does not fit this link as it stands. */
  type Unfit =
    | { readonly no: 'not a frame' }
    | { readonly no: 'version'; readonly theirs: number }
    | { readonly no: 'lost' }
    | { readonly no: 'too narrow'; readonly most: number }
  /**
   * What the first thing said on a connection is, to this link as it stands: a hello that fits, or why not. What
   * each end has is not what the other thinks when the hello is from another session than the one this link was
   * talking to; from an end going on with a session that is not this one; from an end that has met nobody and
   * says it took something; or from one that took what was never sent to it, or wants what it said before it had
   * taken. Otherwise what it has not taken is all still kept: numbering stops at the bound, so nothing is let go
   * before it is taken. An end that has met nobody has numbered nothing, so the two start afresh.
   */
  const greeting = (arrived: unknown): Hello | Unfit => {
    if (!isObject(arrived) || typeof arrived.link !== 'number') return { no: 'not a frame' }
    if (arrived.link !== LINK) return { no: 'version', theirs: arrived.link }
    if (!isHello(arrived)) return { no: 'not a frame' }
    const { session, taken, resumes, most } = arrived
    if (theirs !== undefined && session !== theirs) return { no: 'lost' }
    if (resumes !== undefined && resumes !== mine) return { no: 'lost' }
    if (resumes === undefined && taken !== 0) return { no: 'lost' }
    if (taken > sent || taken < released) return { no: 'lost' }
    if (most !== undefined && most < needed) return { no: 'too narrow', most }
    return arrived
  }
  /** This end's hello on a connection. */
  const helloOn = (transport: Transport): Message => word({
    link: LINK, session: mine, taken: heard,
    ...(theirs === undefined ? {} : { resumes: theirs }),
    ...(transport.most === undefined ? {} : { most: transport.most }),
  })
  /** Whether whoever said something that does not fit is told the session is lost: one that would otherwise wait on it. */
  const toldLost = (unfit: Unfit): boolean => unfit.no === 'lost' || unfit.no === 'too narrow'
  /**
   * Something that does not fit arrived on the connection this link is on. Before a hello that fits, on a link
   * that is handed its connections, the connection is turned away and the link goes on: whoever is there is not
   * who this link talks to. Otherwise the link ends, saying why.
   */
  const refuse = (on: Connection, unfit: Unfit): void => {
    if (toldLost(unfit)) put(on, word({ lost: true }))
    if (handed && !on.met) {
      flush(on)
      if (now !== on) return
      now = undefined
      try { on.transport.close() } catch { /* it has gone already */ }
      return
    }
    if (unfit.no === 'lost') { flush(on); end({ why: 'lost' }); return }
    if (unfit.no === 'too narrow') { flush(on); end({ why: 'too narrow', most: unfit.most, needs: needed }); return }
    if (unfit.no === 'version') { end({ why: 'version', mine: LINK, theirs: unfit.theirs }); return }
    unknown(on)
  }
  /** What arrived last on a connection, for saying how large something that was not a frame was. */
  let arriving: Message = ''
  const unknown = (on: Connection): void => {
    if (handed && !on.met) { refuse(on, { no: 'not a frame' }); return }
    end({ why: 'not a frame', size: sizeOf(arriving) })
  }

  const take = (on: Connection, arrived: unknown): void => {
    if (!on.met) {
      const hello = greeting(arrived)
      if ('no' in hello) { refuse(on, hello); return }
      letGo(hello.taken)
      theirs = hello.session
      on.takes = hello.most ?? Infinity
      on.met = true
      // It has held once it has stayed up from here for as long as the wait before it, and for the first wait at
      // least: one that goes sooner is one more that did not.
      if (pace && typeof over === 'function') holding = pace.clock.after(Math.max(wait(1), wait(failed)), () => { holding = undefined; on.held = true })
      if (!on.live) {
        on.live = true
        // Sent again as it was first, in as many messages as it takes.
        for (const one of kept) say(on, one.encoded, one.size)
      }
      return
    }
    if (!isObject(arrived)) { unknown(on); return }
    if (arrived.lost === true) { end({ why: 'lost' }); return }
    if (isCount(arrived.there)) { say(on, word({ here: arrived.there })); return }
    if (isCount(arrived.here)) return
    if (arrived.bye === 'ended') { end({ why: 'goodbye', bye: 'ended' }); return }
    if (arrived.bye === 'restarting') {
      // A link that comes back waits for the other end to: if it comes back a new session, that is lost.
      if (once) end({ why: 'goodbye', bye: 'restarting' })
      return
    }
    if (!('seq' in arrived) && 'taken' in arrived) {
      if (!isCount(arrived.taken) || !letGo(arrived.taken)) unknown(on)
      return
    }
    const { seq, cause } = arrived
    if (typeof seq !== 'number') { unknown(on); return }
    if ((cause !== undefined && typeof cause !== 'string') || (arrived.private !== undefined && arrived.private !== true)) { unknown(on); return }
    if ('frame' in arrived) {
      const frame = asFrame(arrived.frame)
      // Not a frame, or a whole frame where a frame in parts was arriving: its parts were not all sent.
      if (!frame || parting) { unknown(on); return }
      if (seq !== heard + 1) { end({ why: 'out of order', expected: heard + 1, got: seq }); return }
      heard = seq
      // This end says it took it with its next batch, and has one leave for that alone if none is to.
      if (!on.due) { on.due = true; later(() => flush(on)) }
      handOver(frame, seq, taps.length ? sizeOf(codec.encode(arrived)) : 0, cause, arrived.private === true)
      return
    }
    const { part: at, of, data } = arrived
    if (!isCount(at) || !isCount(of) || of < 2 || at >= of || !(typeof data === 'string' || data instanceof Uint8Array)) { unknown(on); return }
    if (seq !== heard + 1) { end({ why: 'out of order', expected: heard + 1, got: seq }); return }
    // The first part begins a frame, and each after it is the next of that frame's: nothing is taken between them.
    if (at === 0 ? parting !== undefined : parting?.of !== of || parting.pieces.length !== at) { unknown(on); return }
    if (at === 0) parting = { first: seq, of, pieces: [], bytes: 0, size: 0, ...(cause === undefined ? {} : { cause }), private: arrived.private === true }
    const whole = parting!
    // What a frame's parts add up to is a frame, and no longer than one may be: so what is kept while one arrives is
    // bounded, however many parts it is said to be in. A part holds something, so they are no more than that many.
    whole.bytes += sizeOf(data)
    if (sizeOf(data) === 0 || whole.bytes > largest) { unknown(on); return }
    whole.pieces.push(data)
    if (taps.length) whole.size += sizeOf(codec.encode(arrived))
    heard = seq
    // Said to be taken part by part, so that a resume picks up where it got to.
    if (!on.due) { on.due = true; later(() => flush(on)) }
    if (whole.pieces.length < of) return
    parting = undefined
    let frame: Frame | undefined
    try { frame = asFrame(codec.decode(joined(whole.pieces))) } catch { /* not a frame */ }
    if (!frame) { unknown(on); return }
    handOver(frame, whole.first, whole.size, whole.cause, whole.private)
  }
  /** Hands over a whole frame that arrived, numbered `first`, with what caused it. */
  function handOver(frame: Frame, first: number, size: number, cause: string | undefined, private_: boolean): void {
    if (taps.length) tap(seen('in', first, size, aboutOf(frame, { ...(cause === undefined ? {} : { cause }), private: private_ })))
    for (const hear of hears) try { hear(frame, cause) } catch (error) { report(error) }
  }

  /** Takes what arrived on the connection this link is on. */
  const hear = (on: Connection, message: Message): void => {
    if (now !== on || ending) return
    arriving = message
    let batch: unknown
    try { batch = codec.decode(message) } catch { unknown(on); return }
    if (!Array.isArray(batch) || !batch.length) { unknown(on); return }
    for (const one of batch as unknown[]) {
      // Something taken may end the link, or hand it another connection: then the rest is not this one's.
      if (ending || now !== on) return
      take(on, one)
    }
    // Anything arriving is when a link looks again at whether there is room to number what waits: a transport
    // that had not written all it was given says nothing when it has. And it starts a quiet connection's window
    // over.
    pump()
    watch(true)
  }
  /** Puts the link on a connection, in place of the one it has, and says hello on it. */
  const begin = (transport: Transport): Connection => {
    reopening?.()
    reopening = undefined
    holding?.()
    holding = undefined
    const was = now
    const on: Connection = { transport, met: false, live: once, held: false, told: heard, takes: Infinity, batch: [], sizes: [], due: false }
    now = on
    was?.transport.close()
    say(on, helloOn(transport))
    return on
  }
  const carry = (transport: Transport): void => {
    if (ending) { transport.close(); return }
    wideEnough(transport, needed)
    if (!now?.met) {
      const on = begin(transport)
      transport.onClose(() => dropped(on))
      transport.onData((message) => hear(on, message))
      return
    }
    // The other end has been met on the connection this link is on, so that one is kept until whoever is on this
    // one has said a hello that fits: nothing is said on it before, and nothing that arrives on the other is missed
    // for it. Only the last handed over waits.
    try { pending?.close() } catch (error) { report(error) }
    pending = transport
    let on: Connection | undefined
    transport.onClose(() => {
      if (on) dropped(on)
      else if (pending === transport) pending = undefined
    })
    transport.onData((message) => {
      if (on) { hear(on, message); return }
      if (ending || pending !== transport) return
      pending = undefined
      let first: unknown
      try { first = (codec.decode(message) as unknown[])[0] } catch { /* not a hello */ }
      const hello = greeting(first)
      if ('no' in hello) {
        // Turned away, and told so where it would otherwise wait: the link stays on the connection it has.
        try {
          if (toldLost(hello)) transport.send(codec.list([helloOn(transport), word({ lost: true })]))
          transport.close()
        } catch { /* it has gone already */ }
        return
      }
      on = begin(transport)
      hear(on, message)
    })
  }

  /**
   * A frame encoded, and how many bytes that is. Throws for one that cannot be sent: one that cannot be encoded, or
   * one larger, with its cause, than a frame may be. Nothing thrown says what the frame holds.
   */
  const ready = (frame: Frame, how: Sending): Ready => {
    const encoded = encodeFrame(codec, frame)
    const size = sizeOf(encoded)
    const whole = size + (how.cause === undefined ? 0 : sizeOf(codec.encode(how.cause)))
    if (whole - size > CAUSE) throw new RangeError('What caused a frame is longer than may be said')
    if (whole > largest) throw new RangeError('A frame is larger than may be sent')
    return { encoded, size, about: aboutOf(frame, how), ...(frame.kind === 'shown' ? { view: frame.id } : {}) }
  }

  const made: Link = {
    prepare: (frame, how = {}) => {
      const token: Prepared = { prepared: frame.kind }
      prepared.set(token, ready(frame, how))
      return token
    },
    send: (what, how = {}) => {
      // Put into text and measured before it is numbered, here or where it was prepared: a frame that cannot be
      // sent is refused alone, and leaves no gap behind it.
      let one: Ready
      if ('prepared' in what) {
        const was = prepared.get(what)
        if (!was) throw new TypeError('What was prepared is sent once, by the link that prepared it')
        prepared.delete(what)
        one = was
      } else one = ready(what, how)
      if (ending) return
      const { encoded, size, about, view } = one
      if (!waiting.length && roomy()) { number(encoded, size, about); return }
      // A view's result waiting to be numbered is overtaken by a later one, which takes its place in the order.
      const overtaken = view === undefined ? undefined : showing.get(view)
      if (overtaken) {
        waitingSize += size - overtaken.size
        overtaken.encoded = encoded
        overtaken.size = size
        overtaken.about = about
      } else {
        waiting.push(one)
        waitingSize += size
        if (view !== undefined) showing.set(view, one)
      }
      if (waiting.length > bound.frames || waitingSize > bound.size) {
        end({ why: 'overrun', waiting: { frames: waiting.length, size: waitingSize }, bound: { frames: bound.frames, size: bound.size } })
      }
    },
    onFrame: (hear) => { hears.push(hear) },
    onTraffic: (seen_) => { taps.push(seen_) },
    onEnd: (ended) => { if (ending) ended(ending); else ends.push(ended) },
    close: (bye) => {
      if (ending) return
      // What was said before closing leaves before it closes, what waited for room with it, and a goodbye last. It
      // is the last this end sends, so the mark that room is counted against no longer holds anything back.
      const on = now
      if (on) {
        // An end that has met nobody has numbered nothing: what it numbers now arrives once or not at all, since
        // it sends nothing again.
        if (on.live || theirs === undefined) while (waiting.length) next()
        if (bye) put(on, word({ bye }))
        flush(on)
      }
      end({ why: 'closed' })
    },
    carry,
    kept: () => kept.length,
    awaiting: () => {
      owed++
      watch(false)
      let settled = false
      return () => {
        if (settled) return
        settled = true
        owed--
      }
    },
    waiting: () => waiting.length,
  }
  if (typeof over === 'object') carry(over)
  else if (typeof over === 'function') carry(over())
  return made
}

/**
 * Takes connections as they arrive at a backend, and finds each its link: a new session is a new link, handed to
 * `onLink`, and a known one is handed back to the link it was. A connection that says it is going on with a session,
 * from one this end does not know, is told the session is lost, and closed.
 *
 * A session's id is all a connection needs to say to be handed that session's link: who may connect at all is for
 * whatever takes the connections to have settled before one is handed here.
 *
 * A link is kept, with what it holds for its window, until it ends. Nothing here ends one for a window that has
 * stopped coming back, since nothing a link sees tells that from one that is slow to: whoever takes the links
 * closes each when it knows its window is gone for good.
 */
export function accept(onLink: (link: Link) => void, options: Options = {}): (transport: Transport) => void {
  const codec = options.codec ?? json
  const links = new Map<string, Link>()
  const largest = options.bound?.frame ?? FRAME
  return (transport) => {
    // Found when the connection arrives, not when a frame is too long for it.
    wideEnough(transport, needs(largest, options.part ?? PART))
    const hears: Array<(message: Message) => void> = []
    const closes: Array<() => void> = []
    let first = true
    let closed = false
    // What a link is handed: the connection, with what arrived first handed over again.
    const relay: Transport = {
      send: (message) => transport.send(message),
      onData: (heard) => { hears.push(heard) },
      onClose: (then) => { if (closed) then(); else closes.push(then) },
      close: () => transport.close(),
      ...(transport.waiting ? { waiting: () => transport.waiting!() } : {}),
      ...(transport.most === undefined ? {} : { most: transport.most }),
    }
    /**
     * Closes a connection no link is made or found for. An end that would otherwise wait is told first: with this
     * link's number, and with that the session is lost where it is.
     */
    const turnAway = (saying: 'nothing' | 'which link' | 'lost'): void => {
      try {
        if (saying !== 'nothing') transport.send(codec.list([codec.encode({ link: LINK, session: crypto.randomUUID(), taken: 0 } satisfies Hello), ...(saying === 'lost' ? [codec.encode({ lost: true } satisfies Lost)] : [])]))
        transport.close()
      } catch { /* it has gone already, which says as much */ }
    }
    transport.onClose(() => { closed = true; for (const then of closes.splice(0)) then() })
    transport.onData((message) => {
      if (!first) { for (const heard of hears) heard(message); return }
      first = false
      let said: unknown
      try { said = (codec.decode(message) as unknown[])[0] } catch { /* not a link's */ }
      if (!isHello(said)) {
        // Another link's number is answered with this one's, so that the end that opened it ends saying both.
        // Anything else is not a link's, and nothing is said to it.
        turnAway(isObject(said) && typeof said.link === 'number' && said.link !== LINK ? 'which link' : 'nothing')
        return
      }
      const known = links.get(said.session)
      if (known) known.carry(relay)
      // Going on with a session from before this end began, or one that says it took what nobody here sent: a
      // new session says so, and the other end finds it lost.
      else if (said.resumes !== undefined || said.taken !== 0) { turnAway('lost'); return }
      else {
        const session = said.session
        const made = link(undefined, options)
        links.set(session, made)
        made.onEnd(() => { links.delete(session) })
        onLink(made)
        made.carry(relay)
      }
      for (const heard of hears) heard(message)
    })
  }
}
