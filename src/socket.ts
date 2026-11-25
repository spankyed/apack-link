// A link carried on a WebSocket: a browser's, or Node's `ws`, or anything with the parts of one they share. Neither
// is imported. The socket is opened by whoever holds it, with whatever it needs to be let in.
import { sizeOf } from './codec.js'
import { once, type Message, type Transport } from './transport.js'

/** What a browser's `WebSocket` and Node's `ws` both have, and all a link uses of either. */
export interface WebSocketLike {
  /** 0 opening, 1 open, 2 closing, 3 closed. */
  readonly readyState: number
  /** How much of what was sent is not yet written to the network. */
  readonly bufferedAmount: number
  binaryType: string
  send(data: string | Uint8Array): void
  close(): void
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void
}

export interface SocketOptions {
  /**
   * The longest message, in bytes, the other end of the socket takes, where it takes none longer: a server's limit
   * on a message. The transport says it (`most`), so a link carried on it cuts what it sends to fit, and is not
   * carried on it at all if that is less than `LEAST` or what it still keeps. A socket says nothing of this itself.
   */
  readonly most?: number
}

const OPENING = 0
const OPEN = 1

const isArrayBuffer = (value: unknown): value is ArrayBuffer =>
  value instanceof ArrayBuffer || Object.prototype.toString.call(value) === '[object ArrayBuffer]'

/**
 * A transport over a WebSocket. What is sent while it is still opening waits, and leaves in order once it is open.
 * Bytes arrive as a `Uint8Array`.
 */
export function socket(ws: WebSocketLike, options: SocketOptions = {}): Transport {
  if (options.most !== undefined && (!Number.isSafeInteger(options.most) || options.most < 1)) {
    throw new RangeError('socket most is a positive whole number of bytes')
  }
  const hears: Array<(message: Message) => void> = []
  const closes = once()
  const waiting: Message[] = []
  let waitingBytes = 0
  let closing = false
  closes.add(() => { waiting.length = 0; waitingBytes = 0; hears.length = 0 })
  ws.binaryType = 'arraybuffer'
  ws.addEventListener('open', () => {
    if (closes.fired || closing || ws.readyState !== OPEN) { waiting.length = 0; waitingBytes = 0; return }
    const queued = waiting.splice(0)
    waitingBytes = 0
    for (const message of queued) {
      if (closes.fired || closing || ws.readyState !== OPEN) break
      try { ws.send(message) } catch {
        closing = true
        try { ws.close() } catch { /* already closed */ } finally { closes.fire() }
        break
      }
    }
  })
  ws.addEventListener('message', ({ data }) => {
    if (closes.fired || closing) return
    const message = typeof data === 'string'
      ? data
      : isArrayBuffer(data)
        ? new Uint8Array(data)
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : undefined
    if (message === undefined) return
    for (const heard of hears) {
      if (closes.fired || closing) break
      heard(message)
    }
  })
  // An error is followed by a close; it says nothing a close does not.
  ws.addEventListener('error', () => {})
  ws.addEventListener('close', () => closes.fire())
  if (ws.readyState > OPEN) queueMicrotask(() => closes.fire())
  return {
    send: (message) => {
      if (closes.fired || closing) return
      if (ws.readyState === OPENING) { waiting.push(message); waitingBytes += sizeOf(message) }
      else if (ws.readyState === OPEN) ws.send(message)
    },
    onData: (heard) => { if (!closes.fired && !closing) hears.push(heard) },
    onClose: closes.add,
    ...(options.most === undefined ? {} : { most: options.most }),
    waiting: () => ws.bufferedAmount + waitingBytes,
    close: () => {
      if (closes.fired || closing) return
      closing = true
      try { ws.close() } finally { closes.fire() }
    },
  }
}
