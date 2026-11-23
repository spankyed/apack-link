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
// connection's hellos say where each end got to, each sends again what the other has not taken, in order, and goes
// on; since a frame is taken only in turn, nothing is taken twice. A link given what opens a connection opens
// another when one closes; a link made with nothing is handed each connection (`carry`), as a backend's are by
// `accept`. Neither is given a time to wait: whoever holds a link says when the other end is gone, with `close`.
//
// What is kept is bounded. How far behind the other end is, is what it has not said it took: past a mark, a link
// stops numbering, and what is sent waits unnumbered, where a view's result that a later one has overtaken can be
// let go. What waits is bounded too, and past it, with nothing left to let go, the link ends `overrun`.
import type { Frame } from './frames.ts'
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
  /** What arrived was not something a link says. `size` is the length of its text, which is all that is kept of it. */
  | { readonly why: 'not a frame'; readonly size: number }
  /** What waits to be sent passed its bound, with nothing left that could be let go: how much waits, and the bound. */
  | { readonly why: 'overrun'; readonly waiting: Size; readonly bound: Size }

/** How much: a count of frames, and the length of their text. */
export interface Size { readonly frames: number; readonly size: number }

export interface Link {
  /**
   * Sends a frame. Throws if the frame cannot be put into text, having sent nothing and taken no number: that one
   * frame is refused, and the link goes on. While there is no connection it waits, and leaves on the next. After
   * the link has closed it sends nothing.
   */
  send(frame: Frame): void
  /** Called with each frame the other end sent, in the order it sent them, once each. */
  onFrame(heard: (frame: Frame) => void): void
  /** Called once, when the link has closed, with why. */
  onEnd(ended: (ending: Ending) => void): void
  /**
   * Closes the link, once what was sent before has left. Given a goodbye, says it last, so the other end's ending
   * says which it was. This is also how whoever holds a link says the other end is gone for good: what was kept for
   * it is let go.
   */
  close(bye?: Bye): void
  /** Hands the link a connection to be carried on, in place of the one it has. */
  carry(transport: Transport): void
  /** How many frames this end keeps because the other has not said it took them. */
  kept(): number
  /** How many frames wait to be numbered, because the other end is behind or there is no connection. */
  waiting(): number
}

/** What an end says of itself. None takes a number. */
/** `again` is said on every connection after an end's first: it is going on with something, not starting. */
type Hello = { readonly link: number; readonly session: string; readonly taken: number; readonly again?: true }
type Taken = { readonly taken: number }
type Goodbye = { readonly bye: Bye }
type Lost = { readonly lost: true }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export interface Options {
  /** What puts the batch off until the end of the turn. A microtask unless given; a spec gives a schedule's lane. */
  later?(run: () => void): void
  /**
   * `kept`: how much sent and not yet taken there may be before a link stops numbering what is sent, counted as
   * well against what the transport says it has not yet written. `waiting`: how much may wait to be numbered
   * before the link ends `overrun`.
   */
  bound?: { readonly kept?: Size; readonly waiting?: Size }
}

/** A link a little behind sends at once; one far behind lets a view's results be overtaken; one past it ends. */
const KEPT: Size = { frames: 1024, size: 16 * 1024 * 1024 }
const WAITING: Size = { frames: 16384, size: 64 * 1024 * 1024 }

const decoder = new TextDecoder()
const textOf = (message: Message): string => (typeof message === 'string' ? message : decoder.decode(message))

/**
 * Makes one end of a link. Given a transport, the link is carried on it alone and ends when it closes. Given what
 * opens a transport, it opens one now and another each time one closes. Given nothing, it waits to be handed each
 * connection with `carry`.
 */
