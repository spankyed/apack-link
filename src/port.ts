// A link carried on a message port: a browser's `MessagePort`, Node's `worker_threads` port, or Electron's
// `MessagePortMain`. None is imported.
import { once, type Message, type Transport } from './transport.ts'

/** A value as a `Uint8Array` of this realm when it is one, even if it crossed from another realm, or nothing. */
const toBytes = (value: unknown): Uint8Array | undefined => {
  if (value instanceof Uint8Array) return value
  if (ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]') {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  return undefined
}

/** A port that takes listeners as an event target does: a browser's, and Node's. */
interface TargetPort {
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void
  addEventListener(type: 'close', listener: () => void): void
}
/** A port that takes listeners as an event emitter does, handing each a message event: Electron's. */
interface EmitterPort {
  on(type: 'message', listener: (event: { readonly data: unknown }) => void): void
  on(type: 'close', listener: () => void): void
}

export type MessagePortLike = { postMessage(message: unknown): void; close(): void; start?(): void } & (TargetPort | EmitterPort)

/**
 * A transport over a message port. A port closing is not told to the other end everywhere, so closing says so
 * first, as a message of its own after everything sent before it.
 */
export function port(of: MessagePortLike): Transport {
  const hears: Array<(message: Message) => void> = []
  const closes = once()
  const arrived = (data: unknown): void => {
    if (closes.fired) return
    // What says the other end closed.
    if (data === null) {
      closes.fire()
      try { of.close() } catch { /* already closed */ }
      return
    }
    const message = typeof data === 'string' ? data : toBytes(data)
    if (message !== undefined) for (const heard of hears) heard(message)
  }
  if ('addEventListener' in of) {
    of.addEventListener('message', (event) => arrived(event.data))
    of.addEventListener('close', () => closes.fire())
  } else {
    of.on('message', (event) => arrived(event.data))
    of.on('close', () => closes.fire())
  }
  of.start?.()
  return {
    send: (message) => { if (!closes.fired) of.postMessage(message) },
    onData: (heard) => { hears.push(heard) },
    onClose: closes.add,
    close: () => {
      if (closes.fired) return
      of.postMessage(null)
      of.close()
      closes.fire()
    },
  }
}
