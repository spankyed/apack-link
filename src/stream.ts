// A link carried on a stream of bytes: a Unix domain socket or a named pipe. A stream has no edges between
// messages, so each crosses with what it is and its length before it, and is put together again where it arrives.
//
// What arrives is kept as the pieces it came in, and a message is joined once, when all of it is here: the work
// is in proportion to the bytes that arrive, however small the pieces. A head may claim no more than `most`, so
// what is kept waiting for a message is bounded by it, and a link is told `most`, so it hands over nothing longer.
import { once, type Message, type Transport } from './transport.ts'

/** What a Node `Duplex` has, and all a link uses of one. */
export interface DuplexLike {
  write(chunk: Uint8Array): unknown
  /** How much of what was written is not yet handed on. */
  readonly writableLength?: number
  end(): unknown
  /** Lets go of the stream at once, where it can: for one that handed over something that is not a message. */
  destroy?(): unknown
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown
  on(event: 'end' | 'close', listener: () => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
}

export interface StreamOptions {
  /**
   * The longest message, in bytes, that is sent or taken: a head that claims more closes the stream, and so does
   * sending more. 128 MiB unless given, and never more than a length in four bytes can say. The transport says it
   * (`most`), and a link carried on it sends nothing longer, so both ends are to be given the same.
   */
  readonly most?: number
}

/** Before each message: one byte for what it is, then its length in four, most significant first. */
const HEAD = 5
const TEXT = 0
const BYTES = 1
const MOST = 128 * 1024 * 1024
const LONGEST = 0xffff_ffff

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

/**
 * A transport over a stream of bytes. What arrives in pieces is put together, and what arrives together is taken
 * apart. A stream that hands over something that is not a message, or one longer than `most`, closes, and the
 * stream beneath it is let go.
 */
export function stream(duplex: DuplexLike, options: StreamOptions = {}): Transport {
  const most = Math.min(options.most ?? MOST, LONGEST)
  const hears: Array<(message: Message) => void> = []
  const closes = once()
  /** What has arrived and is not yet a whole message, as it came; how much of the first piece is used; how much is left. */
  let pieces: Uint8Array[] = []
  let used = 0
  let pending = 0
  /** The message being waited for, once its head is here: what it is and how long. */
  let head: { readonly kind: number; readonly length: number } | undefined

  /**
   * Takes the next `length` bytes of what has arrived: joined once where they lie in more than one piece. Where
   * they lie in one, they are read where they are, or copied once if they are to be `own`: bytes of nobody else's.
   */
  const pull = (length: number, own: boolean): Uint8Array => {
    pending -= length
    const first = pieces[0]
    if (first && first.length - used >= length) {
      const part = first.subarray(used, used + length)
      used += length
      if (used === first.length) { pieces.shift(); used = 0 }
      return own ? new Uint8Array(part) : part
    }
    const joined = new Uint8Array(length)
    let at = 0
    while (at < length) {
      const piece = pieces[0]!
      const part = piece.subarray(used, used + Math.min(piece.length - used, length - at))
      joined.set(part, at)
      at += part.length
      used += part.length
      if (used === piece.length) { pieces.shift(); used = 0 }
    }
    return joined
  }
  /** Closes because of what the other end handed over, and lets go of the stream beneath: nothing more of it is wanted. */
  const refuse = (): void => {
    if (closes.fired) return
    pieces = []
    pending = 0
    closes.fire()
    if (duplex.destroy) duplex.destroy()
    else duplex.end()
  }
  const take = (): void => {
    while (!closes.fired) {
      if (!head) {
        if (pending < HEAD) return
        const bytes = pull(HEAD, false)
        const kind = bytes[0]!
        const length = new DataView(bytes.buffer, bytes.byteOffset, HEAD).getUint32(1)
        if ((kind !== TEXT && kind !== BYTES) || length > most) { refuse(); return }
        head = { kind, length }
      }
      if (pending < head.length) return
      const { kind, length } = head
      head = undefined
      // Bytes are handed over as their own, not as a part of a piece the stream beneath may use again.
      const body = pull(length, kind === BYTES)
      let message: Message
      if (kind === TEXT) {
        try { message = decoder.decode(body) } catch { refuse(); return }
      } else message = body
      for (const heard of hears) heard(message)
    }
  }
  duplex.on('data', (chunk) => {
    if (closes.fired || !chunk.length) return
    pieces.push(chunk)
    pending += chunk.length
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
      // Longer than the other end takes, or than a head can say: this stream cannot carry it.
      if (body.length > most) { duplex.end(); closes.fire(); return }
      const out = new Uint8Array(HEAD + body.length)
      out[0] = typeof message === 'string' ? TEXT : BYTES
      new DataView(out.buffer).setUint32(1, body.length)
      out.set(body, HEAD)
      duplex.write(out)
    },
    onData: (heard) => { hears.push(heard) },
    onClose: closes.add,
    most,
    waiting: () => duplex.writableLength ?? 0,
    close: () => {
      if (closes.fired) return
      duplex.end()
      closes.fire()
    },
  }
}
