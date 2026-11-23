// What a link is carried on: something that takes text at one end and hands it over at the other, in order, until
// it closes. A WebSocket is one, and so is a pair of these in memory, which is what a test runs a link on.

export interface Transport {
  send(text: string): void
  /** Called with each text the other end sent, in the order it was sent. */
  onText(heard: (text: string) => void): void
  /** Called once, when nothing more will arrive: either end closed it, or what carried it went. */
  onClose(closed: () => void): void
  /** Closes this end now. The other end is handed what was sent before this, and then hears that it closed. */
  close(): void
}

/**
 * Two ends in memory, joined. What one sends the other hears later, never as it is sent, and an end closing is heard
 * by the other after everything sent before it, as on a socket. `later` says when what the first end sends arrives,
 * and `back` the same for the second: a microtask unless given. A test gives them to choose the moment, or a lane
 * of a schedule each, to run every order there is.
 */
export function memoryPair(later: (run: () => void) => void = queueMicrotask, back: (run: () => void) => void = later): [Transport, Transport] {
  const ends = [0, 1].map(() => ({ open: true, hears: [] as Array<(text: string) => void>, closes: [] as Array<() => void> }))
  const shut = (end: (typeof ends)[number]): void => {
    if (!end.open) return
    end.open = false
    for (const closed of end.closes) closed()
  }
  const make = (mine: 0 | 1, cross: (run: () => void) => void): Transport => {
    const here = ends[mine]!
    const there = ends[1 - mine]!
    return {
      send: (text) => { if (here.open) cross(() => { if (there.open) for (const heard of there.hears) heard(text) }) },
      onText: (heard) => { here.hears.push(heard) },
      onClose: (closed) => { here.closes.push(closed) },
      close: () => {
        if (!here.open) return
        shut(here)
        cross(() => shut(there))
      },
    }
  }
  return [make(0, later), make(1, back)]
}
