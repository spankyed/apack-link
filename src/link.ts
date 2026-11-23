// One end of a link: frames out, frames in, each in the order it was sent.
//
// Every frame an end sends is numbered, one more than the last. The other end takes a frame only if it is the next
// one, so a frame lost, doubled or out of place is found where it arrives and the link is closed, saying why: a
// link that went on would be handing over frames in an order nobody sent them in.
import type { Frame, Sent } from './frames.ts'
import type { Transport } from './transport.ts'

/** Why a link closed. `closed` is either end closing it, or what carried it going. */
export type Ending =
  | { readonly why: 'closed' }
  | { readonly why: 'out of order'; readonly expected: number; readonly got: number }
  | { readonly why: 'not a frame'; readonly text: string }

export interface Link {
  /**
   * Sends a frame. Throws if the frame cannot be put into text, having sent nothing and taken no number: that one
   * frame is refused, and the link goes on. After the link has closed it sends nothing.
   */
  send(frame: Frame): void
  /** Called with each frame the other end sent, in the order it sent them. */
  onFrame(heard: (frame: Frame) => void): void
  /** Called once, when the link has closed, with why. */
  onEnd(ended: (ending: Ending) => void): void
  close(): void
}

export function link(transport: Transport): Link {
  let sent = 0
  let heard = 0
  let ending: Ending | undefined
  const hears: Array<(frame: Frame) => void> = []
  const ends: Array<(ending: Ending) => void> = []
  const end = (why: Ending): void => {
    if (ending) return
    ending = why
    transport.close()
    for (const ended of ends) ended(why)
  }
  transport.onClose(() => end({ why: 'closed' }))
  transport.onText((text) => {
    if (ending) return
    let arrived: Sent
    try { arrived = JSON.parse(text) as Sent } catch { end({ why: 'not a frame', text }); return }
    if (typeof arrived?.seq !== 'number' || typeof arrived.frame?.kind !== 'string') { end({ why: 'not a frame', text }); return }
    if (arrived.seq !== heard + 1) { end({ why: 'out of order', expected: heard + 1, got: arrived.seq }); return }
    heard = arrived.seq
    for (const hear of hears) hear(arrived.frame)
  })
  return {
    send: (frame) => {
      if (ending) return
      // Put into text before it is numbered: a frame that cannot be is refused alone, and leaves no gap behind it.
      const text = JSON.stringify({ seq: sent + 1, frame } satisfies Sent)
      sent++
      transport.send(text)
    },
    onFrame: (hear) => { hears.push(hear) },
    onEnd: (ended) => { if (ending) ended(ending); else ends.push(ended) },
    close: () => end({ why: 'closed' }),
  }
}
