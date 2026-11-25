// What ends of a link are to each other, said in as little as says it, and what holds a run of real ends to it.
//
// The model is a queue each way between two ends, and whether each end is still there:
//
//   send    an end that is there puts a frame last in its queue to the other. A view's result may instead take
//           the place of the last result of that view still in the queue.
//   take    an end that is there is handed the first frame in the queue to it.
//   end     an end is there no longer. It is handed nothing after.
//
// Nothing else happens. So what an end is handed is what one other end sent it, in the order it was sent, each
// once, with nothing left out but a view's result a later one overtook; and it is handed nothing by anybody else.
// How frames are numbered, kept, sent again, cut into parts and carried is all absent: none of it may show.
//
// A run of real ends is held to it as it happens. Each link a scenario is given is put under the model, which notes
// what it is sent, what it hands over and how it ends, and finds the first of those the model could not have done.
import { json, type Codec } from '../codec.ts'
import type { Frame } from '../frames.ts'
import type { Bye, Ending, Link, Prepared, Sending } from '../link.ts'

export interface Model {
  /** Puts a link under the model, before anything is sent on it or listens to it. What comes back is the link to use. */
  end<L extends Link>(link: L, name: string): L
  /**
   * What must hold once everything has come to rest. Throws for the first thing an end did that the model could
   * not have, with what led to it; and for what an end that is still there was sent, by the one end still there
   * that it could be talking to, and has not been handed.
   */
  check(): void
}

