// What one end of a link does, with nothing done: given what an end holds and one thing that happened, what it
// holds after and what is to be done about it. Nothing here sends, closes, waits or calls anybody. `link.ts` does
// those, on what it is handed, and tells this what happened.
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
// handed in (JSON unless given). The batch leaves at the end of the turn, as more than one message where it is
// longer than a part. A frame longer than a part crosses as parts, each numbered, one after another, and is handed
// over whole once the last has arrived.
//
// A link outlives what carries it. Each end keeps what it has sent until the other says it took it. A new
// connection's hellos say where each end got to and which session each believes it is going on with, each sends
// again what the other has not taken, in order, and goes on; since a frame is taken only in turn, nothing is taken
// twice, and a resume can pick up within a frame in parts. A link that can come back numbers nothing until it has
// met the other end, so an end that has met nobody has sent nothing anybody could have taken, and starts afresh
// with whoever it meets. An end that dials and opens its connections opens another when one closes, when its clock
// says; one that listens is handed each. Neither is given a time to wait for the other end in: whoever holds
// a link says when the other end is gone, by closing it.
//
// What is kept is bounded. How far behind the other end is, is what it has not said it took: past a mark, a link
// stops numbering, and what is sent waits unnumbered, where a view's result that a later one has overtaken can be
// let go. What waits is bounded too, and past it, with nothing left to let go, the link ends `overrun`. One frame
// is bounded as well, and one past it is refused where it is sent. Every size is in bytes, of text as UTF-8.
//
// What carries a link may take no message longer than it says (`most`), and each end says in its hello the
// longest it takes. A batch that would be longer than either crosses as more than one, cut between frames, in
// order, and a frame longer than fits crosses in parts. A link is not carried on what takes less than `LEAST`,
// and a hello does not fit on a connection that takes less than something still kept that it does not say was
// taken, whether it is the transport that takes less or the other end.
//
// The two ends are not alike. The one that dials opened the connection: it says hello first on it, and ends for
// what it meets there. The one that listens says nothing on a connection, and keeps the one it has, until whoever
// is on the new one has said a hello that fits. One that does not is turned away, told why where it would
// otherwise wait, and the end goes on: it is on no connection where nobody has been met, and ends for nothing
// said before a hello that fits.
//
// What carries a link saying it closed is the first word that the other end has gone. For a connection that can go
// quiet without closing, a link given a window watches while it is owed something, a `taken` or an answer: quiet
// for half the window, it asks whether the other end is there; quiet for the whole of it, with nothing of any kind
// arriving, it closes the connection, to be opened again. Nothing is given a time to answer in.
//
// What an end holds is plain values, changed in place by `step`: whoever wants it as it was copies it first. Each
// connection and each thing put on a clock is a number, which whoever does what is to be done gives meaning to.
// What is to be done is done in the order it is given, after the step that gave it: a step is whole before
// anything it asks for happens. A frame handed over is always the last thing a step asks for, so that whatever a
// listener does in answer comes before anything more of the same message is taken.
import { head, joined, json, lengthOf, sizeOf, slice, type Codec } from './codec.ts'
import { asFrame, type Frame } from './frames.ts'
import type { Message } from './transport.ts'

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
   * The connection takes no message as long as this end needs: the longest the other end said it takes, or what
   * carries it does where that is less, and how many bytes this end needs. That is what any link needs (`LEAST`), or, where this end keeps something it numbered for a
   * connection that took longer messages, as many bytes as that is.
   */
  | { readonly why: 'too narrow'; readonly most: number; readonly needs: number }

/** How much: a count of frames, and how many bytes they are encoded, text as UTF-8. */
export interface Size { readonly frames: number; readonly size: number }

/**
 * How a frame is sent: what caused it, a short text the kernel makes and a link never reads, 1024 bytes at most as
 * it crosses; and whether it is private.
 */
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

/** What an end says of itself. None takes a number. */
/**
 * `resumes` is the other end's session, from an end that has met it: absent, this end has met nobody. `most` is
 * the longest message, in bytes, this end takes on this connection: absent, any.
 */
export type Hello = { readonly link: number; readonly session: string; readonly taken: number; readonly resumes?: string; readonly most?: number }
type Taken = { readonly taken: number }
type Goodbye = { readonly bye: Bye }
export type Lost = { readonly lost: true }
/** Whether the other end is there, and that it is. */
type There = { readonly there: number }
type Here = { readonly here: number }

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !ArrayBuffer.isView(value)
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
/** Whether what arrived is a hello of this link's number, as far as its shape goes. */
export const isHello = (said: unknown): said is Hello => isObject(said) && said.link === LINK && typeof said.session === 'string' && isCount(said.taken)
  && (said.resumes === undefined || typeof said.resumes === 'string') && (said.most === undefined || (isCount(said.most) && said.most > 0))

/**
 * The first thing a message says, where it is a list of things said, as every message of a link's is. What is not
 * one says nothing: what it holds under a name is not something said.
 */
export const firstOf = (codec: Codec, message: Message): unknown => {
  try {
    const said = codec.decode(message)
    return Array.isArray(said) ? (said as unknown[])[0] : undefined
  } catch { return undefined }
}

/** A link a little behind sends at once; one far behind lets a view's results be overtaken; one past it ends. */
const KEPT: Size = { frames: 1024, size: 16 * 1024 * 1024 }
const WAITING: Size = { frames: 16384, size: 64 * 1024 * 1024 }
/** How many bytes one frame and its cause may be, unless given. */
const FRAME = 64 * 1024 * 1024
/** The least `bound.frame` may be: more than anything a peer says in place of what could not be sent. */
const SMALLEST = 1024
/**
 * How many bytes a codec puts around a frame or a part of one where a link numbers it, beside the frame and what
 * caused it, at the most: around a first part that is private and has a cause, which has every name there is, with
 * each of its three numbers the longest a count is.
 */
