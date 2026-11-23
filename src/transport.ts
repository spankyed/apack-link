// What a link is carried on: something that takes text at one end and hands it over at the other, in order, until
// it closes. A WebSocket is one, and so is a pair of these in memory, which is what a test runs a link on.

export interface Transport {
  send(text: string): void
  /** Called with each text the other end sent, in the order it was sent. */
  onText(heard: (text: string) => void): void
  /** Called once, when nothing more will arrive: either end closed it, or what carried it went. */
  onClose(closed: () => void): void
  close(): void
}

/**
 * Two ends in memory, joined. What one sends the other hears later, never as it is sent: `later` says when, and is
 * a microtask unless it is given. A test gives one to choose the moment, or to run every order there is.
 */
export function memoryPair(later: (run: () => void) => void = queueMicrotask): [Transport, Transport] {
  let open = true
  const ends = [0, 1].map(() => ({ hears: [] as Array<(text: string) => void>, closes: [] as Array<() => void> }))
  const close = (): void => {
    if (!open) return
    open = false
    for (const end of ends) for (const closed of end.closes) closed()
  }
  const make = (mine: 0 | 1): Transport => {
    const here = ends[mine]!
    const there = ends[1 - mine]!
    return {
      send: (text) => { if (open) later(() => { if (open) for (const heard of there.hears) heard(text) }) },
      onText: (heard) => { here.hears.push(heard) },
      onClose: (closed) => { here.closes.push(closed) },
      close,
    }
  }
  return [make(0), make(1)]
}
