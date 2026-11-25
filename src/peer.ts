// What gives a link's ids their meaning. A link carries frames in order and knows nothing of what they are for; a
// peer matches an ask to its answer and a followed view to what it is shown, for one system at one end.
//
// A system offers a `Port`. `join` turns what arrives on a link into calls on this system's port, and returns a
// port for the system at the other end, whose calls leave as frames. Each end numbers its own asks and its own
// views from 1, and an id is used once in a link's life.
//
// What a system says to the other end waits until the views it runs for that end have caught up: the hold. A view's
// `shown` and `over` are what is waited for, and go at once; everything else the system says is one queue, in the
// order it was said, and leaves a round at a time once every view the round asked has called back.
import type { Failure, Frame, Id } from './frames.js'
import type { Link, Prepared, Sending, Size } from './link.js'

/** How an ask ended. A system's own outcomes pass through as they are; these are the ones a link makes. */
export type Outcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly failure: Failure }

/** What one system offers another. */
export interface Port {
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

export interface Following {
  stop(): void
  /**
   * Calls `then` once this view has been shown everything kept before the call. `soon` says something is
   * blocked on it. Offered by a system that runs views; one reached across a link has none.
   */
  caughtUp?(then: () => void, soon: boolean): void
}

/**
 * Payload-free diagnostic snapshot reported when the peer hold exceeds `bound` because one or more views did not
 * catch up. Never carries frame payloads, arguments, or causes.
 */
export interface HoldStall {
  /** Ids of the stalled view(s) still blocking the oldest held round, which were ended `over` and stopped. */
  readonly views: readonly Id[]
  /** Frames and encoded bytes waiting in the hold when the bound was exceeded. */
  readonly held: Size
  /** Number of held rounds waiting when the bound was exceeded. */
  readonly rounds: number
  /** The configured hold bound that was exceeded. */
  readonly bound: Size
}

/** Optional controls for `join`: hold bounds, payload-free stall diagnostics, and unexpected `caughtUp` error handling. */
export interface JoinOptions {
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

/** Default hold limit: matches a link's default waiting bound so a stalled view cannot grow memory without bound. */
const HOLD_BOUND: Size = { frames: 16384, size: 64 * 1024 * 1024 }
const isBound = (value: number, least: number): boolean =>
  value === Number.POSITIVE_INFINITY || (Number.isSafeInteger(value) && value >= least)

/** Links already joined: joining the same link twice would register duplicate listeners and collide on ids. */
const joined = new WeakSet<Link>()

/** The link went before the answer, or before the view was let go. */
const disconnected = (): Failure => ({ kind: 'disconnected', message: 'The link closed' })
/** A value a system gave could not be put into a frame. The value is not said. */
const unsendable = (): Failure => ({ kind: 'failed', message: 'A value could not be sent' })
/** A system threw where it was asked or followed. What it threw is its own to report. */
const refused = (): Failure => ({ kind: 'failed', message: 'It could not be taken' })
/** A view did not catch up before the hold reached its bound, so it was ended to let the link go on. */
const stalled = (): Failure => ({ kind: 'failed', message: 'The view stalled' })
const failed = (id: Id, failure: Failure): Frame => ({ kind: 'answer', id, outcome: { ok: false, failure } satisfies Outcome })

/** Calls every one, whatever any of them throws, and then throws the first thing thrown. */
const each = <T>(all: readonly T[], call: (one: T) => void): void => {
  let thrown: { error: unknown } | undefined
  for (const one of all) try { call(one) } catch (error) { thrown ??= { error } }
  if (thrown) throw thrown.error
}

/** Compacts a head-indexed queue in place once at least half of it (and 64+ slots) have been consumed. */
const compact = <T>(list: Array<T | undefined>, head: number): number => {
  if (head === list.length) { list.length = 0; return 0 }
  if (head >= 64 && head * 2 >= list.length) {
    const kept = list.length - head
    list.copyWithin(0, head)
    list.length = kept
    return 0
  }
  return head
}

/** An ask this end is answering, or a view it runs, for the other. */
interface Work {
  /** For a view: its id on this link, for stall diagnostics. */
  readonly id?: Id
  /** What to call when the other has gone or let go, once the system has handed it over. */
  halt?: () => void
  /** The other went or let go before the system handed over what to call. */
  halted: boolean
  /** For a view: what it offers to say it has caught up. */
  caughtUp?: Following['caughtUp']
  /** For a view: ends it `over` and stops it when its `caughtUp` throws or stalls, before anything held leaves. */
  fail?: (failure: Failure) => void
}

/** Something the system said, waiting in the hold. */
interface Held {
  frame?: Frame
  /** What caused the frame and whether it is private, passed to `link.prepare` or `link.send`. */
  how?: Sending
  /** The frame as the link put it into text when it was held: what is sent, whatever becomes of the frame after. */
  ready?: Prepared
  /** What to do when it cannot be sent. Returns the frame to send in its place, if there is one. */
  readonly refused?: () => Frame | undefined
}

/** One asking of the views: what was held when it was asked, and the views that have not called back. */
interface Round { readonly upTo: number; readonly waiting: Set<Work> }

/** Joins a system to the other end of a link: `mine` is what this system offers, and what is returned is what the other does. */
export function join(link: Link, mine: Port, options: JoinOptions = {}): Port {
  const boundFrames = options.bound?.frames ?? HOLD_BOUND.frames
  const boundSize = options.bound?.size ?? HOLD_BOUND.size
  if (!isBound(boundFrames, 1)) throw new RangeError('bound.frames is 1 at least')
  if (!isBound(boundSize, 1)) throw new RangeError('bound.size is 1 byte at least')
  const holdBound: Size = { frames: boundFrames, size: boundSize }
  if (joined.has(link)) throw new TypeError('A link can only be joined once')
  joined.add(link)

  const report = (error: unknown): void => {
    let thrown = error
    if (options.thrown) try { options.thrown(error); return } catch (again) { thrown = again }
    queueMicrotask(() => { throw thrown })
  }

  let closed = false
  /** What this end asked and has not been answered, and what it follows. */
  const asked = new Map<Id, { heard(update: unknown, how?: Sending): void; ended(outcome: Outcome, how?: Sending): void; settle(): void }>()
  const followed = new Map<Id, { shown(update: unknown, how?: Sending): void; over(failure: Failure, how?: Sending): void }>()
  /** What this end is answering for the other, and the views it runs for it. */
  const answering = new Map<Id, Work>()
  const running = new Map<Id, Work>()
  /** Running views that offer `caughtUp`, maintained incrementally so `hand()` avoids scanning all views. */
  const caughtUpViews = new Set<Work>()
  let asks = 0
  let views = 0
  /** The last id the other end used for each. One that is not new has been used, and is not taken again. */
  let lastAsk = 0
  let lastFollow = 0

  /** What waits in the hold, oldest first from `heldHead`, its encoded byte total, and how many have been put/let out. */
  const held: Array<Held | undefined> = []
  let heldHead = 0
  let heldBytes = 0
  const heldLen = (): number => held.length - heldHead
  let put = 0
  let let_out = 0
  /** Each asking of the views, oldest first from `roundsHead`. What a round covers leaves when it and every round before it are done. */
  const rounds: Array<Round | undefined> = []
  let roundsHead = 0
  const roundsLen = (): number => rounds.length - roundsHead
  let releasing = false
  /** Non-zero while asking a round's views or failing stalled views, so `release()` never fires ahead of `over`. */
  let deferring = 0
  let enforcing = false

  /** Sends one thing the system said. What cannot be sent is refused alone, with what goes in its place. */
  const emit = (one: Held): void => {
    try {
      if (one.ready) link.send(one.ready)
      else link.send(one.frame!, one.how)
    } catch (error) {
      if (!one.refused) throw error
      const instead = one.refused()
      if (instead) link.send(instead)
    }
  }

  /** Ends stalled views blocking the oldest round when the hold exceeds `holdBound`, without releasing ahead of live views. */
  const enforceBound = (): void => {
    if (enforcing || deferring > 0 || releasing) return
    enforcing = true
    try {
      while (!closed && roundsHead < rounds.length && (heldLen() > holdBound.frames || heldBytes > holdBound.size)) {
        const oldest = rounds[roundsHead]!
        if (oldest.waiting.size === 0) { release(); continue }
        const stalledViews = [...oldest.waiting]
        const stall: HoldStall = {
          views: stalledViews.map((work) => work.id!),
          held: { frames: heldLen(), size: heldBytes },
          rounds: roundsLen(),
          bound: { frames: holdBound.frames, size: holdBound.size },
        }
        deferring++
        try {
          for (const work of stalledViews) {
            if (closed) break
            oldest.waiting.delete(work)
            try { work.fail?.(stalled()) } catch (error) { report(error) }
            forget(work)
          }
        } finally { deferring-- }
        release()
        if (options.onStall) try { options.onStall(stall) } catch (error) { report(error) }
      }
    } finally { enforcing = false }
  }

  /** Lets out what every round at the front has been called back for. */
  const release = (): void => {
    if (releasing || deferring > 0) return
    releasing = true
    try {
      while (!closed && roundsHead < rounds.length && rounds[roundsHead]!.waiting.size === 0) {
        const round = rounds[roundsHead]!
        rounds[roundsHead++] = undefined
        while (!closed && let_out < round.upTo) {
          const one = held[heldHead]!
          held[heldHead++] = undefined
          heldBytes -= one.ready!.size
          let_out++
          // Put into text when it was held, so it is not refused now.
          emit(one)
        }
      }
      heldHead = compact(held, heldHead)
      roundsHead = compact(rounds, roundsHead)
    } finally { releasing = false }
    if (!closed && !deferring && (heldLen() > holdBound.frames || heldBytes > holdBound.size)) enforceBound()
  }

  /** A view that stops counts as caught up for every round waiting on it. */
  const forget = (work: Work): void => {
    caughtUpViews.delete(work)
    let any = false
    for (let at = roundsHead; at < rounds.length; at++) any = rounds[at]!.waiting.delete(work) || any
    if (any) release()
  }

  /** Puts something the system said in the hold, or sends it, when nothing is ahead of it and nothing is to be waited on. */
  const hand = (one: Held, propagate = false): void => {
    if (closed) return
    if (!heldLen() && !caughtUpViews.size) { emit(one); return }
    // Found to be unsendable where it was said, as when it is sent at once: what is refused is refused there.
    // It is put into text here, once, and that text is what leaves: what it holds may change after and it will not.
    const soon = one.frame!.kind === 'answer'
    let ready: Prepared
    try { ready = link.prepare(one.frame!, one.how) } catch (error) {
      if (!one.refused) throw error
      const instead = one.refused()
      if (instead) hand({ frame: instead })
      return
    }
    if (closed) return
    one.ready = ready
    one.frame = undefined
    one.how = undefined
    const activeViews = [...caughtUpViews]
    held.push(one)
    heldBytes += ready.size
    put++
    const round: Round = { upTo: put, waiting: new Set(activeViews) }
    rounds.push(round)
    let thrown: { error: unknown } | undefined
    deferring++
    try {
      for (const work of activeViews) {
        if (closed) break
        if (!round.waiting.has(work)) continue
        let called = false
        try {
          work.caughtUp!(() => {
            if (called || closed) return
            called = true
            if (round.waiting.delete(work)) release()
          }, soon)
        } catch (error) {
          // A view whose caughtUp throws cannot be trusted to have caught up: end it (`over` before anything held
          // leaves) and stop it, then go on with the rest.
          if (propagate && !thrown) thrown = { error }
          else report(error)
          try { work.fail?.(refused()) } catch (again) { report(again) }
          forget(work)
        }
      }
    } finally { deferring-- }
    release()
    if (!closed && !deferring && !releasing && (heldLen() > holdBound.frames || heldBytes > holdBound.size)) enforceBound()
    if (thrown) throw thrown.error
  }

  const halt = (work: Work): void => {
    work.halted = true
    forget(work)
    work.halt?.()
  }

  const answer = (id: Id, to: string, name: string, args: unknown, how: Sending | undefined): void => {
    const work: Work = { halted: false }
    answering.set(id, work)
    const live = (): boolean => answering.get(id) === work
    /** In place of a value that could not be sent: the ask is answered `failed`, and nothing more goes for it. */
    const spoil = (): Frame => {
      if (live()) { answering.delete(id); halt(work) }
      return failed(id, unsendable())
    }
    let gone: () => void
    try {
      gone = mine.ask(to, name, args,
        (update, send) => { if (live()) hand({ frame: { kind: 'progress', id, update }, ...(send ? { how: send } : {}), refused: spoil }) },
        (outcome, send) => {
          if (!live()) return
          answering.delete(id)
          hand({ frame: { kind: 'answer', id, outcome }, ...(send ? { how: send } : {}), refused: spoil })
        },
        how)
    } catch {
      if (live()) { answering.delete(id); hand({ frame: failed(id, refused()) }) }
      return
    }
    if (work.halted) gone()
    else work.halt = gone
  }

  const run = (id: Id, feature: string, view: string, args: unknown, how: Sending | undefined): void => {
    const work: Work = { id, halted: false }
    running.set(id, work)
    const live = (): boolean => running.get(id) === work
    // A view's own words are what the hold waits for, so they go at once — ahead of anything held that waited on it.
    const end = (failure: Failure, send?: Sending): void => {
      running.delete(id)
      link.send({ kind: 'over', id, failure }, send)
      forget(work)
    }
    work.fail = (failure) => {
      if (!live()) return
      end(failure)
      halt(work)
    }
    let following: Following
    try {
      following = mine.follow(feature, view, args,
        (update, send) => {
          if (!live()) return
          try { link.send({ kind: 'shown', id, update }, send) } catch { end(unsendable()); halt(work) }
        },
        (failure, send) => {
          if (!live()) return
          try { end({ kind: String(failure.kind), message: String(failure.message) }, send) } catch { end(unsendable()) }
        },
        how)
    } catch {
      if (live()) end(refused())
      return
    }
    if (work.halted) { following.stop(); return }
    work.halt = () => following.stop()
    if (live() && following.caughtUp) {
      work.caughtUp = following.caughtUp.bind(following)
      caughtUpViews.add(work)
    }
  }

  link.onFrame((frame, cause) => {
    const how: Sending | undefined = cause === undefined ? undefined : { cause }
    switch (frame.kind) {
      case 'tell': mine.tell(frame.to, frame.event, how); return
      case 'ask':
        if (frame.id <= lastAsk) return
        lastAsk = frame.id
        answer(frame.id, frame.to, frame.name, frame.args, how)
        return
      case 'left': {
        const work = answering.get(frame.id)
        if (work) { answering.delete(frame.id); halt(work) }
        return
      }
      case 'progress': asked.get(frame.id)?.heard(frame.update, how); return
      case 'answer': {
        const waiting = asked.get(frame.id)
        if (waiting) { asked.delete(frame.id); waiting.settle(); waiting.ended(frame.outcome as Outcome, how) }
        return
      }
      case 'follow':
        if (frame.id <= lastFollow) return
        lastFollow = frame.id
        run(frame.id, frame.feature, frame.view, frame.args, how)
        return
      case 'unfollow': {
        const work = running.get(frame.id)
        if (work) { running.delete(frame.id); halt(work) }
        return
      }
      case 'shown': followed.get(frame.id)?.shown(frame.update, how); return
      case 'over': {
        const view = followed.get(frame.id)
        if (view) { followed.delete(frame.id); view.over(frame.failure, how) }
        return
      }
    }
  })

  link.onEnd(() => {
    closed = true
    // Each is taken out before anything is called, so that what a call does in turn finds nothing to end twice.
    const waiting = [...asked.values()]
    const watching = [...followed.values()]
    const working = [...answering.values(), ...running.values()]
    asked.clear()
    followed.clear()
    answering.clear()
    running.clear()
    caughtUpViews.clear()
    held.length = 0
    heldHead = 0
    heldBytes = 0
    rounds.length = 0
    roundsHead = 0
    each<() => void>([
      ...waiting.map((ask) => () => ask.ended({ ok: false, failure: disconnected() })),
      ...watching.map((view) => () => view.over(disconnected())),
      ...working.map((work) => () => halt(work)),
    ], (call) => call())
  })

  return {
    tell: (to, event, how) => { hand({ frame: { kind: 'tell', to, event }, ...(how ? { how } : {}) }, !options.thrown) },
    ask: (to, name, args, heard, ended, how) => {
      if (closed) { ended({ ok: false, failure: disconnected() }); return () => {} }
      const id = ++asks
      // Owed an answer: the link watches a quiet connection while it is.
      const settle = link.awaiting()
      asked.set(id, { heard, ended, settle })
      hand({
        frame: { kind: 'ask', id, to, name, args },
        ...(how ? { how } : {}),
        refused: () => { if (asked.delete(id)) { settle(); ended({ ok: false, failure: unsendable() }) } return undefined },
      })
      return () => { if (asked.delete(id)) { settle(); hand({ frame: { kind: 'left', id } }) } }
    },
    follow: (feature, view, args, shown, over, how) => {
      if (closed) { over(disconnected()); return { stop: () => {} } }
      const id = ++views
      followed.set(id, { shown, over })
      hand({
        frame: { kind: 'follow', id, feature, view, args },
        ...(how ? { how } : {}),
        refused: () => { if (followed.delete(id)) over(unsendable()); return undefined },
      })
      return { stop: () => { if (followed.delete(id)) hand({ frame: { kind: 'unfollow', id } }) } }
    },
  }
}