export function around(codec: Codec): number {
  const count = codec.encode(Number.MAX_SAFE_INTEGER)
  const none = codec.encode('')
  return sizeOf(codec.record([['seq', count], ['part', count], ['of', count], ['data', none], ['cause', none], ['private', codec.encode(true)]])) - 2 * sizeOf(none)
}
/**
 * What may be around a frame or a part of one: what JSON puts there at the most, 102 bytes, which is
 * `{"seq":,"part":,"of":,"data":,"cause":,"private":true}` and three numbers of sixteen digits. A link counts on
 * no more, so that what it cuts to fit does fit, and an end is not set with a codec that puts more.
 */
const AROUND = around(json)
/** The least a part may be: more than any one character is as a part's data, so that a frame can always be cut to it. */
const SHORTEST = 16
/** How many bytes a part may have to spare and be taken as full: a character or two. */
const SPARE = 8
/** How many times a piece of a frame is tried as a part's data before the longest found to fit is taken. */
const TRIES = 6
/** How many bytes what caused a frame may be, as it crosses: it is a short text, and it crosses whole beside a frame or its first part. */
const CAUSE = 1024
/**
 * The shortest message a link is carried on at all: one that holds the shortest part there is, the longest cause
 * there may be beside it, what is put around them, and the batch's own two. On anything that takes this, and on
 * an end that says it does, a link cuts what it sends to fit.
 */
export const LEAST = SHORTEST + CAUSE + AROUND + 2

/** How long a link waits to open a connection after the first that did not hold, and the most it waits. */
const REOPEN_FIRST = 100
const REOPEN_MOST = 10_000
const PART = 1024 * 1024

/**
 * How an end is set, for as long as it lasts. `role` is which of the two it is: the one that `dials` says hello
 * first on a connection and ends for what it meets there, and the one that `listens` says nothing on a connection
 * until a hello that fits has arrived on it, and ends for nothing said before one. `connections` is how it comes
 * by them: `one` is carried on one alone and ends with it, `opened` opens each itself, which only an end that
 * dials does, and `handed` is handed each, which only an end that listens is.
 */
export interface Setup {
  readonly role: 'dials' | 'listens'
  readonly connections: 'one' | 'opened' | 'handed'
  /** This end's session: a text no other end has. */
  readonly session: string
  readonly codec: Codec
  /** How many bytes a part may be at most: it is shorter where what carries the link, or the other end, takes less. */
  readonly part: number
  /** How much sent and not yet taken there may be before nothing more is numbered. */
  readonly mark: Size
  /** How much may wait to be numbered. */
  readonly bound: Size
  /** How many bytes one frame and its cause may be. */
  readonly largest: number
  /** How long a connection may be quiet while this end is owed something, where it is watched. */
  readonly window?: number
  /** The wait before a connection is opened after the first that did not hold, and the most it is. */
  readonly first: number
  readonly most: number
}

/** What `setup` is given: all but `role`, `connections` and `session` are something unless given. */
export interface Given {
  readonly role: Setup['role']
  readonly connections: Setup['connections']
  readonly session: string
  readonly codec?: Codec
  readonly part?: number
  readonly bound?: { readonly kept?: Partial<Size>; readonly waiting?: Partial<Size>; readonly frame?: number }
  readonly window?: number
  readonly first?: number
  readonly most?: number
}

/**
 * What an end's sizes come to, or a `RangeError` for ones no end is set with: how large a frame may be, and how
 * long a part at most.
 */
export function limits(given: Pick<Given, 'bound' | 'part' | 'window' | 'first' | 'most'>): { readonly largest: number; readonly part: number } {
  const part = given.part ?? PART
  if (!(part >= SHORTEST)) throw new RangeError(`part is ${SHORTEST} bytes at least`)
  const largest = given.bound?.frame ?? FRAME
  // Less would refuse what a peer says in place of something that could not be sent, and leave an ask unanswered.
  if (!(largest >= SMALLEST)) throw new RangeError(`bound.frame is ${SMALLEST} bytes at least`)
  const kept = given.bound?.kept
  if (kept?.frames !== undefined && !(kept.frames >= 1)) throw new RangeError('bound.kept.frames is 1 at least')
  if (kept?.size !== undefined && !(kept.size >= 1)) throw new RangeError('bound.kept.size is 1 byte at least')
  const waiting = given.bound?.waiting
  if (waiting?.frames !== undefined && !(waiting.frames >= 0)) throw new RangeError('bound.waiting.frames is 0 at least')
  if (waiting?.size !== undefined && !(waiting.size >= 0)) throw new RangeError('bound.waiting.size is 0 bytes at least')
  if (given.window !== undefined && (!(given.window > 0) || !Number.isFinite(given.window))) throw new RangeError('there.window is a finite number more than 0')
  if (given.first !== undefined && (!(given.first >= 0) || !Number.isFinite(given.first))) throw new RangeError('reopen.first is a finite number, 0 at least')
  if (given.most !== undefined && (!(given.most >= 0) || !Number.isFinite(given.most))) throw new RangeError('reopen.most is a finite number, 0 at least')
  return { largest, part }
}

/**
 * How an end is set, from what it was given. Throws what `limits` does, and a `TypeError` for an end that dials
 * and is handed its connections, or listens and opens them: whoever opens a connection is the one that dials on it.
 * A `TypeError` too for a codec that puts more around a frame than a link counts on.
 */
export function setup(given: Given): Setup {
  const { largest, part } = limits(given)
  if (given.codec && around(given.codec) > AROUND) throw new TypeError(`A codec puts ${AROUND} bytes at most around a frame, as JSON does`)
  if (given.connections === (given.role === 'dials' ? 'handed' : 'opened')) throw new TypeError(`An end that ${given.role} is not ${given.connections} its connections`)
  return {
    role: given.role,
    connections: given.connections,
    session: given.session,
    codec: given.codec ?? json,
    part,
    mark: { ...KEPT, ...given.bound?.kept },
    bound: { ...WAITING, ...given.bound?.waiting },
    largest,
    ...(given.window === undefined ? {} : { window: given.window }),
    first: given.first ?? REOPEN_FIRST,
    most: given.most ?? REOPEN_MOST,
  }
}

