// A link carried on a message port: a browser's `MessagePort`, Node's `worker_threads` port, or Electron's
// `MessagePortMain`. None is imported.
import { once, type Message, type Transport } from './transport.js'

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
  /** Messages received before the first `onData` listener is attached, delivered in order when one attaches. */
  const queued: Message[] = []
  let closeQueued = false
  let started = false
  let closing = false
  const closes = once()
  closes.add(() => { hears.length = 0; queued.length = 0; closeQueued = false })
  const arrived = (data: unknown): void => {
    if (closes.fired || closing || closeQueued) return
    // What says the other end closed.
    if (data === null) {
      if (hears.length === 0 && queued.length > 0) {
        closeQueued = true
        try { of.close() } catch { /* already closed */ }
        return
      }
      try { of.close() } catch { /* already closed */ } finally { closes.fire() }
      return
    }
    const message = typeof data === 'string' ? data : toBytes(data)
    if (message === undefined) return
    if (hears.length === 0) { queued.push(message); return }
    for (const heard of hears) {
      if (closes.fired || closing) break
      heard(message)
    }
  }
  if ('addEventListener' in of) {
    of.addEventListener('message', (event) => arrived(event.data))
    of.addEventListener('close', () => {
      if (hears.length === 0 && queued.length > 0) closeQueued = true
      else closes.fire()
    })
  } else {
    of.on('message', (event) => arrived(event.data))
    of.on('close', () => {
      if (hears.length === 0 && queued.length > 0) closeQueued = true
      else closes.fire()
    })
  }
  return {
    send: (message) => { if (!closes.fired && !closing) of.postMessage(message) },
    onData: (heard) => {
      if (closes.fired || closing) return
      hears.push(heard)
      if (!started) {
        started = true
        for (const message of queued.splice(0)) {
          if (closes.fired || closing) break
          for (const listener of hears) {
            if (closes.fired || closing) break
            listener(message)
          }
        }
        if (closeQueued) { closeQueued = false; closes.fire(); return }
        if (!closes.fired && !closing) of.start?.()
      }
    },
    onClose: closes.add,
    close: () => {
      if (closes.fired || closing) return
      closing = true
      try {
        try { of.postMessage(null) } finally { of.close() }
      } finally {
        closes.fire()
      }
    },
  }
}
