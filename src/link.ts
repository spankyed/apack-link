// One end of a link: frames out, frames in, each in the order it was sent.
//
// Every frame an end sends is numbered, one more than the last. The other end takes a frame only if it is the next
// one, so a frame lost, doubled or out of place is found where it arrives and the link is closed, saying why: a
// link that went on would be handing over frames in an order nobody sent them in.
//
// Beside frames, a link says a few things about itself: a hello first, and a goodbye when it goes on purpose.
// Those take no number. Only a frame is numbered.
//
// What an end says within one turn crosses as one text: a batch, `[hello?, ...said]`. A frame is put into text when
// it is sent, so one that cannot be is refused there alone, and the batch is those texts joined. The batch leaves
// when `later` says, a microtask unless given.
import type { Frame, Sent } from './frames.ts'
import type { Transport } from './transport.ts'

/** Which link this is. Both ends ship together, so there is one, and an end that says another is refused. */
export const LINK = 1

/** Why an end went on purpose: `restarting` is to be reached again, and `ended` is not. */
export type Bye = 'restarting' | 'ended'

/** Why a link closed. */
export type Ending =
  /** Either end closed it without saying more, or what carried it went. */
  | { readonly why: 'closed' }
  /** The other end said it was going, and which way. */
  | { readonly why: 'goodbye'; readonly bye: Bye }
  /** The other end is a link this one cannot talk to. */
  | { readonly why: 'version'; readonly mine: number; readonly theirs: number }
  | { readonly why: 'out of order'; readonly expected: number; readonly got: number }
  /** What arrived was not something a link says. `size` is the length of its text, which is all that is kept of it. */
  | { readonly why: 'not a frame'; readonly size: number }

export interface Link {
  /**
   * Sends a frame. Throws if the frame cannot be put into text, having sent nothing and taken no number: that one
   * frame is refused, and the link goes on. After the link has closed it sends nothing.
   */
  send(frame: Frame): void
  /** Called with each frame the other end sent, in the order it sent them. */
  onFrame(heard: (frame: Frame) => void): void
  /** Called once, when the link has closed, with why. */
  onEnd(ended: (ending: Ending) => void): void
  /**
   * Closes the link, once what was sent before has left. Given a goodbye, says it last, so the other end's ending
   * says which it was.
   */
  close(bye?: Bye): void
}

/** What an end says of itself. Each is a text of its own and takes no number. */
type Hello = { readonly link: number }
type Goodbye = { readonly bye: Bye }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export interface Options {
  /** What puts the batch off until the end of the turn. A microtask unless given; a spec gives a schedule's lane. */
  later?(run: () => void): void
}

export function link(transport: Transport, options: Options = {}): Link {
  const later = options.later ?? queueMicrotask
  let sent = 0
  let heard = 0
  /** Whether the other end has said hello. Nothing else is taken before it. */
  let met = false
  let ending: Ending | undefined
  const hears: Array<(frame: Frame) => void> = []
  const ends: Array<(ending: Ending) => void> = []
  /** What this end has said this turn, each already text, and whether it is to leave. */
  let batch: string[] = []
  let due = false
  const flush = (): void => {
    due = false
    if (!batch.length) return
    const text = `[${batch.join(',')}]`
    batch = []
    transport.send(text)
  }
  const say = (text: string): void => {
    batch.push(text)
    if (due) return
    due = true
    later(() => { if (!ending) flush() })
  }
  const end = (why: Ending): void => {
    if (ending) return
    ending = why
    transport.close()
    for (const ended of ends) ended(why)
  }
  transport.onClose(() => end({ why: 'closed' }))
  const decoder = new TextDecoder()
  transport.onData((message) => {
    if (ending) return
    const text = typeof message === 'string' ? message : decoder.decode(message)
    const unknown = (): void => end({ why: 'not a frame', size: text.length })
    let batch: unknown
    try { batch = JSON.parse(text) } catch { unknown(); return }
    if (!Array.isArray(batch) || !batch.length) { unknown(); return }
    for (const one of batch as unknown[]) {
      if (ending) return
      take(one, unknown)
    }
  })
  /** Takes one thing the other end said, in its turn. */
  const take = (arrived: unknown, unknown: () => void): void => {
    if (!isObject(arrived)) { unknown(); return }
    if (!met) {
      if (typeof arrived.link !== 'number') { unknown(); return }
      if (arrived.link !== LINK) { end({ why: 'version', mine: LINK, theirs: arrived.link }); return }
      met = true
      return
    }
    if (arrived.bye === 'restarting' || arrived.bye === 'ended') { end({ why: 'goodbye', bye: arrived.bye }); return }
    const { seq, frame } = arrived
    if (typeof seq !== 'number' || !isObject(frame) || typeof frame.kind !== 'string') { unknown(); return }
    if (seq !== heard + 1) { end({ why: 'out of order', expected: heard + 1, got: seq }); return }
    heard = seq
    for (const hear of hears) hear(frame as Frame)
  }
  say(JSON.stringify({ link: LINK } satisfies Hello))
  return {
    send: (frame) => {
      if (ending) return
      // Put into text before it is numbered: a frame that cannot be is refused alone, and leaves no gap behind it.
      const text = JSON.stringify({ seq: sent + 1, frame } satisfies Sent)
      sent++
      say(text)
    },
    onFrame: (hear) => { hears.push(hear) },
    onEnd: (ended) => { if (ending) ended(ending); else ends.push(ended) },
    close: (bye) => {
      if (ending) return
      // What was said before closing leaves before it closes, and a goodbye last.
      if (bye) batch.push(JSON.stringify({ bye } satisfies Goodbye))
      flush()
      end({ why: 'closed' })
    },
  }
}
