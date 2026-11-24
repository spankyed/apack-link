// One end of a link, on what it is handed: transports to be carried on, clocks to wait on, and whoever listens.
// What an end does is `core.ts`, which sends nothing and waits on nothing. Here each thing that happens is told
// to it (something sent, a message arriving, a connection closing, a clock running out) and what it says is to
// be done is done, in order: written to a transport, put on a clock, handed to a listener.
//
// A step of the core is whole before anything it asked for is done. So a listener that sends, or closes, as it
// is called finds the end as that step left it, and what it does is a step of its own.
//
// What a listener throws is never the link's. Every listener is still called and every frame of a batch still
// taken, and what was thrown is handed to `thrown`, or thrown again in a turn of its own.
import { core, firstOf, isHello, isObject, LEAST, limits, LINK, ready, setup, start, type Bye, type Effect, type Ending, type Event, type Hello, type Lost, type Ready, type Sending, type Size, type Traffic } from './core.ts'
import { json, type Codec } from './codec.ts'
import type { Frame } from './frames.ts'
import type { Message, Transport } from './transport.ts'

export { LEAST, LINK, type Bye, type Ending, type Sending, type Size, type Traffic } from './core.ts'

export interface Link {
  /**
   * Sends a frame, or one this link prepared. Throws if the frame cannot be sent, having sent nothing and taken no
   * number: that one frame is refused, and the link goes on. A `TypeError` for one that cannot be encoded,
   * and a `RangeError` for one larger, with its cause, than `bound.frame`, or whose cause is longer than 1024
   * bytes. While there is no connection it waits,
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

/** An end of a link that listens, and is handed each connection it is carried on. */
export interface Listener extends Link {
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

/** A frame encoded by a link, to be sent by it later: what `prepare` returns. It says the frame's kind and nothing else. */
export interface Prepared { readonly prepared: Frame['kind'] }

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


/** Throws for what takes no message as long as the link needs, having closed it: a link is not carried on that. */
const wideEnough = (transport: Transport, needed: number): void => {
  if (transport.most === undefined || transport.most >= needed) return
  try { transport.close() } catch { /* it is not this link's to report */ }
  throw new RangeError(`What a link is carried on takes messages of ${needed} bytes at least: what any link needs`)
}

/**
 * Makes the end of a link that dials: the one that opened the connection, or, where neither did, the one of the
 * two chosen to. It says hello first, and ends for what it meets: another link, a session that cannot be gone on
 * with, something that is not a link. Given a transport, the link is carried on it alone and ends when it
 * closes: what it sends goes at once, beside its hello. Given what opens a transport, and the clock to pace it on
 * (`reopen`), it opens one now and another after each one closes, and numbers nothing until the other end has
 * said hello.
 */
export function dial(open: () => Transport, options: Options & { readonly reopen: Reopen }): Link
export function dial(over: Transport, options?: Options): Link
export function dial(over: Transport | (() => Transport), options: Options = {}): Link {
  // Opening again with nothing to pace it is a link that spins while its connections fail: not one to be made.
  if (typeof over === 'function' && !options.reopen) throw new TypeError('A link that opens its own connections is given a clock to open them on')
  // It opens its connections, or is on one alone: there is nothing to hand it one with.
  const { carry: _, ...made } = end('dials', over, options).made
  return made
}

/**
 * Makes the end of a link that listens: the other end of a connection somebody else opened. It says nothing on
 * a connection until a hello that fits has arrived on it, and numbers nothing until then. Given a transport, the
 * link is carried on it alone and ends when it closes. Given nothing, it is handed each connection with `carry`,
 * as a backend's links are by `accept`, and ends for nothing any of them says before a hello that fits.
 */
export function listen(over: Transport, options?: Options): Link
export function listen(over?: undefined, options?: Options): Listener
export function listen(over?: Transport, options: Options = {}): Link | Listener {
  const { made } = end('listens', over, options)
  if (!over) return made
  // It is on one connection alone: there is nothing to hand it another with.
  const { carry: _, ...alone } = made
  return alone
}

/** One end of a link, on what it is handed. */
function end(role: 'dials' | 'listens', over: Transport | (() => Transport) | undefined, options: Options): { readonly made: Listener; readonly hand: (transport: Transport) => void } {
  const pace = options.reopen
  const later = options.later ?? queueMicrotask
  const set = setup({
    role,
    connections: typeof over === 'object' ? 'one' : typeof over === 'function' ? 'opened' : 'handed',
    session: crypto.randomUUID(),
    ...(options.codec ? { codec: options.codec } : {}),
    ...(options.part === undefined ? {} : { part: options.part }),
    ...(options.bound ? { bound: options.bound } : {}),
    ...(options.there ? { window: options.there.window } : {}),
    ...(pace?.first === undefined ? {} : { first: pace.first }),
    ...(pace?.most === undefined ? {} : { most: pace.most }),
  })
  const step = core(set)
  const state = start()
  /** What this link prepared and has not sent. */
  const prepared = new WeakMap<Prepared, Ready>()
  const hears: Array<(frame: Frame, cause?: string) => void> = []
  const taps: Array<(traffic: Traffic) => void> = []
  const ends: Array<(ending: Ending) => void> = []
  /** Each connection the end may still say something of, by the number it was told to the end with. */
  const transports = new Map<number, Transport>()
  let connections = 0
  /** What calls off each thing on a clock, by its number. */
  const calledOff = new Map<number, () => void>()
  /** Tells each tap. A tap that throws is not this link's to report, and does not stop it. */
  const tap = (traffic: Traffic): void => { for (const seen of taps) try { seen(traffic) } catch { /* the tap's */ } }
  /** Hands on what a listener threw: to `thrown`, or to a turn of its own, where nothing of the link's is under it. */
  const report = (error: unknown): void => {
    let thrown = error
    if (options.thrown) try { options.thrown(error); return } catch (again) { thrown = again }
    queueMicrotask(() => { throw thrown })
  }
  /** How many bytes what carries a connection has not yet written, where it says. */
  const backlog = (on: number | undefined): number => (on === undefined ? 0 : transports.get(on)?.waiting?.() ?? 0)

  /** Tells the end something happened, and does what it says is to be done, in order. */
  const tell = (event: Event): void => {
    // Which transport each is for is found before any is done: doing one may be a step of its own, after which
    // a connection the end is no longer on is no longer kept.
    const effects = step(state, event).map((effect) => [effect, 'on' in effect ? transports.get(effect.on) : undefined] as const)
    for (const on of transports.keys()) if (on !== state.now?.id && on !== state.pending?.id) transports.delete(on)
    for (const [effect, transport] of effects) perform(effect, transport)
  }
  const perform = (effect: Effect, transport: Transport | undefined): void => {
    switch (effect.do) {
      case 'write':
        // A transport that cannot send is a connection that has gone: the end is told, and goes on as it does
        // for any connection that went. What was thrown is the transport's, and is handed on.
        try { for (const message of effect.messages) transport!.send(message) } catch (error) {
          tell({ is: 'broke', on: effect.on })
          try { transport!.close() } catch { /* it has gone already */ }
          report(error)
        }
        return
      case 'close':
        try { transport?.close() } catch (error) { if (effect.thrown === 'reported') report(error) }
        return
      case 'away':
        try {
          if (effect.message !== undefined) transport!.send(effect.message)
          transport!.close()
        } catch { /* it has gone already */ }
        return
      case 'later':
        later(() => tell({ is: 'turn', on: effect.on }))
        return
      case 'after': {
        const clock = effect.clock === 'reopen' ? pace!.clock : options.there!.clock
        // A clock may run what it is handed before it returns: then there is nothing left to call off.
        let ran = false
        const off = clock.after(effect.ms, () => {
          ran = true
          calledOff.delete(effect.timer)
          tell({ is: 'due', timer: effect.timer })
        })
        if (!ran) calledOff.set(effect.timer, off)
        return
      }
      case 'off': {
        const off = calledOff.get(effect.timer)
        calledOff.delete(effect.timer)
        off?.()
        return
      }
      case 'open':
        // What cannot be opened, or carried, is a connection that did not hold.
        try { carry((over as () => Transport)()) } catch (error) {
          tell({ is: 'unopened' })
          report(error)
        }
        return
      case 'hand':
        if (effect.traffic) tap(effect.traffic)
        for (const hear of hears) try { hear(effect.frame, effect.cause) } catch (error) { report(error) }
        return
      case 'traffic':
        tap(effect.traffic)
        return
      case 'ended':
        for (const ended of ends) try { ended(effect.ending) } catch (error) { report(error) }
    }
  }

  const hand = (transport: Transport): void => {
    if (state.ending) { transport.close(); return }
    const on = ++connections
    transports.set(on, transport)
    tell({ is: 'carry', on, ...(transport.most === undefined ? {} : { most: transport.most }) })
    transport.onClose(() => tell({ is: 'closed', on }))
    transport.onData((message) => {
      // A frame handed over is the last thing a step asks for: once whoever it was handed to has been called,
      // the rest of the message is taken, as far as the next. Should doing any of it throw, none is left over.
      const taking = state.taking.length
      try {
        tell({ is: 'data', on, message, backlog: backlog(on) })
        while (state.taking.length > taking) tell({ is: 'more', backlog: backlog(on) })
      } finally { state.taking.length = Math.min(state.taking.length, taking) }
    })
  }
  const carry = (transport: Transport): void => {
    if (state.ending) { transport.close(); return }
    wideEnough(transport, LEAST)
    hand(transport)
  }

  const made: Listener = {
    prepare: (frame, how = {}) => {
      const token: Prepared = { prepared: frame.kind }
      prepared.set(token, ready(set, frame, how))
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
      } else one = ready(set, what, how)
      tell({ is: 'send', one, backlog: backlog(state.now?.id) })
    },
    onFrame: (hear) => { hears.push(hear) },
    onTraffic: (seen) => {
      taps.push(seen)
      tell({ is: 'tapped' })
    },
    onEnd: (ended) => { if (state.ending) ended(state.ending); else ends.push(ended) },
    close: (bye) => { tell({ is: 'close', ...(bye ? { bye } : {}) }) },
    carry,
    kept: () => state.kept.length,
    awaiting: () => {
      tell({ is: 'owed' })
      let settled = false
      return () => {
        if (settled) return
        settled = true
        tell({ is: 'settled' })
      }
    },
    waiting: () => state.waiting.length,
  }
  if (typeof over === 'object') carry(over)
  else if (typeof over === 'function') carry(over())
  return { made, hand }
}

/** What `accept` returns: what takes each connection with whose it is, and what says an owner will not be back. */
export interface Accepting<Owner> {
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
}

/**
 * Takes connections as they arrive at a backend, each with its owner, and finds each its link. An owner is
 * whatever the host knows a dialler by, compared as a `Map` compares keys: it is settled by whatever admitted the
 * connection, and never crosses the link.
 *
 * - **A session is gone on with only by its owner.** A connection that says another owner's session is told what
 *   one that says a session nobody has is told, that it is lost, and ends nothing.
 * - **An owner has one session.** A new session from an owner ends the one it had, which is told `ended`, before
 *   the new one is handed to `onLink`: a window that reloaded.
 * - **The host says an owner is gone**, with `gone`, and nothing else ends a session for a dialler that stopped
 *   coming back: nothing a link sees tells that from one that is slow to.
 *
 * So no more sessions are kept than there are owners taken and not said to be gone. A link authenticates nobody:
 * who may connect, and as whom, is settled before a connection is handed here.
 */
export function accept<Owner>(onLink: (link: Link, owner: Owner) => void, options: Options = {}): Accepting<Owner> {
  const codec = options.codec ?? json
  type Session = { readonly id: string; readonly link: Link; readonly hand: (transport: Transport) => void }
  /** The one session each owner has. */
  const sessions = new Map<Owner, Session>()
  /** What closes each connection taken as an owner's and still open, a session's or not yet anybody's. */
  const open = new Map<Owner, Set<() => void>>()
  // What a link would refuse to be made with is refused here, and not where the first connection says hello.
  limits(options)
  const take = (transport: Transport, owner: Owner): void => {
    // Found when the connection arrives, not when a frame is too long for it.
    wideEnough(transport, LEAST)
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
    /** Closes the connection for an owner that is gone: nothing it says after is heard. */
    const shut = (): void => {
      closed = true
      try { transport.close() } catch { /* it has gone already */ }
    }
    const mine = open.get(owner) ?? new Set()
    open.set(owner, mine.add(shut))
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
    transport.onClose(() => {
      closed = true
      const still = open.get(owner)
      if (still?.delete(shut) && still.size === 0) open.delete(owner)
      for (const then of closes.splice(0)) then()
    })
    transport.onData((message) => {
      if (closed) return
      if (!first) { for (const heard of hears) heard(message); return }
      first = false
      const said = firstOf(codec, message)
      if (!isHello(said)) {
        // Another link's number is answered with this one's, so that the end that opened it ends saying both.
        // Anything else is not a link's, and nothing is said to it.
        turnAway(isObject(said) && typeof said.link === 'number' && said.link !== LINK ? 'which link' : 'nothing')
        return
      }
      const had = sessions.get(owner)
      if (had?.id === said.session) had.hand(relay)
      // Going on with a session this owner does not have: another owner's, one from before this end began, or one
      // that says it took what nobody here sent. Each is told the same, and the session the owner has goes on.
      else if (said.resumes !== undefined || said.taken !== 0) { turnAway('lost'); return }
      // One that takes no message as long as any link needs is not a session to begin: no link is made for it.
      else if (said.most !== undefined && said.most < LEAST) { turnAway('lost'); return }
      else {
        // The owner began again: the session it had is over before the new one is anybody's.
        if (had) {
          had.link.close('ended')
          // Whoever heard that end may have said the owner is gone.
          if (closed) return
        }
        const { made, hand } = end('listens', undefined, options)
        // Handing it its connections is this function's, and nobody else's.
        const { carry: _, ...link } = made
        const session: Session = { id: said.session, link, hand }
        sessions.set(owner, session)
        // A link has ended by the time closing it returns, so the session an owner has is never one that ended.
        made.onEnd(() => { sessions.delete(owner) })
        onLink(link, owner)
        hand(relay)
      }
      for (const heard of hears) heard(message)
    })
  }
  const gone = (owner: Owner): void => {
    sessions.get(owner)?.link.close('ended')
    const mine = open.get(owner)
    open.delete(owner)
    for (const shut of [...(mine ?? [])]) shut()
  }
  return { take, gone }
}
