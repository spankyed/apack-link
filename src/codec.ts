// What a link's batches are put into, and taken out of: text or bytes. JSON is built in; a host that has msgpack, or
// anything else, hands its own in.
//
// A link encodes each thing it says where it is said, so that what cannot be encoded is refused there alone, and
// joins what is already encoded into a batch, which cannot fail. So a codec encodes one value, and joins values it
// has already encoded as a list or as the fields of a record.
import { bytesOf } from './frames.ts'
import type { Message } from './transport.ts'

/**
 * A list a codec makes is no longer than its parts, one byte between each two, and two more, as JSON's is: a link
 * counts on it to cut a batch to what carries it.
 */
export interface Codec {
  /** One value in a message's form. Throws for one it cannot hold. */
  encode(value: unknown): Message
  /** Values already encoded, as a list of them. Cannot fail. */
  list(parts: readonly Message[]): Message
  /** Values already encoded, as the fields of a record. Cannot fail. */
  record(fields: ReadonlyArray<readonly [name: string, value: Message]>): Message
  /** What a message holds. Throws for one it did not make. */
  decode(message: Message): unknown
  /**
   * Optional: how many bytes each top-level entry of a list message was as it crossed, measured directly from the
   * message without encoding it again. Used when a tap is listening.
   */
  sizes?(message: Message): readonly number[] | undefined
}

const decoder = new TextDecoder('utf-8', { fatal: true })
const textOf = (message: Message): string => (typeof message === 'string' ? message : decoder.decode(message))
const isJsonSpace = (code: number): boolean => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d

/** How many bytes one unit of text is as UTF-8, with the unit after it when the two make one character. */
const unitBytes = (text: string, at: number): number => {
  const unit = text.charCodeAt(at)
  if (unit < 0x80) return 1
  if (unit < 0x800) return 2
  return unit >= 0xd800 && unit <= 0xdbff && (text.charCodeAt(at + 1) & 0xfc00) === 0xdc00 ? 4 : 3
}

/** Exact UTF-8 byte length of each top-level entry in a JSON array message, measured without re-encoding. */
const jsonSizes = (message: Message): number[] | undefined => {
  const isText = typeof message === 'string'
  const len = isText ? message.length : message.byteLength
  const code = isText ? (at: number) => message.charCodeAt(at) : (at: number) => message[at]!
  let at = 0
  while (at < len && isJsonSpace(code(at))) at++
  if (at >= len || code(at) !== 0x5b) return undefined
  at++
  const out: number[] = []
  while (at < len) {
    while (at < len && isJsonSpace(code(at))) at++
    if (at >= len || code(at) === 0x5d) break
    let bytes = 0
    let trailing = 0
    let depth = 0
    let inString = false
    let escaped = false
    while (at < len) {
      const c = code(at)
      if (inString) {
        if (escaped) escaped = false
        else if (c === 0x5c) escaped = true
        else if (c === 0x22) inString = false
        const size = isText ? unitBytes(message, at) : 1
        bytes += size
        at += size === 4 ? 2 : 1
        continue
      }
      if (c === 0x22) { bytes += trailing + 1; trailing = 0; inString = true; at++; continue }
      if (c === 0x7b || c === 0x5b) { bytes += trailing + 1; trailing = 0; depth++; at++; continue }
      if (c === 0x7d || c === 0x5d) {
        if (depth === 0) break
        bytes += trailing + 1
        trailing = 0
        depth--
        at++
        continue
      }
      if (c === 0x2c && depth === 0) break
      if (isJsonSpace(c)) { trailing++; at++; continue }
      bytes += trailing + 1
      trailing = 0
      at++
    }
    out.push(bytes)
    if (at < len && code(at) === 0x2c) at++
    else break
  }
  return out
}

/** Text, as JSON. What arrives as bytes is read as UTF-8. */
export const json: Codec = {
  encode: (value) => {
    const text = JSON.stringify(value)
    if (text === undefined) throw new TypeError('Not a value JSON can hold')
    return text
  },
  list: (parts) => `[${parts.join(',')}]`,
  record: (fields) => `{${fields.map(([name, value]) => `${JSON.stringify(name)}:${value as string}`).join(',')}}`,
  decode: (message) => JSON.parse(textOf(message)) as unknown,
  sizes: jsonSizes,
}

/** How many bytes a message is: text as UTF-8, which is how it crosses. */
export const sizeOf = (message: Message): number => (typeof message === 'string' ? bytesOf(message) : message.byteLength)

/**
 * How much of a message, from its start, is no more than `most` bytes: in units of text, or in bytes. Text is cut
 * between characters, never inside one, and at least one character is taken however long it is.
 */
export const head = (message: Message, most: number): number => {
  if (typeof message !== 'string') return Math.max(1, Math.min(message.byteLength, most))
  let bytes = 0
  let at = 0
  while (at < message.length) {
    const size = unitBytes(message, at)
    if (bytes + size > most && at > 0) break
    bytes += size
    at += size === 4 ? 2 : 1
  }
  return at
}
/** A message from `from` on, or up to `to`: in units of text, or in bytes. */
export const slice = (message: Message, from: number, to?: number): Message => (typeof message === 'string' ? message.slice(from, to) : message.subarray(from, to))
/** How long a message is, in what `head` counts in. */
export const lengthOf = (message: Message): number => (typeof message === 'string' ? message.length : message.byteLength)

/** The pieces of a message, put back together. */
export const joined = (pieces: readonly Message[]): Message => {
  if (pieces.every((piece) => typeof piece === 'string')) return (pieces as string[]).join('')
  const bytes = pieces as Uint8Array[]
  const whole = new Uint8Array(bytes.reduce((all, piece) => all + piece.byteLength, 0))
  let at = 0
  for (const piece of bytes) { whole.set(piece, at); at += piece.byteLength }
  return whole
}