/**
 * The shortest message an end can go on being carried on, as it stands: what any link needs, and no less than the
 * longest thing it numbered and still keeps past `after`, with the batch's own two. What is kept is sent again as
 * it was, so a connection that takes less than it was cut for cannot carry it.
 */
export function narrowest(state: State, after = 0): number {
  let longest = 0
  for (const one of state.kept) if (one.seq > after && one.size > longest) longest = one.size
  return Math.max(LEAST, longest + 2)
}

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

/** A frame encoded, with what is told of it and, for a view's result, which view. `size` includes its cause. */
export interface Ready { encoded: Message; size: number; causeSize: number; about: About; readonly view?: number }

/**
 * A frame encoded, and how many bytes that is with its cause. Throws for one that cannot be sent: a `TypeError` for
 * one that cannot be encoded, and a `RangeError` for one larger, with its cause, than a frame may be. Nothing thrown
 * says what the frame holds: what a codec says of a value names its keys.
 */
export function ready(set: Setup, frame: Frame, how: Sending): Ready {
  let encoded: Message
  try { encoded = set.codec.encode(frame) } catch { throw new TypeError('A frame could not be put into text') }
  const frameSize = sizeOf(encoded)
  const causeSize = how.cause === undefined ? 0 : sizeOf(set.codec.encode(how.cause))
  if (causeSize > CAUSE) throw new RangeError('What caused a frame is longer than may be said')
  const size = frameSize + causeSize
  if (size > set.largest) throw new RangeError('A frame is larger than may be sent')
  return { encoded, size, causeSize, about: aboutOf(frame, how), ...(frame.kind === 'shown' ? { view: frame.id } : {}) }
}

/** The connection an end is on, with what is said on it this turn. */
export interface Connection {
  readonly id: number
  /** The longest message what carries it takes, where it says. */
  readonly most?: number
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
  /** Whether the end of the turn has been asked for. */
  due: boolean
}

/** Everything an end holds. */
export interface State {
  /** The other end's session, once it has said it. A connection from another is not this link's. */
  theirs?: string
  sent: number
  heard: number
  /** The last number the other end said it took: what was sent up to it is no longer kept. */
  released: number
  /** What was sent and not yet taken, as it is on the wire, oldest first, and the size of all of it. */
  kept: Array<{ readonly seq: number; readonly encoded: Message; readonly size: number }>
  keptSize: number
  /** What was sent and waits to be numbered, each frame encoded, oldest first, and the size of all of it. */
  waiting: Ready[]
  waitingSize: number
  /** For each view with a result waiting, that result: a later one takes its place. */
  showing: Map<number, Ready>
  /** The parts of a frame arriving in parts, so far, and how many bytes they were as they crossed. */
  parting?: { readonly first: number; readonly of: number; readonly pieces: Message[]; bytes: number; size?: number; readonly cause?: string; readonly private: boolean }
  ending?: Ending
  /** How many connections in a row have gone without having held. */
  failed: number
  /** How many things this end is owed beside a `taken`. */
  owed: number
  /** How many times it has asked whether the other end is there. */
  asked: number
  /** Whether anybody is told of frames crossing: what one is as it crosses is only measured for that. */
  tapped: boolean
  now?: Connection
  /** A connection handed over while the end is on one where the other end has been met: not yet heard to fit. */
  pending?: { readonly id: number; readonly most?: number }
  /** What is on a clock, each by its number: the next connection being opened, */
  reopening?: number
  /** finding that the connection this end is on has held, */
  holding?: number
  /** and the watch on a quiet connection: which connection, and whether it has been asked if it is there. */
  watching?: { readonly timer: number; readonly on: number; readonly asked: boolean }
  /** The last number given to something put on a clock. */
  timers: number
  /** Each message being taken, the last begun last: what it held, how far it has been taken, the message, and cached entry sizes when tapped. */
  taking: Array<{ readonly on: number; readonly said: readonly unknown[]; at: number; readonly message: Message; sizes?: readonly number[] }>
}

/** What an end holds before anything has happened. */
export function start(): State {
  return { sent: 0, heard: 0, released: 0, kept: [], keptSize: 0, waiting: [], waitingSize: 0, showing: new Map(), failed: 0, owed: 0, asked: 0, tapped: false, timers: 0, taking: [] }
}

/**
 * One thing that happened to an end. `backlog` is how many bytes what carries the connection concerned says it
 * has not yet written: the connection the end is on, or for `data` the one it arrived on.
 */
export type Event =
  /** A frame, encoded, is sent. */
  | { readonly is: 'send'; readonly one: Ready; readonly backlog: number }
  /** The end is closed by whoever holds it. */
  | { readonly is: 'close'; readonly bye?: Bye }
  /** A connection is handed over. */
  | { readonly is: 'carry'; readonly on: number; readonly most?: number }
  /** A message arrived on a connection. */
  | { readonly is: 'data'; readonly on: number; readonly message: Message; readonly backlog: number }
  /** What the last frame handed over was handed to has been called: the rest of its message is taken. */
  | { readonly is: 'more'; readonly backlog: number }
  /** A connection closed. */
  | { readonly is: 'closed'; readonly on: number }
  /** What carries a connection threw where it was handed something to send. */
  | { readonly is: 'broke'; readonly on: number }
  /** The turn in which something was said on a connection is over. */
  | { readonly is: 'turn'; readonly on: number }
  /** What was put on a clock is due. */
  | { readonly is: 'due'; readonly timer: number }
  /** A connection that was to be opened could not be. */
  | { readonly is: 'unopened' }
  /** The end is owed something by the other, and is owed it no longer. */
  | { readonly is: 'owed' }
  | { readonly is: 'settled' }
  /** Somebody is to be told of frames crossing, and nobody is any longer. */
  | { readonly is: 'tapped' }
  | { readonly is: 'untapped' }

