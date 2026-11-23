// A link carried on a message port: a browser's `MessagePort`, Node's `worker_threads` port, or Electron's
// `MessagePortMain`. None is imported.
import { once, type Message, type Transport } from './transport.ts'

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
    if (data === null) { closes.fire(); return }
    if (typeof data === 'string' || data instanceof Uint8Array) for (const heard of hears) heard(data)
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
