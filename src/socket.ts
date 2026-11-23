// A link carried on a WebSocket: a browser's, or Node's `ws`, or anything with the parts of one they share. Neither
// is imported. The socket is opened by whoever holds it, with whatever it needs to be let in.
import { once, type Message, type Transport } from './transport.ts'

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

const OPENING = 0
const OPEN = 1

/**
 * A transport over a WebSocket. What is sent while it is still opening waits, and leaves in order once it is open.
 * Bytes arrive as a `Uint8Array`.
 */
export function socket(ws: WebSocketLike): Transport {
  const hears: Array<(message: Message) => void> = []
  const closes = once()
  const waiting: Message[] = []
  ws.binaryType = 'arraybuffer'
  ws.addEventListener('open', () => { for (const message of waiting.splice(0)) ws.send(message) })
  ws.addEventListener('message', ({ data }) => {
    if (closes.fired) return
    const message = typeof data === 'string' ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : undefined
    if (message === undefined) return
    for (const heard of hears) heard(message)
  })
  // An error is followed by a close; it says nothing a close does not.
  ws.addEventListener('error', () => {})
  ws.addEventListener('close', () => closes.fire())
  if (ws.readyState > OPEN) queueMicrotask(() => closes.fire())
  return {
    send: (message) => {
      if (closes.fired) return
      if (ws.readyState === OPENING) waiting.push(message)
      else if (ws.readyState === OPEN) ws.send(message)
    },
    onData: (heard) => { hears.push(heard) },
    onClose: closes.add,
    waiting: () => ws.bufferedAmount + waiting.reduce((all, message) => all + (typeof message === 'string' ? message.length : message.byteLength), 0),
    close: () => {
      if (closes.fired) return
      ws.close()
      closes.fire()
    },
  }
}
