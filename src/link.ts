// One end of a link: frames out, frames in, each in the order it was sent, once, across connections that drop and
// come back.
//
// Every frame an end sends is numbered, one more than the last. The other end takes a frame only if it is the next
// one, so a frame lost, doubled or out of place is found where it arrives and the link is closed, saying why: a
// link that went on would be handing over frames in an order nobody sent them in.
//
// Beside frames, a link says a few things about itself, none of them numbered: a hello first on each connection,
// saying which session this end is and the last number it has taken; with a batch, the last number taken; a
// goodbye when it goes on purpose; and that a session cannot be resumed. Only a frame is numbered, and kept.
//
// What an end says within one turn crosses as one text: a batch, `[...said]`. A frame is put into text when it is
// sent, so one that cannot be is refused there alone, and the batch is those texts joined. The batch leaves when
// `later` says, a microtask unless given.
//
// A link outlives what carries it. Each end keeps what it has sent until the other says it took it. A new
// connection's hellos say where each end got to and which session each believes it is going on with, each sends
// again what the other has not taken, in order, and goes on; since a frame is taken only in turn, nothing is taken
// twice. A link that can come back numbers nothing until it has met the other end, so an end that has met nobody
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
// What carries a link may take no message longer than it says (`most`). A batch that would be longer crosses as
// more than one, cut between frames, in order.
//
// What carries a link saying it closed is the first word that the other end has gone. For a connection that can go
// quiet without closing, a link given a window and a clock watches while it is owed something, a `taken` or an
// answer: quiet for half the window, it asks whether the other end is there; quiet for the whole of it, with nothing
// of any kind arriving, it closes the connection, to be opened again. Nothing is given a time to answer in.
//
// What a listener throws is never the link's. Every listener is still called and every frame of a batch still
// taken, and what was thrown is handed to `thrown`, or thrown again in a turn of its own.
import { asFrame, bytesOf, toText, type Frame } from './frames.ts'
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
   * Something this end had taken on to send is longer than what the link is now carried on takes in one message:
   * how many bytes it is, and the most that takes. A frame sent while carried on that is refused where it is sent.
   */
  | { readonly why: 'too large'; readonly size: number; readonly most: number }

/** How much: a count of frames, and how many bytes their text is as UTF-8. */
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
    readonly seq: number
    readonly kind: Frame['kind']
    readonly id?: number
    readonly name?: string
    /** How many bytes its text is, as it crosses. */
    readonly size: number
    readonly cause?: string
  }
  | { readonly direction: 'out' | 'in'; readonly seq: number; readonly private: true; readonly size: number }

export interface Link {
  /**
   * Sends a frame. Throws if the frame cannot be sent, having sent nothing and taken no number: that one frame is
   * refused, and the link goes on. A `TypeError` for one that cannot be put into text, and a `RangeError` for one
   * larger, with its cause, than `bound.frame` or than what the link is carried on takes. While there is no
   * connection it waits, and leaves on the next. After the link has closed it sends nothing.
   */
  send(frame: Frame, how?: Sending): void
  /**
   * Throws what `send` would throw for this frame now, and sends nothing: for what is to be sent later, to be
   * refused where it was said.
   */
  check(frame: Frame, how?: Sending): void
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
  /** Hands the link a connection to be carried on, in place of the one it has. */
  carry(transport: Transport): void
  /** How many frames this end keeps because the other has not said it took them. */
  kept(): number
  /** How many frames wait to be numbered, because the other end is behind or there is no connection. */
  waiting(): number
  /**
   * Says this end is owed something by the other, an answer, so that a quiet connection is watched while it is.
   * Call what it returns when it has come, or is no longer wanted.
   */
  awaiting(): () => void
}

/** What an end says of itself. None takes a number. */
/** `resumes` is the other end's session, from an end that has met it: absent, this end has met nobody. */
type Hello = { readonly link: number; readonly session: string; readonly taken: number; readonly resumes?: string }
type Taken = { readonly taken: number }
type Goodbye = { readonly bye: Bye }
type Lost = { readonly lost: true }
/** Whether the other end is there, and that it is. */
type There = { readonly there: number }
type Here = { readonly here: number }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

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
/** More than everything a link puts around a frame and its cause where it numbers it: a number, and the names. */
const AROUND = 64

/** How long a link waits to open a connection after the first that did not hold, and the most it waits. */
const REOPEN_FIRST = 100
const REOPEN_MOST = 10_000

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

