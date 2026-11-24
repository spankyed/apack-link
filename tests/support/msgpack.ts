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

/** Byte length of each top-level entry in a msgpack array message, measured directly without re-encoding. */
const msgpackSizes = (message: Message): number[] | undefined => {
  const buf = bytes(message)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const len = buf.byteLength
  if (len === 0) return undefined
  let at = 0
  let count: number
  const first = buf[at++]!
  if ((first & 0xf0) === 0x90) count = first & 0x0f
  else if (first === 0xdc && at + 2 <= len) { count = view.getUint16(at); at += 2 }
  else if (first === 0xdd && at + 4 <= len) { count = view.getUint32(at); at += 4 }
  else return undefined
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const start = at
    let remaining = 1
    while (remaining > 0) {
      if (at >= len) return undefined
      const b = buf[at++]!
      remaining--
      if (b <= 0x7f || b >= 0xe0 || b === 0xc0 || b === 0xc2 || b === 0xc3) continue
      if ((b & 0xf0) === 0x80) { remaining += (b & 0x0f) * 2; continue }
      if ((b & 0xf0) === 0x90) { remaining += b & 0x0f; continue }
      if ((b & 0xe0) === 0xa0) { at += b & 0x1f; continue }
      switch (b) {
        case 0xc4: case 0xd9: at += 1 + buf[at]!; break
        case 0xc5: case 0xda: at += 2 + view.getUint16(at); break
        case 0xc6: case 0xdb: at += 4 + view.getUint32(at); break
        case 0xc7: at += 2 + buf[at]!; break
        case 0xc8: at += 3 + view.getUint16(at); break
        case 0xc9: at += 5 + view.getUint32(at); break
        case 0xca: case 0xce: case 0xd2: at += 4; break
        case 0xcb: case 0xcf: case 0xd3: at += 8; break
        case 0xcc: case 0xd0: at += 1; break
        case 0xcd: case 0xd1: case 0xd4: at += 2; break
        case 0xd5: at += 3; break
        case 0xd6: at += 5; break
        case 0xd7: at += 9; break
        case 0xd8: at += 17; break
        case 0xdc: remaining += view.getUint16(at); at += 2; break
        case 0xdd: remaining += view.getUint32(at); at += 4; break
        case 0xde: remaining += view.getUint16(at) * 2; at += 2; break
        case 0xdf: remaining += view.getUint32(at) * 2; at += 4; break
        default: return undefined
      }
      if (at > len) return undefined
    }
    out.push(at - start)
  }
  return out
}

export const msgpack: Codec = {
  encode: (value) => encode(value),
  list: (parts) => together(header(0x90, 0xdc, parts.length), parts),
  record: (fields) => together(header(0x80, 0xde, fields.length), fields.flatMap(([name, value]) => [encode(name), value])),
  decode: (message) => decode(bytes(message)),
  sizes: msgpackSizes,
}
