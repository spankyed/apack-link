// What crosses a link. One frame is one thing a system says to the other, and these are all there are: a link
// carries what states say to each other and nothing else, which is what lets it keep them in order.

/** A number one end chose, which names an ask or a view for as long as it lasts. Each end numbers its own. */
export type Id = number

export type Frame =
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

/** Why an ask failed or a view ended: a kind to act on and a message to read. */
export interface Failure { readonly kind: string; readonly message: string }

/** A frame as it is on the wire: with its place in everything this end has sent. */
export interface Sent {
  /** One more than the frame before it from this end, from 1. */
  readonly seq: number
  readonly frame: Frame
  /** What caused it: a short text the kernel makes, passed on and never read. */
  readonly cause?: string
  /** A tap at either end is told only that it crossed, and its size. */
  readonly private?: true
}

const isId = (value: unknown): value is Id => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const isText = (value: unknown): value is string => typeof value === 'string'

/**
 * What arrived, as a frame, or nothing when it is not one of the frames there are. An id is a whole number from 1,
 * a name is text, and a failure is a kind and a message, both text. What a frame carries for a system (`event`,
 * `args`, `update`, `outcome`) is the system's, and is not looked at. Only what a frame has is handed on: anything
 * else on what arrived is left behind.
 */
export function asFrame(arrived: unknown): Frame | undefined {
  if (typeof arrived !== 'object' || arrived === null || Array.isArray(arrived)) return undefined
  const { kind, id, to, name, feature, view, failure } = arrived as Record<string, unknown>
  const carried = arrived as { readonly event?: unknown; readonly args?: unknown; readonly update?: unknown; readonly outcome?: unknown }
  if (kind === 'tell') return isText(to) ? { kind, to, event: carried.event } : undefined
  if (!isId(id)) return undefined
  switch (kind) {
    case 'ask': return isText(to) && isText(name) ? { kind, id, to, name, args: carried.args } : undefined
    case 'left': return { kind, id }
    case 'progress': return { kind, id, update: carried.update }
    case 'answer': return { kind, id, outcome: carried.outcome }
    case 'follow': return isText(feature) && isText(view) ? { kind, id, feature, view, args: carried.args } : undefined
    case 'shown': return { kind, id, update: carried.update }
    case 'unfollow': return { kind, id }
    case 'over': {
      if (typeof failure !== 'object' || failure === null || Array.isArray(failure)) return undefined
      const { kind: why, message } = failure as Record<string, unknown>
      return isText(why) && isText(message) ? { kind, id, failure: { kind: why, message } } : undefined
    }
    default: return undefined
  }
}

/**
 * How many bytes a text is as UTF-8, which is how it crosses: the one unit a link counts sizes in, and the one a
 * transport says what it has not written in.
 */
export function bytesOf(text: string): number {
  let bytes = text.length
  for (let at = 0; at < text.length; at++) {
    const unit = text.charCodeAt(at)
    if (unit < 0x80) continue
    if (unit < 0x800) { bytes += 1; continue }
    // Two units that make one character are four bytes between them; any other unit is three.
    const pair = unit >= 0xd800 && unit <= 0xdbff && (text.charCodeAt(at + 1) & 0xfc00) === 0xdc00
    bytes += 2
    if (pair) at++
  }
  return bytes
}
