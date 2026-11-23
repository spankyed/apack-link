// What gives a link's ids their meaning. A link carries frames in order and knows nothing of what they are for; a
// peer matches an ask to its answer and a followed view to what it is shown, for one system at one end.
//
// A system offers a `Port`. `join` turns what arrives on a link into calls on this system's port, and returns a
// port for the system at the other end, whose calls leave as frames. Each end numbers its own asks and its own
// views from 1, and an id is used once in a link's life.
import type { Failure, Id } from './frames.ts'
import type { Link } from './link.ts'

/** How an ask ended. A system's own outcomes pass through as they are; these are the ones a link makes. */
export type Outcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly failure: Failure }

/** What one system offers another. */
export interface Port {
  /** Something happened. Nobody waits. */
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

/** Calls every one, whatever any of them throws, and then throws the first thing thrown. */
const each = <T>(all: readonly T[], call: (one: T) => void): void => {
  let thrown: { error: unknown } | undefined
  for (const one of all) try { call(one) } catch (error) { thrown ??= { error } }
  if (thrown) throw thrown.error
}

/** Joins a system to the other end of a link: `mine` is what this system offers, and what is returned is what the other does. */
export function join(link: Link, mine: Port): Port {
  let closed = false
  /** What this end asked and has not been answered, and what it follows. */
  const asked = new Map<Id, { heard(update: unknown): void; ended(outcome: Outcome): void }>()
  const followed = new Map<Id, { shown(update: unknown): void; over(failure: Failure): void }>()
  /**
   * What this end is answering for the other, and the views it runs for it. `halt` is what to call when the other
   * has gone or let go, once the system has handed it over; `halted` says that happened before it was.
   */
  const answering = new Map<Id, { halt?: () => void; halted: boolean }>()
  const running = new Map<Id, { halt?: () => void; halted: boolean }>()
  const halt = (work: { halt?: () => void; halted: boolean }): void => { work.halted = true; work.halt?.() }
  let asks = 0
  let views = 0
  /** The last id the other end used for each. One that is not new has been used, and is not taken again. */
  let lastAsk = 0
  let lastFollow = 0

  const answer = (id: Id, to: string, name: string, args: unknown): void => {
    const work: { halt?: () => void; halted: boolean } = { halted: false }
    answering.set(id, work)
    const live = (): boolean => answering.get(id) === work
    const fail = (failure: Failure): void => {
      answering.delete(id)
      link.send({ kind: 'answer', id, outcome: { ok: false, failure } satisfies Outcome })
    }
    let gone: () => void
    try {
      gone = mine.ask(to, name, args,
        (update) => {
          if (!live()) return
          try { link.send({ kind: 'progress', id, update }) } catch { fail(unsendable()); halt(work) }
        },
        (outcome) => {
          if (!live()) return
          try { link.send({ kind: 'answer', id, outcome }); answering.delete(id) } catch { fail(unsendable()) }
        })
    } catch {
      if (live()) fail(refused())
      return
    }
    if (work.halted) gone()
    else work.halt = gone
  }

  const run = (id: Id, feature: string, view: string, args: unknown): void => {
    const work: { halt?: () => void; halted: boolean } = { halted: false }
    running.set(id, work)
    const live = (): boolean => running.get(id) === work
    const end = (failure: Failure): void => {
      running.delete(id)
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
    if (work.halted) following.stop()
    else work.halt = () => following.stop()
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
    each<() => void>([
      ...waiting.map((ask) => () => ask.ended({ ok: false, failure: disconnected() })),
      ...watching.map((view) => () => view.over(disconnected())),
      ...working.map((work) => () => halt(work)),
    ], (call) => call())
  })

  return {
    tell: (to, event) => { link.send({ kind: 'tell', to, event }) },
    ask: (to, name, args, heard, ended) => {
      if (closed) { ended({ ok: false, failure: disconnected() }); return () => {} }
      const id = ++asks
      asked.set(id, { heard, ended })
      try { link.send({ kind: 'ask', id, to, name, args }) } catch {
        asked.delete(id)
        ended({ ok: false, failure: unsendable() })
        return () => {}
      }
      return () => { if (asked.delete(id)) link.send({ kind: 'left', id }) }
    },
    follow: (feature, view, args, shown, over) => {
      if (closed) { over(disconnected()); return { stop: () => {} } }
      const id = ++views
      followed.set(id, { shown, over })
      try { link.send({ kind: 'follow', id, feature, view, args }) } catch {
        followed.delete(id)
        over(unsendable())
        return { stop: () => {} }
      }
      return { stop: () => { if (followed.delete(id)) link.send({ kind: 'unfollow', id }) } }
    },
  }
}
