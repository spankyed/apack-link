// A link carried on a stream of bytes: a Unix domain socket or a named pipe. A stream has no edges between
// messages, so each crosses with what it is and its length before it, and is put together again where it arrives.
import { once, type Message, type Transport } from './transport.ts'

/** What a Node `Duplex` has, and all a link uses of one. */
export interface DuplexLike {
  write(chunk: Uint8Array): unknown
  end(): unknown
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown
  on(event: 'end' | 'close', listener: () => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
}

/** Before each message: one byte for what it is, then its length in four, most significant first. */
const HEAD = 5
const TEXT = 0
const BYTES = 1

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

/**
 * A transport over a stream of bytes. What arrives in pieces is put together, and what arrives together is taken
 * apart. A stream that hands over something that is not a message closes.
 */
export function stream(duplex: DuplexLike): Transport {
  const hears: Array<(message: Message) => void> = []
  const closes = once()
  /** What has arrived and is not yet a whole message. */
  let pending = new Uint8Array(0)
  const take = (): void => {
    while (pending.length >= HEAD && !closes.fired) {
      const kind = pending[0]!
      const length = new DataView(pending.buffer, pending.byteOffset, HEAD).getUint32(1)
      if (kind !== TEXT && kind !== BYTES) { closes.fire(); return }
      if (pending.length < HEAD + length) return
      const body = pending.slice(HEAD, HEAD + length)
      pending = pending.subarray(HEAD + length)
      let message: Message
      if (kind === TEXT) {
        try { message = decoder.decode(body) } catch { closes.fire(); return }
      } else message = body
      for (const heard of hears) heard(message)
    }
  }
  duplex.on('data', (chunk) => {
    if (closes.fired) return
    const joined = new Uint8Array(pending.length + chunk.length)
    joined.set(pending)
    joined.set(chunk, pending.length)
    pending = joined
    take()
  })
  duplex.on('end', () => closes.fire())
  duplex.on('close', () => closes.fire())
  // An error is followed by a close; it says nothing a close does not.
  duplex.on('error', () => {})
  return {
    send: (message) => {
      if (closes.fired) return
      const body = typeof message === 'string' ? encoder.encode(message) : message
      const out = new Uint8Array(HEAD + body.length)
      out[0] = typeof message === 'string' ? TEXT : BYTES
      new DataView(out.buffer).setUint32(1, body.length)
      out.set(body, HEAD)
      duplex.write(out)
    },
    onData: (heard) => { hears.push(heard) },
    onClose: closes.add,
    close: () => {
      if (closes.fired) return
      duplex.end()
      closes.fire()
    },
  }
}
