import { describe, expect, it } from 'vitest'
import { accept, join, link, memoryPair, type Ending, type Frame, type Link, type Message, type Outcome, type Transport } from '../src/index.ts'
import { desk, droppingMemoryEnds, everyOrder, resume } from '../src/testing/index.ts'

describe('resuming, over memory', () => {
  for (const scenario of resume) {
    it(scenario.name, async () => {
      expect(await everyOrder((schedule) => scenario.play(schedule, droppingMemoryEnds(schedule)))).toBeGreaterThan(1)
    })
  }
})

describe('accepting connections', () => {
  const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

  it('makes a link for a new session, and hands a known one back to its link', async () => {
    // The backend answers when it is asked, on whichever link it is handed.
    const backend = desk({ ask: (asked) => { asked.ended({ ok: true, value: asked.args }) } })
    const made: Link[] = []
    const take = accept((one) => { made.push(one); join(one, backend.port) })
    let current: Transport | undefined
    const window = link(() => {
      const [left, right] = memoryPair()
      current = left
      take(right)
      return left
    })
    const ended: Ending[] = []
    window.onEnd((ending) => { ended.push(ending) })
    const toBackend = join(window, desk().port)
    const answered: Outcome[] = []
    toBackend.ask('x', 'ASK', 'before', () => {}, (outcome) => { answered.push(outcome) })
    await turn()
    current!.close()
    toBackend.ask('x', 'ASK', 'after', () => {}, (outcome) => { answered.push(outcome) })
    await turn()
    expect(ended).toEqual([])
    expect(answered).toEqual([{ ok: true, value: 'before' }, { ok: true, value: 'after' }])
    expect(backend.asks.map((asked) => asked.args)).toEqual(['before', 'after'])
    expect(made).toHaveLength(1)
  })

  it('tells a connection that would go on with a session it does not know that the session is lost', async () => {
    const made: Link[] = []
    const window = link(memoryPair()[0])
    void window
    const [left, right] = memoryPair()
    accept((one) => { made.push(one) })(right)
    const texts: unknown[] = []
    left.onData((text) => { texts.push(JSON.parse(text as string)) })
    left.send(JSON.stringify([{ link: 1, session: 'from before', taken: 3, again: true }]))
    await turn()
    expect(made).toEqual([])
    expect(texts).toEqual([[{ link: 1, session: expect.any(String), taken: 0 }, { lost: true }]])
  })

  it('ends a window that comes back to a backend that does not know it, saying so', async () => {
    let take = accept(() => {})
    let current: Transport | undefined
    const window = link(() => {
      const [left, right] = memoryPair()
      current = left
      take(right)
      return left
    })
    const ended: Ending[] = []
    window.onEnd((ending) => { ended.push(ending) })
    await turn()
    // The backend restarts: what accepts connections now knows nothing of before.
    take = accept(() => {})
    current!.close()
    await turn()
    await turn()
    expect(ended).toEqual([{ why: 'lost' }])
  })
})

describe('a link handed connections', () => {
  const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

  it('is lost when it is handed a connection from another session than the one it was talking to', async () => {
    const backend = link()
    const ended: Ending[] = []
    backend.onEnd((ending) => { ended.push(ending) })
    const [first, there] = memoryPair()
    link(first)
    backend.carry(there)
    await turn()
    // Another window, a new session, on the same link.
    const [second, there2] = memoryPair()
    link(second)
    backend.carry(there2)
    await turn()
    expect(ended).toEqual([{ why: 'lost' }])
  })

  it('takes nothing from a connection it has been handed another in place of', async () => {
    const backend = link()
    const heard: Frame[] = []
    backend.onFrame((frame) => { heard.push(frame) })
    // A connection that goes on handing over what arrives after it was closed.
    let hand: ((message: Message) => void) | undefined
    const stale: Transport = { send: () => {}, onData: (heard_) => { hand = heard_ }, onClose: () => {}, close: () => {} }
    backend.carry(stale)
    hand!(JSON.stringify([{ link: 1, session: 'w', taken: 0 }]))
    const [fresh, there] = memoryPair()
    backend.carry(there)
    fresh.send(JSON.stringify([{ link: 1, session: 'w', taken: 0, again: true }]))
    await turn()
    hand!(JSON.stringify([{ seq: 1, frame: { kind: 'tell', to: 'x', event: 'stale' } }]))
    fresh.send(JSON.stringify([{ seq: 1, frame: { kind: 'tell', to: 'x', event: 'fresh' } }]))
    await turn()
    expect(heard).toEqual([{ kind: 'tell', to: 'x', event: 'fresh' }])
  })
})