export interface ModelOptions {
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

/** Endings that say something crossed that should not have. */
const DEFECTS: ReadonlyArray<Ending['why']> = ['out of order', 'not a frame', 'version', 'too narrow']

const alike = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((byte, at) => byte === b[at])
  }
  // A date has no keys of its own: it is the moment it is.
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime())
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const [mine, theirs] = [Object.keys(a), Object.keys(b)]
  return mine.length === theirs.length && mine.every((key) => Object.hasOwn(b, key) && alike((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

/** Which view a frame is a result of, if it is one. */
const viewOf = (frame: Frame): number | undefined => (frame.kind === 'shown' ? frame.id : undefined)

/** A frame an end sent, as it crosses, with what caused it: each is told from every other by its number. */
interface Sent { readonly number: number; readonly frame: Frame; readonly cause?: string }

/**
 * The queue from one end to another, as far as what was noted leaves it open. A result that took an earlier one's
 * place is only known once it is handed over, so what was sent is kept as it was sent, and each way the hand-overs
 * so far could have come about is a queue of what is left: usually one, and never the same one twice.
 */
interface Way { queues: Sent[][] }

/** Hands the first frame of a queue over as `frame`, each way the model could: every queue that leaves. */
const taken = (queue: readonly Sent[], frame: Frame, cause: string | undefined): Sent[][] => {
  const first = queue[0]
  if (!first) return []
  const same = (one: Sent): boolean => one.cause === cause && alike(one.frame, frame)
  const left: Sent[][] = []
  if (same(first)) left.push(queue.slice(1))
  // The first is a view's result, and a later result of that view took its place, and the place of every one
  // between them: those are gone, and what else was sent since stays where it was.
  const view = viewOf(first.frame)
  if (view === undefined) return left
  for (let at = 1; at < queue.length; at++) {
    if (viewOf(queue[at]!.frame) !== view || !same(queue[at]!)) continue
    left.push(queue.filter((one, index) => index > at || viewOf(one.frame) !== view))
  }
  return left
}
/** Queues, each once: two that hold the same frames are one way things could have gone. */
const each = (queues: Sent[][]): Sent[][] => [...new Map(queues.map((queue) => [queue.map((one) => one.number).join(','), queue])).values()]

interface End {
  readonly name: string
  /** Every frame it has sent, in order. */
  readonly out: Sent[]
  /** How many frames it has been handed. */
  heard: number
  ended?: Ending
  /** The goodbyes it closed with. */
  readonly byes: Bye[]
  /** The queue to it from each other end, while that end could be the one it is talking to. */
  readonly from: Map<End, Way>
}

/** Makes a model to hold ends to: every link of one scenario is put under the same one. */
export function model(options: ModelOptions = {}): Model {
  const codec = options.codec ?? json
  const may = options.may ?? []
  /** A frame as it is once it has crossed. */
  const crossed = (frame: Frame): Frame => codec.decode(codec.encode(frame)) as Frame
  const ends: End[] = []
  /** The last things that happened, in order, for saying what led to something: put into words only if asked for. */
  const log: Array<{ readonly who: string; readonly did: string; readonly what: unknown; readonly cause?: string }> = []
  const notes = (who: string, did: string, what: unknown, cause?: string): void => {
    log.push({ who, did, what, ...(cause === undefined ? {} : { cause }) })
    if (log.length > 12) log.shift()
  }
  const said = (frame: unknown, cause?: string): string => {
    let text: string
    try { text = JSON.stringify(frame) } catch { text = String((frame as { kind?: unknown }).kind) }
    return cause === undefined ? text : `${text}, caused by ${JSON.stringify(cause)}`
  }
  const led = (): string => `\n  after:\n    ${log.map((one) => `${one.who} ${one.did} ${said(one.what, one.cause)}`).join('\n    ')}`
  let broken: string | undefined
  const breaks = (what: string): void => { broken ??= `${what}${led()}` }
  let sends = 0

  const sent = (by: End, frame: Frame, cause: string | undefined): void => {
    notes(by.name, 'sent', frame, cause)
    const one: Sent = { number: ++sends, frame, ...(cause === undefined ? {} : { cause }) }
    by.out.push(one)
    for (const to of ends) {
      const way = to.from.get(by)
      if (way) for (const queue of way.queues) queue.push(one)
    }
  }
  const handed = (to: End, frame: Frame, cause: string | undefined): void => {
    notes(to.name, 'was handed', frame, cause)
    if (to.ended) { breaks(`${to.name} was handed a frame after it ended`); return }
    to.heard++
    // Whoever could not have sent this is not who this end is talking to.
    for (const [by, way] of [...to.from]) {
      way.queues = each(way.queues.flatMap((queue) => taken(queue, frame, cause)))
      if (!way.queues.length) to.from.delete(by)
    }
    if (!to.from.size) breaks(`${to.name} was handed a frame that is not the next one any end sent it: ${said(frame, cause)}`)
  }
  const ended = (end: End, ending: Ending): void => {
    notes(end.name, 'ended', ending)
    if (end.ended) { breaks(`${end.name} ended twice`); return }
    // Whoever it could be talking to: an end that has nothing to do with it says nothing of why it ended.
    const others = [...end.from.keys()]
    if (DEFECTS.includes(ending.why) && !may.includes(ending.why)) breaks(`${end.name} ended ${ending.why}`)
    // A session is lost when one end of it is no longer the end it was: that end has gone.
    if (ending.why === 'lost' && !may.includes('lost') && !others.some((other) => other.ended)) breaks(`${end.name} ended lost, with every end still there`)
    if (ending.why === 'goodbye' && !others.some((other) => other.byes.includes(ending.bye))) breaks(`${end.name} ended with a goodbye nobody said: ${ending.bye}`)
    end.ended = ending
  }

  /**
   * Whether each end that was handed something can have been handed it by an end of its own, which was handed what
   * it was by nobody else. Given an end kept for another, whether it can with nobody else handed that end's frames.
   */
  const paired = (kept?: { readonly end: End; readonly by: End }): boolean => {
    const hearing = ends.filter((end) => end.heard)
    const match = (at: number, with_: Map<End, End>): boolean => {
      const end = hearing[at]
      if (!end) return true
      for (const by of end.from.keys()) {
        // Nobody else is handed its frames by that end, and that end is handed its own, if any, by this one.
        if ([...with_].some(([other, theirs]) => theirs === by && other !== end)) continue
        // An end kept for another is not this one's.
        if (kept && by === kept.by && end !== kept.end) continue
        if (by.heard && (with_.get(by) ?? end) !== end) continue
        if (by.heard && !by.from.has(end)) continue
        if (match(at + 1, new Map(with_).set(end, by))) return true
      }
      return false
    }
    return match(0, new Map())
  }

  return {
    end: <L extends Link>(link: L, name: string): L => {
      const end: End = { name, out: [], heard: 0, byes: [], from: new Map() }
      // An end made later may be the one an earlier end's frames reach: all of them, from the first.
      for (const other of ends) {
        end.from.set(other, { queues: [[...other.out]] })
        // An end that has been handed something is talking to whoever handed it that, and to nobody made since.
        if (!other.heard) other.from.set(end, { queues: [[]] })
      }
      ends.push(end)
      // As it was handed over, and not as it would cross again: what crossing would put right is looked at too.
      link.onFrame((frame, cause) => handed(end, frame, cause))
      link.onEnd((ending) => ended(end, ending))
      /** What each frame prepared was, as it crosses, and what caused it, until it is sent. */
      const prepared = new WeakMap<Prepared, { readonly frame: Frame; readonly cause?: string }>()
      const noted = (frame: Frame, cause: string | undefined): { readonly frame: Frame; readonly cause?: string } => ({ frame: crossed(frame), ...(cause === undefined ? {} : { cause }) })
      return {
        ...link,
        prepare: (frame, how) => {
          const token = link.prepare(frame, how)
          prepared.set(token, noted(frame, how?.cause))
          return token
        },
        send: ((what: Frame | Prepared, how?: Sending) => {
          // Noted as it was when it was sent, and only once the link has taken it: one refused was never sent, and
          // is refused by the link, as it refuses it. One the link ended on was not sent either.
          let one: { readonly frame: Frame; readonly cause?: string } | undefined
          if ('prepared' in what) {
            one = prepared.get(what)
            prepared.delete(what)
          } else try { one = noted(what, how?.cause) } catch { /* the link's to refuse */ }
          const was = end.ended
          if ('prepared' in what) link.send(what)
          else link.send(what, how)
          if (one && !was && !end.ended) sent(end, one.frame, one.cause)
        }) as Link['send'],
        close: (bye) => {
          if (bye && !end.ended) end.byes.push(bye)
          link.close(bye)
        },
      }
    },
    check: () => {
      if (broken) throw new Error(`Not what the model does: ${broken}`)
      if (!paired()) throw new Error(`Not what the model does: an end was handed frames by an end that was handed its own by another${led()}`)
      if (options.unfinished) return
      for (const end of ends) {
        if (end.ended) continue
        const there = [...end.from].filter(([by]) => !by.ended)
        if (there.length !== 1) continue
        const [by, way] = there[0]!
        // Whoever it is talking to, if it is somebody else, has gone.
        if (by.heard && !by.from.has(end)) continue
        // Or what it sent was all for another, which was handed it and has gone.
        if (!paired({ end, by })) continue
        const left = way.queues.reduce((least, queue) => (queue.length < least.length ? queue : least))
        if (left.length) throw new Error(`Not what the model does: at rest, ${end.name} has not been handed what ${by.name} sent it: ${left.map((one) => said(one.frame, one.cause)).join(', ')}`)
      }
    },
  }
}

/**
 * Runs what a scenario builds with a model to put its ends under, and returns its check with the model's after it:
 * `everyOrder((schedule) => underModel((held) => scenario.play(schedule, memoryEnds(schedule, {}, held))))`.
 */
export function underModel(play: (held: Model) => () => void, options: ModelOptions = {}): () => void {
  const held = model(options)
  const check = play(held)
  return () => { check(); held.check() }
}
