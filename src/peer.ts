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
import type { Failure, Frame, Id } from './frames.ts'
import type { Link } from './link.ts'

/** How an ask ended. A system's own outcomes pass through as they are; these are the ones a link makes. */
export type Outcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly failure: Failure }

/** What one system offers another. */
export interface Port {
  /** Something happened. Nobody waits. Throws for an event that cannot be sent, having sent nothing. */
  tell(to: string, event: unknown): void
  /** Asks. `heard` takes what is said before the answer, `ended` how it ended. Returns what to call when whoever asked has gone. */
  ask(to: string, name: string, args: unknown, heard: (update: unknown) => void, ended: (outcome: Outcome) => void): () => void
  /** Follows a view. `shown` takes its result and each changed result after it, `over` that it has ended and why. */
  follow(feature: string, view: string, args: unknown, shown: (update: unknown) => void, over: (failure: Failure) => void): Following
}

export interface Following {
  stop(): void
  /**
   * Calls `then` once this view has been shown everything kept before the call. `soon` says something is
   * blocked on it. Offered by a system that runs views; one reached across a link has none.
   */
  caughtUp?(then: () => void, soon: boolean): void
}

/** The link went before the answer, or before the view was let go. */
const disconnected = (): Failure => ({ kind: 'disconnected', message: 'The link closed' })
/** A value a system gave could not be put into a frame. The value is not said. */
const unsendable = (): Failure => ({ kind: 'failed', message: 'A value could not be sent' })
/** A system threw where it was asked or followed. What it threw is its own to report. */
const refused = (): Failure => ({ kind: 'failed', message: 'It could not be taken' })
const failed = (id: Id, failure: Failure): Frame => ({ kind: 'answer', id, outcome: { ok: false, failure } satisfies Outcome })

/** Calls every one, whatever any of them throws, and then throws the first thing thrown. */
const each = <T>(all: readonly T[], call: (one: T) => void): void => {
  let thrown: { error: unknown } | undefined
  for (const one of all) try { call(one) } catch (error) { thrown ??= { error } }
  if (thrown) throw thrown.error
}

/** An ask this end is answering, or a view it runs, for the other. */
interface Work {
  /** What to call when the other has gone or let go, once the system has handed it over. */
  halt?: () => void
  /** The other went or let go before the system handed over what to call. */
  halted: boolean
  /** A value for this ask could not be sent, and it was answered `failed` in its place: nothing more for it goes. */
  spoiled?: boolean
  /** For a view: what it offers to say it has caught up. */
  caughtUp?: Following['caughtUp']
}

/** Something the system said, waiting in the hold. */
interface Held {
  readonly frame: Frame
  /** The ask it is for, on this end's side: once that is spoiled, it is not sent. */
  readonly of?: Work
  /** What to do when it cannot be sent. Returns the frame to send in its place, if there is one. */
  readonly refused?: () => Frame | undefined
}

/** One asking of the views: what was held when it was asked, and the views that have not called back. */
interface Round { readonly upTo: number; readonly waiting: Set<Work> }

