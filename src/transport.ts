// What a link is carried on: something that takes a message at one end and hands it over at the other, in order,
// until it closes. A message is text or bytes. A WebSocket is one (`socket.ts`), a message port another
// (`port.ts`), a stream of bytes with a length before each message a third (`stream.ts`), and a pair of these in
// memory, which is what a test runs a link on.

/** What crosses a transport whole: one batch of what an end said. */
export type Message = string | Uint8Array

export interface Transport {
  send(message: Message): void
  /** Called with each message the other end sent, in the order it was sent. */
  onData(heard: (message: Message) => void): void
  /** Called once, when nothing more will arrive: either end closed it, or what carried it went. */
  onClose(closed: () => void): void
  /** Closes this end now. The other end is handed what was sent before this, and then hears that it closed. */
  close(): void
  /** How many bytes of what was sent it has not yet written, where it can say. A link counts it against its bound. */
  waiting?(): number
  /**
   * The longest message it carries, in bytes, where there is one. A link hands it nothing longer: a batch that
   * would be crosses as more than one, and a frame that would be is cut into parts.
   */
  readonly most?: number
}

/**
 * Two ends in memory, joined. What one sends the other hears later, never as it is sent, and an end closing is heard
 * by the other after everything sent before it, as on a socket. `later` says when what the first end sends arrives,
 * and `back` the same for the second: a microtask unless given. A test gives them to choose the moment, or a lane
 * of a schedule each, to run every order there is.
 */
export function memoryPair(later: (run: () => void) => void = queueMicrotask, back: (run: () => void) => void = later): [Transport, Transport] {
  const ends = [0, 1].map(() => {
    const hears: Array<(message: Message) => void> = []
    const closes = once()
    closes.add(() => { hears.length = 0 })
    return { hears, closes }
  })
  const make = (mine: 0 | 1, cross: (run: () => void) => void): Transport => {
    const here = ends[mine]!
    const there = ends[1 - mine]!
    return {
      send: (message) => {
        if (here.closes.fired) return
        cross(() => {
          if (there.closes.fired) return
          for (const heard of there.hears) {
            if (there.closes.fired) break
            heard(message)
          }
        })
      },
      onData: (heard) => { if (!here.closes.fired) here.hears.push(heard) },
      onClose: here.closes.add,
      close: () => {
        if (here.closes.fired) return
        here.closes.fire()
        cross(() => there.closes.fire())
      },
    }
  }
  return [make(0, later), make(1, back)]
}

/** Calls each once, the first time; what is added after is called at once. For a transport's closing. */
export function once(): { add(closed: () => void): void; fire(): void; readonly fired: boolean } {
  let fired = false
  const waiting: Array<() => void> = []
  return {
    add: (closed) => { if (fired) closed(); else waiting.push(closed) },
    fire: () => {
      if (fired) return
      fired = true
      for (const closed of waiting.splice(0)) closed()
    },
    get fired() { return fired },
  }
}