/** One thing to be done about what happened. */
export type Effect =
  /** Send these on a connection, in order. If it throws, the end is told the connection `broke`. */
  | { readonly do: 'write'; readonly on: number; readonly messages: readonly Message[] }
  /** Close a connection. What closing throws is reported or let go, as `thrown` says: it never stops what follows. */
  | { readonly do: 'close'; readonly on: number; readonly thrown: 'reported' | 'let go' }
  /** Turn a connection away: send it this, if anything, and close it, and whatever either throws is let go. */
  | { readonly do: 'away'; readonly on: number; readonly message?: Message }
  /** Say when this turn is over, for a connection. */
  | { readonly do: 'later'; readonly on: number }
  /** Put something on a clock: the one connections are opened on, or the one a quiet connection is watched on. */
  | { readonly do: 'after'; readonly timer: number; readonly ms: number; readonly clock: 'reopen' | 'there' }
  /** Call off what was put on a clock. */
  | { readonly do: 'off'; readonly timer: number }
  /** Open a connection and hand it over. If that throws, the end is told it was `unopened`. */
  | { readonly do: 'open' }
  /** Hand a frame over, having told whoever is told of frames crossing. */
  | { readonly do: 'hand'; readonly frame: Frame; readonly cause?: string; readonly traffic?: Traffic }
  /** Tell whoever is told of frames crossing. */
  | { readonly do: 'traffic'; readonly traffic: Traffic }
  /** Say the link has closed, and why. */
  | { readonly do: 'ended'; readonly ending: Ending }

/** Why a first thing said on a connection does not fit an end as it stands. */
type Unfit =
  | { readonly no: 'not a frame' }
  | { readonly no: 'version'; readonly theirs: number }
  | { readonly no: 'lost' }
  | { readonly no: 'too narrow'; readonly most: number; readonly needs: number }

/**
 * What an end set this way does. What comes back takes what an end holds and one thing that happened, changes
 * what it holds, and returns what is to be done, in order.
 */