const decoder = new TextDecoder()
const textOf = (message: Message): string => (typeof message === 'string' ? message : decoder.decode(message))
const sizeOf = (message: Message): number => (typeof message === 'string' ? bytesOf(message) : message.byteLength)

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
  const mine = crypto.randomUUID()
  /** The other end's session, once it has said it. A connection from another is not this link's. */
  let theirs: string | undefined
  let sent = 0
  let heard = 0
  /** The last number this end has said it took. */
  let told = 0
  /** The last number the other end said it took: what was sent up to it is no longer kept. */
  let released = 0
  /** What was sent and not yet taken, as it is on the wire, oldest first, and the size of all of it. */
  let kept: Array<{ readonly seq: number; readonly text: string; readonly size: number }> = []
  let keptSize = 0
  const mark = { ...KEPT, ...options.bound?.kept }
  const bound = { ...WAITING, ...options.bound?.waiting }
  const largest = options.bound?.frame ?? FRAME
  // Less would refuse what a peer says in place of something that could not be sent, and leave an ask unanswered.
  if (largest < SMALLEST) throw new RangeError(`bound.frame is ${SMALLEST} bytes at least`)
  /** What was sent and waits to be numbered, as each frame's own text, oldest first, and the size of all of it. */
  let waiting: Array<{ text: string; size: number; about: About; readonly view?: number }> = []
  let waitingSize = 0
  /** For each view with a result waiting, that result: a later one takes its place. */
  const showing = new Map<number, (typeof waiting)[number]>()
  let ending: Ending | undefined
  const hears: Array<(frame: Frame, cause?: string) => void> = []
  const taps: Array<(traffic: Traffic) => void> = []
  /** Tells each tap. A tap that throws is not this link's to report, and does not stop it. */
  const tap = (traffic: Traffic): void => { for (const seen of taps) try { seen(traffic) } catch { /* the tap's */ } }
  const ends: Array<(ending: Ending) => void> = []
  /** Hands on what a listener threw: to `thrown`, or to a turn of its own, where nothing of the link's is under it. */
  const report = (error: unknown): void => {
    let thrown = error
    if (options.thrown) try { options.thrown(error); return } catch (again) { thrown = again }
    queueMicrotask(() => { throw thrown })
  }
  /** Whether this link is carried on one connection alone, and ends with it. */
  const once = typeof over === 'object'
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

  /** The connection a link is on now, with what is said on it this turn. */
  interface Connection {
    readonly transport: Transport
    /** Whether the other end has said hello on it. Nothing else is taken before it. */
    met: boolean
    /** Whether what is sent goes out on it now: at once on the one connection of a link that does not come back, and on any other once the other end has said hello. */
    live: boolean
    /** Whether it has held: stayed up, once the other end was met, for as long as the wait before it. */
    held: boolean
    /** What is said on it this turn, and how many bytes each is. */
    batch: string[]
    sizes: number[]
    due: boolean
  }
  let now: Connection | undefined

  /** Opens the next connection of a link given what opens one, when the clock says. */
  const reopen = (): void => {
    const open = over as () => Transport
    let off = false
    const stop = pace!.clock.after(wait(failed), () => {
      if (off) return
      reopening = undefined
      if (ending || now) return
      let transport: Transport
      // What cannot be opened is a connection that did not hold.
      try { transport = open() } catch (error) { failed++; reopen(); report(error); return }
      carry(transport)
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
  /** Puts something in what is said on a connection this turn. What a link says of itself is a byte a character. */
  const put = (on: Connection, text: string, size = text.length): void => { on.batch.push(text); on.sizes.push(size) }

  const flush = (on: Connection): void => {
    on.due = false
    if (ending || now !== on) return
    if (!on.batch.length && !(on.met && heard > told)) return
    // What this end has taken goes with it, when there is more to say of it: last, behind a hello if there is one.
    if (on.met && heard > told) { put(on, JSON.stringify({ taken: heard } satisfies Taken)); told = heard }
    const { batch, sizes } = on
    on.batch = []
    on.sizes = []
    // One text, unless what carries it takes no message that long: then as few as it takes, cut between what was
    // said, in order. A text of `n` things is their bytes, a comma between each two, and two more around them.
    const most = on.transport.most ?? Infinity
    const texts: string[] = []
    let from = 0
    let bytes = 2
    for (let at = 0; at < batch.length; at++) {
      const size = sizes[at]!
      if (size + 2 > most) { end({ why: 'too large', size, most }); return }
      if (at > from && bytes + 1 + size > most) {
        texts.push(`[${batch.slice(from, at).join(',')}]`)
        from = at
        bytes = 2
      }
      bytes += size + (at > from ? 1 : 0)
    }
    texts.push(`[${(from ? batch.slice(from) : batch).join(',')}]`)
    // A transport that cannot send is a connection that has gone. Every frame in the batch is kept, and is sent
    // again on the next. None of those here throws, so what one threw is handed on as well.
    try { for (const text of texts) on.transport.send(text) } catch (error) {
      dropped(on)
      try { on.transport.close() } catch { /* it has gone already */ }
      report(error)
    }
  }
  const say = (on: Connection, text: string, size?: number): void => {
    put(on, text, size)
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
    const was = now
    now = undefined
    try { was?.transport.close() } catch (error) { report(error) }
    for (const ended of ends) try { ended(why) } catch (error) { report(error) }
  }
  /** Says the session cannot go on, and ends. */
  const lose = (on: Connection): void => {
    put(on, JSON.stringify({ lost: true } satisfies Lost))
    flush(on)
    end({ why: 'lost' })
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
  /** Numbers a frame and puts it in this turn's batch. Joining text cannot fail, nor can putting a text into text. */
  const number = (frameText: string, frameSize: number, about: About): void => {
    sent++
    const cause = about.cause === undefined ? '' : JSON.stringify(about.cause)
    const text = `{"seq":${sent},"frame":${frameText}${cause && `,"cause":${cause}`}${about.private ? ',"private":true' : ''}}`
    // Around the frame and its cause, everything is a byte a character.
    const size = frameSize + (text.length - frameText.length - cause.length) + bytesOf(cause)
    kept.push({ seq: sent, text, size })
    keptSize += size
    say(now!, text, size)
    tap(seen('out', sent, size, about))
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
      say(on, JSON.stringify({ there: asked } satisfies There))
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
    number(one.text, one.size, one.about)
  }
  /** Numbers what waits, oldest first, for as long as there is room. */
  const pump = (): void => { while (waiting.length && !ending && roomy()) next() }

  const take = (on: Connection, arrived: unknown, unknown: () => void): void => {
    if (!isObject(arrived)) { unknown(); return }
    if (!on.met) {
      if (typeof arrived.link !== 'number') { unknown(); return }
      if (arrived.link !== LINK) { end({ why: 'version', mine: LINK, theirs: arrived.link }); return }
      const { session, taken, resumes } = arrived
      if (typeof session !== 'string' || !isCount(taken) || (resumes !== undefined && typeof resumes !== 'string')) { unknown(); return }
      // What each end has is not what the other thinks: another session than the one this link was talking to; an
      // end going on with a session that is not this one; an end that has met nobody and says it took something;
      // or one that took what was never sent to it, or wants what it said before it had taken. Otherwise what it
      // has not taken is all still kept: numbering stops at the bound, so nothing is let go before it is taken.
      // An end that has met nobody has numbered nothing, so the two start afresh with nothing to send again.
      if (theirs !== undefined && session !== theirs) { lose(on); return }
      if (resumes !== undefined && resumes !== mine) { lose(on); return }
      if (resumes === undefined && taken !== 0) { lose(on); return }
      if (!letGo(taken)) { lose(on); return }
      theirs = session
      on.met = true
      // It has held once it has stayed up from here for as long as the wait before it, and for the first wait at
      // least: one that goes sooner is one more that did not.
      if (pace && typeof over === 'function') holding = pace.clock.after(Math.max(wait(1), wait(failed)), () => { holding = undefined; on.held = true })
      if (!on.live) {
        on.live = true
        for (const one of kept) put(on, one.text, one.size)
        if (on.batch.length && !on.due) { on.due = true; later(() => flush(on)) }
      }
      return
    }
    if (arrived.lost === true) { end({ why: 'lost' }); return }
    if (isCount(arrived.there)) { say(on, JSON.stringify({ here: arrived.there } satisfies Here)); return }
    if (isCount(arrived.here)) return
    if (arrived.bye === 'ended') { end({ why: 'goodbye', bye: 'ended' }); return }
    if (arrived.bye === 'restarting') {
      // A link that comes back waits for the other end to: if it comes back a new session, that is lost.
      if (once) end({ why: 'goodbye', bye: 'restarting' })
      return
    }
    if (!('seq' in arrived) && 'taken' in arrived) {
      if (!isCount(arrived.taken) || !letGo(arrived.taken)) unknown()
      return
    }
    const { seq, cause } = arrived
    const frame = asFrame(arrived.frame)
    if (typeof seq !== 'number' || !frame) { unknown(); return }
    if ((cause !== undefined && typeof cause !== 'string') || (arrived.private !== undefined && arrived.private !== true)) { unknown(); return }
    if (seq !== heard + 1) { end({ why: 'out of order', expected: heard + 1, got: seq }); return }
    heard = seq
    // This end says it took it with its next batch, and has one leave for that alone if none is to.
    if (!on.due) { on.due = true; later(() => flush(on)) }
    if (taps.length) tap(seen('in', seq, bytesOf(JSON.stringify(arrived)), aboutOf(frame, { ...(cause === undefined ? {} : { cause }), private: arrived.private === true })))
    for (const hear of hears) try { hear(frame, cause) } catch (error) { report(error) }
  }

  const carry = (transport: Transport): void => {
    if (ending) { transport.close(); return }
    reopening?.()
    reopening = undefined
    holding?.()
    holding = undefined
    const was = now
    const on: Connection = { transport, met: false, live: once, held: false, batch: [], sizes: [], due: false }
    now = on
    was?.transport.close()
    transport.onClose(() => dropped(on))
    transport.onData((message) => {
      if (now !== on || ending) return
      const unknown = (): void => end({ why: 'not a frame', size: sizeOf(message) })
      let batch: unknown
      try { batch = JSON.parse(textOf(message)) } catch { unknown(); return }
      if (!Array.isArray(batch) || !batch.length) { unknown(); return }
      for (const one of batch as unknown[]) {
        // Something taken may end the link, or hand it another connection: then the rest is not this one's.
        if (ending || now !== on) return
        take(on, one, unknown)
      }
      // Anything arriving is when a link looks again at whether there is room to number what waits: a transport
      // that had not written all it was given says nothing when it has. And it starts a quiet connection's window
      // over.
      pump()
      watch(true)
    })
    say(on, JSON.stringify({ link: LINK, session: mine, taken: heard, ...(theirs === undefined ? {} : { resumes: theirs }) } satisfies Hello))
    told = heard
  }

  /**
   * A frame as text, and how many bytes that is. Throws for one that cannot be sent: one that cannot be put into
   * text, or one larger, with its cause, than a frame may be or than what the link is carried on now takes in a
   * message. Nothing thrown says what the frame holds.
   */
  const sendable = (frame: Frame, how: Sending): { readonly text: string; readonly size: number } => {
    const text = toText(frame)
    const size = bytesOf(text)
    const whole = size + (how.cause === undefined ? 0 : bytesOf(JSON.stringify(how.cause)))
    if (whole > largest || whole + AROUND > (now?.transport.most ?? Infinity)) throw new RangeError('A frame is larger than may be sent')
    return { text, size }
  }

  const made: Link = {
    check: (frame, how = {}) => { if (!ending) sendable(frame, how) },
    send: (frame, how = {}) => {
      if (ending) return
      // Put into text and measured before it is numbered: a frame that cannot be sent is refused alone, and leaves
      // no gap behind it.
      const { text, size } = sendable(frame, how)
      const about = aboutOf(frame, how)
      if (!waiting.length && roomy()) { number(text, size, about); return }
      // A view's result waiting to be numbered is overtaken by a later one, which takes its place in the order.
      const view = frame.kind === 'shown' ? frame.id : undefined
      const overtaken = view === undefined ? undefined : showing.get(view)
      if (overtaken) {
        waitingSize += size - overtaken.size
        overtaken.text = text
        overtaken.size = size
        overtaken.about = about
      } else {
        const one = { text, size, about, ...(view === undefined ? {} : { view }) }
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
        if (bye) put(on, JSON.stringify({ bye } satisfies Goodbye))
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
  const links = new Map<string, Link>()
  return (transport) => {
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
    transport.onClose(() => { closed = true; for (const then of closes.splice(0)) then() })
    transport.onData((message) => {
      if (!first) { for (const heard of hears) heard(message); return }
      first = false
      let said: unknown
      try { said = (JSON.parse(textOf(message)) as unknown[])[0] } catch { /* not a link's: a new link says so */ }
      const hello = isObject(said) && said.link === LINK && typeof said.session === 'string' && isCount(said.taken) && (said.resumes === undefined || typeof said.resumes === 'string') ? said as Hello : undefined
      const known = hello && links.get(hello.session)
      if (known) known.carry(relay)
      else if (hello?.resumes !== undefined) {
        // Going on with a session from before this end began: a new session says so, and the other end finds it
        // lost. A connection that cannot be told has gone, which says as much.
        try {
          transport.send(JSON.stringify([{ link: LINK, session: crypto.randomUUID(), taken: 0 } satisfies Hello, { lost: true } satisfies Lost]))
          transport.close()
        } catch { /* gone */ }
        return
      } else {
        const made = link(undefined, options)
        if (hello) {
          links.set(hello.session, made)
          made.onEnd(() => { links.delete(hello.session) })
        }
        onLink(made)
        made.carry(relay)
      }
      for (const heard of hears) heard(message)
    })
  }
}
