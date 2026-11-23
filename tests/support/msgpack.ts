// msgpack as a codec, as a host that has it would hand one in: encode and decode are the library's, and joining what
// is already encoded is a header and the parts one after another.
import { decode, encode } from '@msgpack/msgpack'
import type { Codec, Message } from '../../src/index.ts'

const bytes = (message: Message): Uint8Array => (typeof message === 'string' ? new TextEncoder().encode(message) : message)
const together = (head: number[], parts: readonly Message[]): Uint8Array => {
  const all = parts.map(bytes)
  const out = new Uint8Array(head.length + all.reduce((sum, part) => sum + part.byteLength, 0))
  out.set(head)
  let at = head.length
  for (const part of all) { out.set(part, at); at += part.byteLength }
  return out
}
/** A msgpack array or map header for `count` entries: fixed for under sixteen, else sixteen or thirty-two bits. */
const header = (fixed: number, sixteen: number, count: number): number[] => count < 16
  ? [fixed | count]
  : count < 0x10000 ? [sixteen, count >> 8, count & 0xff] : [sixteen + 1, (count >>> 24) & 0xff, (count >> 16) & 0xff, (count >> 8) & 0xff, count & 0xff]

export const msgpack: Codec = {
  encode: (value) => encode(value),
  list: (parts) => together(header(0x90, 0xdc, parts.length), parts),
  record: (fields) => together(header(0x80, 0xde, fields.length), fields.flatMap(([name, value]) => [encode(name), value])),
  decode: (message) => decode(bytes(message)),
}