export function core(set: Setup): (state: State, event: Event) => Effect[] {
  const { codec, part, mark, bound, largest, session: mine } = set
  const dials = set.role === 'dials'
  const once = set.connections === 'one'
  const opens = set.connections === 'opened'
  /** What the step under way was handed, and what it has asked for so far. */
  let s!: State
  let out!: Effect[]
  let backlog = 0
  /** The message being taken, for saying how large something that was not a frame was. */
  let arriving: Message = ''

  /** What a link says of itself, encoded. These are its own values, which a codec can always hold. */
  const word = (value: Hello | Taken | Goodbye | Lost | There | Here): Message => codec.encode(value)
  /** How long the wait is before a connection is opened, after that many in a row that did not hold. */
  const wait = (after: number): number => (after ? Math.min(set.most, set.first * 2 ** (after - 1)) : 0)
  const after = (ms: number, clock: 'reopen' | 'there'): number => {
    const timer = ++s.timers
    out.push({ do: 'after', timer, ms, clock })
    return timer
  }
  const off = (timer: number | undefined): void => { if (timer !== undefined) out.push({ do: 'off', timer }) }

  /** Has the next connection of an end that opens its own opened, when its clock says. */
  const reopen = (): void => { s.reopening = after(wait(s.failed), 'reopen') }
  /** A connection has gone: an end that does not come back ends, and one that opens its own opens another. */
  const dropped = (on: Connection): void => {
    if (s.now !== on) return
    delete s.now
    off(s.holding)
    delete s.holding
    // Nothing is watched on a connection that has gone.
    off(s.watching?.timer)
    delete s.watching
    if (s.ending) return
    if (once) { end({ why: 'closed' }); return }
    s.failed = on.held ? 0 : s.failed + 1
    if (opens) reopen()
  }
  /** Puts something in what is said on a connection this turn. */
  const put = (on: Connection, encoded: Message, size = sizeOf(encoded)): void => { on.batch.push(encoded); on.sizes.push(size) }

  const flush = (on: Connection): void => {
    on.due = false
    if (s.ending || s.now !== on) return
    if (!on.batch.length && !(on.met && s.heard > on.told)) return
    // What this end has taken goes with it, when there is more to say of it: last, behind a hello if there is one.
    if (on.met && s.heard > on.told) { put(on, word({ taken: s.heard })); on.told = s.heard }
    const { batch, sizes } = on
    on.batch = []
    on.sizes = []
    // One message, unless it would be longer than a part, or than what carries it or the other end takes: then as
    // few as it takes, cut between what was said, in order, so that no one write is much longer than a part. A
    // list of `n` things is no more than their bytes, one between each two, and two more. One thing longer than a
    // part by itself, a part with what goes around it, is a message of its own: it fits what carries the link,
    // which is on nothing too narrow for what it may send.
    const most = Math.min(on.most ?? Infinity, on.takes, part)
    const messages: Message[] = []
    let from = 0
    let bytes = 2
    for (let at = 0; at < batch.length; at++) {
      const size = sizes[at]!
      if (at > from && bytes + 1 + size > most) {
        messages.push(codec.list(batch.slice(from, at)))
        from = at
        bytes = 2
      }
      bytes += size + (at > from ? 1 : 0)
    }
    messages.push(codec.list(from ? batch.slice(from) : batch))
    // What cannot send these is a connection that has gone. Every frame in the batch is kept, and is sent again on
    // the next.
    out.push({ do: 'write', on: on.id, messages })
  }
  const say = (on: Connection, encoded: Message, size?: number): void => {
    put(on, encoded, size)
    turn(on)
  }
  /** Has a connection's batch leave at the end of this turn, if it is not to already. */
  const turn = (on: Connection): void => {
    if (on.due) return
    on.due = true
    out.push({ do: 'later', on: on.id })
  }

  const end = (why: Ending): void => {
    if (s.ending) return
    s.ending = why
    off(s.watching?.timer)
    delete s.watching
    off(s.reopening)
    delete s.reopening
    off(s.holding)
    delete s.holding
    s.kept = []
    s.keptSize = 0
    s.waiting = []
    s.waitingSize = 0
    s.showing.clear()
    delete s.parting
    const was = s.now
    delete s.now
    const waited = s.pending
    delete s.pending
    if (waited) out.push({ do: 'close', on: waited.id, thrown: 'reported' })
    if (was) out.push({ do: 'close', on: was.id, thrown: 'reported' })
    out.push({ do: 'ended', ending: why })
  }
  /** Stops watching a quiet connection once this end is owed nothing. */
  const unwatch = (): void => {
    if (s.kept.length || s.owed) return
    off(s.watching?.timer)
    delete s.watching
  }
  /**
   * Lets go of what the other end says it took. A number past what was sent is not one it could have taken, and one
   * before what it said last asks for what is no longer kept.
   */
  const letGo = (taken: number): boolean => {
    if (taken > s.sent || taken < s.released) return false
    s.released = taken
    let first = 0
    while (first < s.kept.length && s.kept[first]!.seq <= taken) s.keptSize -= s.kept[first++]!.size
    if (first) s.kept = s.kept.slice(first)
    return true
  }

  /** Whether what is sent now can be numbered: there is a connection, and the other end is not too far behind. */
  const roomy = (): boolean => !!s.now?.live && s.kept.length < mark.frames && s.keptSize < mark.size && backlog < mark.size
  /** Numbers one unit and puts it in this turn's batch. Joining what is encoded cannot fail, nor can encoding a number or a text. */
  const unit = (fields: Array<readonly [string, Message]>, about: About, first: boolean): number => {
    s.sent++
    if (first) {
      if (about.cause !== undefined) fields.push(['cause', codec.encode(about.cause)])
      if (about.private) fields.push(['private', codec.encode(true)])
    }
    const encoded = codec.record([['seq', codec.encode(s.sent)], ...fields])
    const size = sizeOf(encoded)
    s.kept.push({ seq: s.sent, encoded, size })
    s.keptSize += size
    say(s.now!, encoded, size)
    return size
  }
  /**
   * A frame's encoding as the data of its parts, in order, each no longer as it crosses than there is room for,
   * the first having `first` bytes and each after it `after`, and none but the last more than a character or two
   * shorter. A piece of the encoding may be longer as data than it was (text
   * in JSON has two around it, and each quote in it said in two), and by how much is the codec's to know. So a
   * piece is tried, and tried again shorter by as much as it was too long, or longer by as much as it had to
   * spare, between the longest found to fit and the shortest found not to, until what is to spare is next to
   * nothing or there is nothing between the two; and six times at most, after which the longest found to fit is
   * taken, so that no frame, whatever it holds, is encoded more than a few times over to be cut.
   */
  const partsOf = (encoded: Message, first: number, after: number): Message[] => {
    const all: Message[] = []
    let rest = encoded
    while (lengthOf(rest)) {
      const part = all.length ? after : first
      let fits: { readonly want: number; readonly taken: number; readonly data: Message } | undefined
      let over = Infinity
      let overs = 0
      let want = part
      for (let tries = 1; ; tries++) {
        const taken = head(rest, want)
        const data = codec.encode(slice(rest, 0, taken))
        const size = sizeOf(data)
        let grown: number
        if (size <= part) {
          fits = { want, taken, data }
          if (part - size < SPARE || taken === lengthOf(rest) || want + 1 >= over) break
          grown = Math.min(over - 1, want + Math.max(1, Math.floor((part - size) * want / size)))
        } else {
          over = want
          // One character is taken however long it is as data: a part is long enough for any one.
          if (want <= 1) { fits = { want, taken, data }; break }
          if (fits && fits.want + 1 >= over) break
          // Shorter in proportion to how much too long it was, which is right where all of it grows alike as data.
          // Where that was still too long, shorter by every byte it was too long by: no byte is less than one as
          // data, so that fits.
          overs++
          const shorter = Math.min(want - 1, overs === 1 ? Math.floor(want * part / size) : want - (size - part))
          grown = Math.max(fits ? fits.want + 1 : 1, shorter)
        }
        // Tried often enough, the longest found to fit is taken as it is: the work stays in proportion to the frame.
        if (fits && tries >= TRIES) break
        want = grown
      }
      all.push(fits.data)
      rest = slice(rest, fits.taken)
    }
    return all
  }
  /**
   * Numbers a frame, in parts if it is longer than a part or than the connection has room for, each in turn. The
   * room is what the transport and the other end take, less what is put around a thing numbered and the batch's
   * two; what caused the frame crosses beside it, or beside its first part, and has its share of that.
   */
  const number = (encoded: Message, size: number, causeSize: number, about: About): void => {
    const first = s.sent + 1
    const on = s.now!
    const room = Math.min(on.most ?? Infinity, on.takes) - AROUND - 2
    const frameSize = size - causeSize
    let crossing = 0
    if (frameSize <= Math.min(part, room - causeSize)) crossing = unit([['frame', encoded]], about, true)
    else {
      const pieces = partsOf(encoded, Math.min(part, room - causeSize), Math.min(part, room))
      pieces.forEach((data, at) => { crossing += unit([['part', codec.encode(at)], ['of', codec.encode(pieces.length)], ['data', data]], about, at === 0) })
    }
    if (s.tapped) out.push({ do: 'traffic', traffic: seen('out', first, crossing, about) })
    watch(false)
  }

  /**
   * Watches a quiet connection while this end is owed something. `again` starts the window over, as anything
   * arriving does; without it, a watch already running goes on.
   */
  const watch = (again: boolean): void => {
    if (set.window === undefined) return
    if (s.watching && !again) return
    off(s.watching?.timer)
    delete s.watching
    const on = s.now
    if (s.ending || !on?.met || (!s.kept.length && !s.owed)) return
    s.watching = { timer: after(set.window / 2, 'there'), on: on.id, asked: false }
  }
  /** A watch's time is up: half the window in, the other end is asked; the whole of it in, the connection is let go. */
  const quiet = (): void => {
    const { on, asked } = s.watching!
    delete s.watching
    const now = s.now
    if (now?.id !== on || s.ending) return
    if (asked) {
      // Nothing of any kind arrived for the whole window: this connection is let go, and another is made.
      out.push({ do: 'close', on, thrown: 'reported' })
      return
    }
    s.asked++
    say(now, word({ there: s.asked }))
    const half = set.window! / 2
    s.watching = { timer: after(set.window! - half, 'there'), on, asked: true }
  }
  /** Numbers what waits, oldest first, for as long as `keep()` holds. Drains in one pass so large backlogs stay linear. */
  const drain = (keep: () => boolean): void => {
    let taken = 0
    while (taken < s.waiting.length && keep()) {
      const one = s.waiting[taken++]!
      s.waitingSize -= one.size
      if (one.view !== undefined && s.showing.get(one.view) === one) s.showing.delete(one.view)
      number(one.encoded, one.size, one.causeSize, one.about)
    }
    if (taken) s.waiting = taken === s.waiting.length ? [] : s.waiting.slice(taken)
  }
  /** Numbers what waits, oldest first, for as long as there is room. */
  const pump = (): void => { drain(() => !s.ending && roomy()) }

  /**
   * What the first thing said on a connection is, to this end as it stands: a hello that fits, or why not. What
   * each end has is not what the other thinks when the hello is from another session than the one this end was
   * talking to; from an end going on with a session that is not this one; from an end that has met nobody and
   * says it took something; or from one that took what was never sent to it, or wants what it said before it had
   * taken. Otherwise what it has not taken is all still kept: numbering stops at the bound, so nothing is let go
   * before it is taken. An end that has met nobody has numbered nothing, so the two start afresh.
   */
  const greeting = (arrived: unknown, local?: number): Hello | Unfit => {
    if (!isObject(arrived) || typeof arrived.link !== 'number') return { no: 'not a frame' }
    if (arrived.link !== LINK) return { no: 'version', theirs: arrived.link }
    if (!isHello(arrived)) return { no: 'not a frame' }
    const { session, taken, resumes, most } = arrived
    if (s.theirs !== undefined && session !== s.theirs) return { no: 'lost' }
    if (resumes !== undefined && resumes !== mine) return { no: 'lost' }
    if (resumes === undefined && taken !== 0) return { no: 'lost' }
    if (taken > s.sent || taken < s.released) return { no: 'lost' }
    const needs = narrowest(s, taken)
    const limit = Math.min(most ?? Infinity, local ?? Infinity)
    if (limit < needs) return { no: 'too narrow', most: limit, needs }
    return arrived
  }
  /** This end's hello on a connection that takes messages of `most` bytes, where it says. */
  const hello = (most: number | undefined): Message => word({
    link: LINK, session: mine, taken: s.heard,
    ...(s.theirs === undefined ? {} : { resumes: s.theirs }),
    ...(most === undefined ? {} : { most }),
  })
  /** Whether whoever said something that does not fit is told the session is lost: one that would otherwise wait on it. */
  const toldLost = (unfit: Unfit): boolean => unfit.no === 'lost' || unfit.no === 'too narrow'
  /**
   * The first thing the other end said on a connection this end dialled does not fit: the link ends, saying why.
   * An end that listens is never here: it is on no connection before a hello that fits.
   */
  const refuse = (on: Connection, unfit: Unfit): void => {
    if (unfit.no === 'too narrow') {
      // What was numbered this turn, before the other end said how little the connection takes, was cut for more:
      // it is not said, and the link is ending. What else waits to be said on the connection is this end's hello,
      // and that is said, with that the session is lost, in messages no longer than is taken.
      const numbered = new Set(s.kept.map((one) => one.encoded))
      const said = on.batch.map((encoded, at) => [encoded, on.sizes[at]!] as const).filter(([encoded]) => !numbered.has(encoded))
      on.batch = said.map(([encoded]) => encoded)
      on.sizes = said.map(([, size]) => size)
      on.takes = unfit.most
      put(on, word({ lost: true }))
      flush(on)
      end({ why: 'too narrow', most: unfit.most, needs: unfit.needs })
      return
    }
    if (unfit.no === 'lost') { put(on, word({ lost: true })); flush(on); end({ why: 'lost' }); return }
    if (unfit.no === 'version') { end({ why: 'version', mine: LINK, theirs: unfit.theirs }); return }
    unknown()
  }
  const unknown = (): void => { end({ why: 'not a frame', size: sizeOf(arriving) }) }

  /** Takes one thing said on the connection this end is on. Whether a frame was handed over for it. */
  const take = (on: Connection, arrived: unknown, measure: () => number | undefined): boolean => {
    if (!on.met) {
      const fits = greeting(arrived, on.most)
      if ('no' in fits) { refuse(on, fits); return false }
      letGo(fits.taken)
      s.theirs = fits.session
      on.takes = fits.most ?? Infinity
      on.met = true
      // It has held once it has stayed up from here for as long as the wait before it, and for the first wait at
      // least: one that goes sooner is one more that did not.
      if (opens) s.holding = after(Math.max(wait(1), wait(s.failed)), 'reopen')
      if (!on.live) {
        on.live = true
        // Sent again as it was first, in as many messages as it takes.
        for (const one of s.kept) say(on, one.encoded, one.size)
      }
      return false
    }
    if (!isObject(arrived)) { unknown(); return false }
    if (arrived.lost === true) { end({ why: 'lost' }); return false }
    if (isCount(arrived.there)) { say(on, word({ here: arrived.there })); return false }
    if (isCount(arrived.here)) return false
    if (arrived.bye === 'ended') { end({ why: 'goodbye', bye: 'ended' }); return false }
    if (arrived.bye === 'restarting') {
      // A link that comes back waits for the other end to: if it comes back a new session, that is lost.
      if (once) end({ why: 'goodbye', bye: 'restarting' })
      return false
    }
    if (!('seq' in arrived) && 'taken' in arrived) {
      if (!isCount(arrived.taken) || !letGo(arrived.taken)) unknown()
      return false
    }
    const { seq, cause } = arrived
    if (!isCount(seq) || seq === 0) { unknown(); return false }
    if ((cause !== undefined && typeof cause !== 'string') || (arrived.private !== undefined && arrived.private !== true)) { unknown(); return false }
    if ('frame' in arrived) {
      const frame = asFrame(arrived.frame)
      if (!frame) { unknown(); return false }
      if (seq !== s.heard + 1) { end({ why: 'out of order', expected: s.heard + 1, got: seq }); return false }
      // A whole frame where a frame in parts was arriving: its parts were not all sent.
      if (s.parting) { unknown(); return false }
      s.heard = seq
      // This end says it took it with its next batch, and has one leave for that alone if none is to.
      turn(on)
      handOver(frame, seq, s.tapped ? measure() : undefined, cause, arrived.private === true)
      return true
    }
    const { part: at, of, data } = arrived
    if (!isCount(at) || !isCount(of) || of < 2 || at >= of || (typeof data !== 'string' && !(data instanceof Uint8Array))) { unknown(); return false }
    if (seq !== s.heard + 1) { end({ why: 'out of order', expected: s.heard + 1, got: seq }); return false }
    // The first part begins a frame, and each after it is the next of that frame's: nothing is taken between them.
    if (at === 0 ? s.parting !== undefined : s.parting?.of !== of || s.parting.pieces.length !== at || typeof data !== typeof s.parting.pieces[0]) { unknown(); return false }
    if (at === 0) s.parting = { first: seq, of, pieces: [], bytes: 0, ...(s.tapped ? { size: 0 } : {}), ...(cause === undefined ? {} : { cause }), private: arrived.private === true }
    const whole = s.parting!
    // What a frame's parts add up to is a frame, and no longer than one may be: so what is kept while one arrives is
    // bounded, however many parts it is said to be in. A part holds something, so they are no more than that many.
    const pieceSize = sizeOf(data)
    whole.bytes += pieceSize
    if (pieceSize === 0 || whole.bytes > largest) { unknown(); return false }
    whole.pieces.push(data)
    if (whole.size !== undefined) {
      const partSize = measure()
      if (partSize === undefined) delete whole.size
      else whole.size += partSize
    }
    s.heard = seq
    // Said to be taken part by part, so that a resume picks up where it got to.
    turn(on)
    if (whole.pieces.length < of) return false
    delete s.parting
    let frame: Frame | undefined
    try { frame = asFrame(codec.decode(joined(whole.pieces))) } catch { /* not a frame */ }
    if (!frame) { unknown(); return false }
    handOver(frame, whole.first, s.tapped ? whole.size : undefined, whole.cause, whole.private)
    return true
  }
  /** Hands over a whole frame that arrived, numbered `first`, with what caused it. */
  const handOver = (frame: Frame, first: number, size: number | undefined, cause: string | undefined, private_: boolean): void => {
    out.push({
      do: 'hand', frame,
      ...(cause === undefined ? {} : { cause }),
      ...(s.tapped && size !== undefined ? { traffic: seen('in', first, size, aboutOf(frame, { ...(cause === undefined ? {} : { cause }), private: private_ })) } : {}),
    })
  }

  /** Begins taking a message that arrived on the connection this end is on. */
  const hear = (on: Connection, message: Message): void => {
    if (s.now !== on || s.ending) return
    arriving = message
    let said: unknown
    try { said = codec.decode(message) } catch { unknown(); return }
    if (!Array.isArray(said) || !said.length) { unknown(); return }
    s.taking.push({ on: on.id, said: said as unknown[], at: 0, message })
    more()
  }
  /**
   * Takes what is left of the message being taken, as far as the next frame handed over: whatever is done with
   * that frame comes before anything after it is taken.
   */
  const more = (): void => {
    const taking = s.taking.at(-1)
    if (!taking) return
    arriving = taking.message
    while (taking.at < taking.said.length) {
      // Something taken may end the link, or put it on another connection: then the rest is not this one's.
      if (s.ending || s.now?.id !== taking.on) { s.taking.pop(); return }
      const index = taking.at++
      const entry = taking.said[index]
      const measure = (): number | undefined => {
        if (codec.sizes) {
          taking.sizes ??= codec.sizes(taking.message)
          return taking.sizes?.[index]
        }
        try { return sizeOf(codec.encode(entry)) } catch { return undefined }
      }
      if (take(s.now, entry, measure)) return
    }
    s.taking.pop()
    // Whoever was handed its last frame may have ended the link, or put it on another connection.
    if (s.ending || s.now?.id !== taking.on) return
    // Anything arriving is when an end looks again at whether there is room to number what waits: what carries it
    // says nothing when it has written all it was given. And it starts a quiet connection's window over.
    pump()
    watch(true)
  }
  /**
   * Puts the end on a connection, in place of the one it has, and says hello on it: at the end of this turn, or,
   * where what is said on it leaves before then, with that.
   */
  const begin = (id: number, most: number | undefined, turns = true): Connection => {
    off(s.reopening)
    delete s.reopening
    off(s.holding)
    delete s.holding
    off(s.watching?.timer)
    delete s.watching
    const was = s.now
    const on: Connection = { id, ...(most === undefined ? {} : { most }), met: false, live: dials && once, held: false, told: s.heard, takes: Infinity, batch: [], sizes: [], due: false }
    s.now = on
    if (was) out.push({ do: 'close', on: was.id, thrown: 'reported' })
    if (turns) say(on, hello(most))
    else put(on, hello(most))
    return on
  }

  const send = (one: Ready): void => {
    if (s.ending) return
    const { encoded, size, causeSize, about, view } = one
    if (!s.waiting.length && roomy()) { number(encoded, size, causeSize, about); return }
    // A view's result waiting to be numbered is overtaken by a later one, which takes its place in the order.
    const overtaken = view === undefined ? undefined : s.showing.get(view)
    if (overtaken) {
      s.waitingSize += size - overtaken.size
      overtaken.encoded = encoded
      overtaken.size = size
      overtaken.causeSize = causeSize
      overtaken.about = about
    } else {
      s.waiting.push(one)
      s.waitingSize += size
      if (view !== undefined) s.showing.set(view, one)
    }
    if (s.waiting.length > bound.frames || s.waitingSize > bound.size) {
      end({ why: 'overrun', waiting: { frames: s.waiting.length, size: s.waitingSize }, bound: { frames: bound.frames, size: bound.size } })
    }
  }
  const close = (bye: Bye | undefined): void => {
    if (s.ending) return
    // What was said before closing leaves before it closes, what waited for room with it, and a goodbye last. It
    // is the last this end sends, so the mark that room is counted against no longer holds anything back.
    // An end that listens, is on no connection and has met nobody says what it has left to say on the one that
    // waits, though nobody has said hello there: it is the last it says, and there is no session for it to say
    // anything of. One that has met somebody says nothing to whoever may be there.
    const waited = s.now || s.theirs !== undefined ? undefined : s.pending
    if (waited) {
      delete s.pending
      begin(waited.id, waited.most, false)
    }
    const on = s.now
    if (on) {
      // An end that has met nobody has numbered nothing: what it numbers now arrives once or not at all, since
      // it sends nothing again.
      if (on.live || s.theirs === undefined) drain(() => true)
      if (bye) put(on, word({ bye }))
      flush(on)
    }
    end({ why: 'closed' })
  }
  const carry = (id: number, most: number | undefined): void => {
    if (s.ending) { out.push({ do: 'close', on: id, thrown: 'reported' }); return }
    // The end that dials says hello on it at once, in place of the one it was on.
    if (dials) { begin(id, most); return }
    // The end that listens says nothing on it, and stays on the one it has, until whoever is on it has said a
    // hello that fits: nothing that arrives on the other is missed for it. Only the last handed over waits.
    if (s.pending) out.push({ do: 'close', on: s.pending.id, thrown: 'reported' })
    s.pending = { id, ...(most === undefined ? {} : { most }) }
  }
  /** A message arrived: on the connection this end is on, or on one that waits to be heard to fit. */
  const data = (id: number, message: Message): void => {
    if (s.now?.id === id) { hear(s.now, message); return }
    const waited = s.pending
    if (s.ending || waited?.id !== id) return
    delete s.pending
    const fits = greeting(firstOf(codec, message), waited.most)
    if ('no' in fits) {
      // Turned away, and told why where it would otherwise wait: which link this is, so that another link ends
      // saying both numbers, and that the session is lost. It is told nothing of the session this end is in: a
      // hello that names no session, and has taken nothing. What is not a link's is told nothing at all. The end
      // stays on the connection it has, and one that had this one alone ends with it.
      const told = fits.no === 'not a frame' ? [] : [word({ link: LINK, session: '', taken: 0 }), ...(toldLost(fits) ? [word({ lost: true })] : [])]
      out.push({ do: 'away', on: id, ...(told.length ? { message: codec.list(told) } : {}) })
      if (once) end({ why: 'closed' })
      return
    }
    hear(begin(id, waited.most), message)
  }
  /** What was put on a clock is due. One called off that is due all the same is nothing. */
  const due = (timer: number): void => {
    if (timer === s.watching?.timer) { quiet(); return }
    if (timer === s.holding) {
      delete s.holding
      if (s.now) s.now.held = true
      return
    }
    if (timer !== s.reopening) return
    delete s.reopening
    if (!s.ending && !s.now) out.push({ do: 'open' })
  }

  return (state, event) => {
    s = state
    out = []
    backlog = 'backlog' in event ? event.backlog : 0
    switch (event.is) {
      case 'send': send(event.one); break
      case 'close': close(event.bye); break
      case 'carry': carry(event.on, event.most); break
      case 'data': data(event.on, event.message); break
      case 'more': more(); break
      case 'closed':
        if (s.now?.id === event.on) dropped(s.now)
        else if (s.pending?.id === event.on) {
          delete s.pending
          // It was the only one this end would have: nobody said a hello that fits on it.
          if (once && !s.ending) end({ why: 'closed' })
        }
        break
      case 'broke': if (s.now?.id === event.on) dropped(s.now); break
      case 'turn': if (s.now?.id === event.on) flush(s.now); break
      case 'due': due(event.timer); break
      // What cannot be opened, or carried, is a connection that did not hold.
      case 'unopened': if (!s.ending) { s.failed++; reopen() } break
      case 'owed': s.owed++; watch(false); break
      case 'settled': s.owed--; unwatch(); break
      case 'tapped': s.tapped = true; break
      case 'untapped': s.tapped = false; if (s.parting) delete s.parting.size; break
    }
    // Nothing is held between steps but what was handed in: not the end, the message, or what was asked for.
    const asked = out
    s = out = undefined as never
    arriving = ''
    return asked
  }
}