/** Joins a system to the other end of a link: `mine` is what this system offers, and what is returned is what the other does. */
export function join(link: Link, mine: Port): Port {
  let closed = false
  /** What this end asked and has not been answered, and what it follows. */
  const asked = new Map<Id, { heard(update: unknown): void; ended(outcome: Outcome): void }>()
  const followed = new Map<Id, { shown(update: unknown): void; over(failure: Failure): void }>()
  /** What this end is answering for the other, and the views it runs for it. */
  const answering = new Map<Id, Work>()
  const running = new Map<Id, Work>()
  let asks = 0
  let views = 0
  /** The last id the other end used for each. One that is not new has been used, and is not taken again. */
  let lastAsk = 0
  let lastFollow = 0

  /** What waits in the hold, oldest first, and how many have ever been put there and let out. */
  const held: Held[] = []
  let put = 0
  let let_out = 0
  /** Each asking of the views, oldest first. What a round covers leaves when it and every round before it are done. */
  const rounds: Round[] = []
  let releasing = false

  /** Sends one thing the system said. What cannot be sent is refused alone, with what goes in its place. */
  const emit = (one: Held): void => {
    if (one.of?.spoiled) return
    try { link.send(one.frame) } catch (error) {
      if (!one.refused) throw error
      const instead = one.refused()
      if (instead) link.send(instead)
    }
  }

  /** Lets out what every round at the front has been called back for. */
  const release = (): void => {
    if (releasing) return
    releasing = true
    try {
      while (!closed && rounds.length && rounds[0]!.waiting.size === 0) {
        const round = rounds.shift()!
        while (let_out < round.upTo) {
          const one = held.shift()!
          let_out++
          // A tell whose event changed after it was told into something that cannot be sent goes nowhere: nobody
          // waits on it, and there is nobody here to throw to.
          try { emit(one) } catch { /* refused */ }
        }
      }
    } finally { releasing = false }
  }

  /** A view that stops counts as caught up for every round waiting on it. */
  const forget = (work: Work): void => {
    let any = false
    for (const round of rounds) any = round.waiting.delete(work) || any
    if (any) release()
  }

  /** Puts something the system said in the hold, or sends it, when nothing is ahead of it and nothing is to be waited on. */
  const hand = (one: Held): void => {
    if (closed) return
    const views = [...running.values()].filter((work) => work.caughtUp)
    if (!held.length && !views.length) { emit(one); return }
    // Found to be unsendable where it was said, as when it is sent at once: what is refused is refused there.
    try { JSON.stringify(one.frame) } catch (error) {
      if (!one.refused) throw error
      const instead = one.refused()
      if (instead) hand({ frame: instead })
      return
    }
    // What this round lets out is what was put in the hold since the round before it was asked.
    const from = rounds.at(-1)?.upTo ?? let_out
    held.push(one)
    put++
    const round: Round = { upTo: put, waiting: new Set(views) }
    rounds.push(round)
    // Something is blocked on the views when an answer is among it: an asker is waiting.
    const soon = held.slice(from - let_out).some((waiting) => waiting.frame.kind === 'answer')
    for (const work of views) {
      let called = false
      work.caughtUp!(() => {
        if (called) return
        called = true
        if (round.waiting.delete(work)) release()
      }, soon)
    }
    release()
  }

  const halt = (work: Work): void => {
    work.halted = true
    forget(work)
    work.halt?.()
  }

  const answer = (id: Id, to: string, name: string, args: unknown): void => {
    const work: Work = { halted: false }
    answering.set(id, work)
    const live = (): boolean => answering.get(id) === work
    /** In place of a value that could not be sent: the ask is answered `failed`, and nothing more goes for it. */
    const spoil = (): Frame => {
      work.spoiled = true
      if (live()) { answering.delete(id); halt(work) }
      return failed(id, unsendable())
    }
    let gone: () => void
    try {
      gone = mine.ask(to, name, args,
        (update) => { if (live()) hand({ frame: { kind: 'progress', id, update }, of: work, refused: spoil }) },
        (outcome) => {
          if (!live()) return
          answering.delete(id)
          hand({ frame: { kind: 'answer', id, outcome }, of: work, refused: spoil })
        })
    } catch {
      if (live()) { answering.delete(id); hand({ frame: failed(id, refused()) }) }
      return
    }
    if (work.halted) gone()
    else work.halt = gone
  }

  const run = (id: Id, feature: string, view: string, args: unknown): void => {
    const work: Work = { halted: false }
    running.set(id, work)
    const live = (): boolean => running.get(id) === work
    // A view's own words are what the hold waits for, so they go at once.
    const end = (failure: Failure): void => {
      running.delete(id)
      forget(work)
      link.send({ kind: 'over', id, failure })
    }
    let following: Following
    try {
      following = mine.follow(feature, view, args,
        (update) => {
          if (!live()) return
          try { link.send({ kind: 'shown', id, update }) } catch { end(unsendable()); halt(work) }
        },
        (failure) => {
          if (!live()) return
          try { end({ kind: String(failure.kind), message: String(failure.message) }) } catch { end(unsendable()) }
        })
    } catch {
      if (live()) end(refused())
      return
    }
    if (work.halted) { following.stop(); return }
    work.halt = () => following.stop()
    if (live() && following.caughtUp) work.caughtUp = following.caughtUp.bind(following)
  }

  link.onFrame((frame) => {
    switch (frame.kind) {
      case 'tell': mine.tell(frame.to, frame.event); return
      case 'ask':
        if (frame.id <= lastAsk) return
        lastAsk = frame.id
        answer(frame.id, frame.to, frame.name, frame.args)
        return
      case 'left': {
        const work = answering.get(frame.id)
        if (work) { answering.delete(frame.id); halt(work) }
        return
      }
      case 'progress': asked.get(frame.id)?.heard(frame.update); return
      case 'answer': {
        const waiting = asked.get(frame.id)
        if (waiting) { asked.delete(frame.id); waiting.ended(frame.outcome as Outcome) }
        return
      }
      case 'follow':
        if (frame.id <= lastFollow) return
        lastFollow = frame.id
        run(frame.id, frame.feature, frame.view, frame.args)
        return
      case 'unfollow': {
        const work = running.get(frame.id)
        if (work) { running.delete(frame.id); halt(work) }
        return
      }
      case 'shown': followed.get(frame.id)?.shown(frame.update); return
      case 'over': {
        const view = followed.get(frame.id)
        if (view) { followed.delete(frame.id); view.over(frame.failure) }
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
    held.length = 0
    rounds.length = 0
    each<() => void>([
      ...waiting.map((ask) => () => ask.ended({ ok: false, failure: disconnected() })),
      ...watching.map((view) => () => view.over(disconnected())),
      ...working.map((work) => () => halt(work)),
    ], (call) => call())
  })

  return {
    tell: (to, event) => { hand({ frame: { kind: 'tell', to, event } }) },
    ask: (to, name, args, heard, ended) => {
      if (closed) { ended({ ok: false, failure: disconnected() }); return () => {} }
      const id = ++asks
      asked.set(id, { heard, ended })
      hand({
        frame: { kind: 'ask', id, to, name, args },
        refused: () => { if (asked.delete(id)) ended({ ok: false, failure: unsendable() }); return undefined },
      })
      return () => { if (asked.delete(id)) hand({ frame: { kind: 'left', id } }) }
    },
    follow: (feature, view, args, shown, over) => {
      if (closed) { over(disconnected()); return { stop: () => {} } }
      const id = ++views
      followed.set(id, { shown, over })
      hand({
        frame: { kind: 'follow', id, feature, view, args },
        refused: () => { if (followed.delete(id)) over(unsendable()); return undefined },
      })
      return { stop: () => { if (followed.delete(id)) hand({ frame: { kind: 'unfollow', id } }) } }
    },
  }
}