export function link(over?: Transport | (() => Transport), options: Options = {}): Link {
  const later = options.later ?? queueMicrotask
  const mine = crypto.randomUUID()
  /** The other end's session, once it has said it. A connection from another is not this link's. */
  let theirs: string | undefined
  let sent = 0
  let heard = 0
  /** The last number this end has said it took. */
  let told = 0
  /** What was sent and not yet taken, as it is on the wire, oldest first, and the length of all of it. */
  let kept: Array<{ readonly seq: number; readonly text: string }> = []
  let keptSize = 0
  const mark = { ...KEPT, ...options.bound?.kept }
  const bound = { ...WAITING, ...options.bound?.waiting }
  /** What was sent and waits to be numbered, as each frame's own text, oldest first, and the length of all of it. */
  let waiting: Array<{ text: string; readonly view?: number }> = []
  let waitingSize = 0
  /** For each view with a result waiting, that result: a later one takes its place. */
  const showing = new Map<number, (typeof waiting)[number]>()
  let ending: Ending | undefined
  const hears: Array<(frame: Frame) => void> = []
  const ends: Array<(ending: Ending) => void> = []
  const once = typeof over === 'object'

  /** The connection a link is on now, with what is said on it this turn. */
  interface Connection {
    readonly transport: Transport
    /** Whether it is the first this end has had. */
    readonly first: boolean
    /** Whether the other end has said hello on it. Nothing else is taken before it. */
    met: boolean
    /** Whether what is sent goes out on it now: on the first connection at once, on another once hellos have crossed. */
    live: boolean
    batch: string[]
    due: boolean
  }
  let now: Connection | undefined
  /** Whether a connection was ever made. */
  let opened = false

  const flush = (on: Connection): void => {
    on.due = false
    if (ending || now !== on) return
    if (!on.batch.length && !(on.met && heard > told)) return
    // What this end has taken goes with it, when there is more to say of it: last, behind a hello if there is one.
    if (on.met && heard > told) { on.batch.push(JSON.stringify({ taken: heard } satisfies Taken)); told = heard }
    const text = `[${on.batch.join(',')}]`
    on.batch = []
    on.transport.send(text)
  }
  const say = (on: Connection, text: string): void => {
    on.batch.push(text)
    if (on.due) return
    on.due = true
    later(() => flush(on))
  }

  const end = (why: Ending): void => {
    if (ending) return
    ending = why
    kept = []
    waiting = []
    showing.clear()
    const was = now
    now = undefined
    was?.transport.close()
    for (const ended of ends) ended(why)
  }
  /** Says the session cannot go on, and ends. */
  const lose = (on: Connection): void => {
    on.batch.push(JSON.stringify({ lost: true } satisfies Lost))
    flush(on)
    end({ why: 'lost' })
  }

  /** Lets go of what the other end says it took. A number past what was sent is not one it could have taken. */
  const letGo = (taken: number): boolean => {
    if (taken > sent) return false
    let first = 0
    while (first < kept.length && kept[first]!.seq <= taken) keptSize -= kept[first++]!.text.length
    if (first) kept = kept.slice(first)
    return true
  }

  /** Whether what is sent now can be numbered: there is a connection, and the other end is not too far behind. */
  const roomy = (): boolean => !!now?.live && kept.length < mark.frames && keptSize < mark.size && (now.transport.waiting?.() ?? 0) < mark.size
  /** Numbers a frame and puts it in this turn's batch. Joining text cannot fail. */
  const number = (frameText: string): void => {
    sent++
    const text = `{"seq":${sent},"frame":${frameText}}`
    kept.push({ seq: sent, text })
    keptSize += text.length
    say(now!, text)
  }
  /** Numbers what waits, oldest first, for as long as there is room. */
  const pump = (): void => {
    while (waiting.length && !ending && roomy()) {
      const one = waiting.shift()!
      waitingSize -= one.text.length
      if (one.view !== undefined && showing.get(one.view) === one) showing.delete(one.view)
      number(one.text)
    }
  }

  const take = (on: Connection, arrived: unknown, unknown: () => void): void => {
    if (!isObject(arrived)) { unknown(); return }
    if (!on.met) {
      if (typeof arrived.link !== 'number') { unknown(); return }
      if (arrived.link !== LINK) { end({ why: 'version', mine: LINK, theirs: arrived.link }); return }
      const { session, taken, again } = arrived
      if (typeof session !== 'string' || !isCount(taken) || (again !== undefined && again !== true)) { unknown(); return }
      // Another session than the one this link was talking to, one going on with something when this end is new, or
      // one that took what was never sent to it: what each end has is not what the other thinks. What it has not
      // taken is all still kept: numbering stops at the bound, so nothing is let go before it is taken.
      if (theirs !== undefined && session !== theirs) { lose(on); return }
      if (again && on.first) { lose(on); return }
      if (!letGo(taken)) { lose(on); return }
      theirs = session
      on.met = true
      if (!on.live) {
        on.live = true
        for (const one of kept) on.batch.push(one.text)
        if (on.batch.length && !on.due) { on.due = true; later(() => flush(on)) }
      }
      return
    }
    if (arrived.lost === true) { end({ why: 'lost' }); return }
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
    const { seq, frame } = arrived
    if (typeof seq !== 'number' || !isObject(frame) || typeof frame.kind !== 'string') { unknown(); return }
    if (seq !== heard + 1) { end({ why: 'out of order', expected: heard + 1, got: seq }); return }
    heard = seq
    // This end says it took it with its next batch, and has one leave for that alone if none is to.
    if (!on.due) { on.due = true; later(() => flush(on)) }
    for (const hear of hears) hear(frame as Frame)
  }

  const carry = (transport: Transport): void => {
    if (ending) { transport.close(); return }
    const was = now
    const on: Connection = { transport, first: !opened, met: false, live: !opened, batch: [], due: false }
    opened = true
    now = on
    was?.transport.close()
    transport.onClose(() => {
      if (now !== on) return
      now = undefined
      if (ending) return
      if (once) { end({ why: 'closed' }); return }
      if (typeof over === 'function') carry(over())
    })
    transport.onData((message) => {
      if (now !== on || ending) return
      const text = textOf(message)
      const unknown = (): void => end({ why: 'not a frame', size: text.length })
      let batch: unknown
      try { batch = JSON.parse(text) } catch { unknown(); return }
      if (!Array.isArray(batch) || !batch.length) { unknown(); return }
      for (const one of batch as unknown[]) {
        // Something taken may end the link, or hand it another connection: then the rest is not this one's.
        if (ending || now !== on) return
        take(on, one, unknown)
      }
      // Anything arriving is when a link looks again at whether there is room to number what waits: a transport
      // that had not written all it was given says nothing when it has.
      pump()
    })
    say(on, JSON.stringify({ link: LINK, session: mine, taken: heard, ...(on.first ? {} : { again: true }) } satisfies Hello))
    told = heard
  }

  const made: Link = {
    send: (frame) => {
      if (ending) return
      // Put into text before it is numbered: a frame that cannot be is refused alone, and leaves no gap behind it.
      const text = JSON.stringify(frame)
      if (!waiting.length && roomy()) { number(text); return }
      // A view's result waiting to be numbered is overtaken by a later one, which takes its place in the order.
      const view = frame.kind === 'shown' ? frame.id : undefined
      const overtaken = view === undefined ? undefined : showing.get(view)
      if (overtaken) {
        waitingSize += text.length - overtaken.text.length
        overtaken.text = text
      } else {
        const one = { text, ...(view === undefined ? {} : { view }) }
        waiting.push(one)
        waitingSize += text.length
        if (view !== undefined) showing.set(view, one)
      }
      if (waiting.length > bound.frames || waitingSize > bound.size) {
        end({ why: 'overrun', waiting: { frames: waiting.length, size: waitingSize }, bound: { frames: bound.frames, size: bound.size } })
      }
    },
    onFrame: (hear) => { hears.push(hear) },
    onEnd: (ended) => { if (ending) ended(ending); else ends.push(ended) },
    close: (bye) => {
      if (ending) return
      // What was said before closing leaves before it closes, and a goodbye last.
      if (now) {
        if (bye) now.batch.push(JSON.stringify({ bye } satisfies Goodbye))
        flush(now)
      }
      end({ why: 'closed' })
    },
    carry,
    kept: () => kept.length,
    waiting: () => waiting.length,
  }
  if (typeof over === 'object') carry(over)
  else if (typeof over === 'function') carry(over())
  return made
}

/**
 * Takes connections as they arrive at a backend, and finds each its link: a new session is a new link, handed to
 * `onLink`, and a known one is handed back to the link it was. A connection that would resume a session this end
 * does not know is told the session is lost, and closed.
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
    }
    transport.onClose(() => { closed = true; for (const then of closes.splice(0)) then() })
    transport.onData((message) => {
      if (!first) { for (const heard of hears) heard(message); return }
      first = false
      let said: unknown
      try { said = (JSON.parse(textOf(message)) as unknown[])[0] } catch { /* not a link's: a new link says so */ }
      const hello = isObject(said) && said.link === LINK && typeof said.session === 'string' && isCount(said.taken) ? said as Hello : undefined
      const known = hello && links.get(hello.session)
      if (known) known.carry(relay)
      else if (hello?.again) {
        // A session from before this end began: a new session says so, and the other end finds it lost.
        transport.send(JSON.stringify([{ link: LINK, session: crypto.randomUUID(), taken: 0 } satisfies Hello, { lost: true } satisfies Lost]))
        transport.close()
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
