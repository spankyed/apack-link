// What caused a frame crosses with it; a tap is told of each frame and never of what it carries; a private frame is
// told of as having crossed, and its size, and nothing else.
import { describe, expect, it } from 'vitest'
import { join, dial, listen, memoryPair, type Ending, type Frame, type Traffic } from '../src/index.ts'
import { desk } from '../src/testing/index.ts'

const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })
const tapped = (end: ReturnType<typeof dial>): Traffic[] => {
  const seen: Traffic[] = []
  end.onTraffic((traffic) => { seen.push(traffic) })
  return seen
}

describe('a tap', () => {
  it('sees every frame out and in, in order, with what it is and never what it carries', async () => {
    const [left, right] = memoryPair()
    const a = dial(left)
    const b = listen(right)
    const outA = tapped(a)
    const inB = tapped(b)
    const sent: Frame[] = [
      { kind: 'follow', id: 1, feature: 'threads', view: 'list', args: { open: true } },
      { kind: 'ask', id: 1, to: 'threads', name: 'CREATE', args: { topic: 'one' } },
      { kind: 'tell', to: 'panel', event: { type: 'OPENED' } },
      { kind: 'left', id: 1 },
      { kind: 'unfollow', id: 1 },
    ]
    for (const frame of sent) a.send(frame, { cause: 'step 7 of threads' })
    await turn()
    const expected = (direction: 'out' | 'in') => [
      { direction, seq: 1, kind: 'follow', id: 1, name: 'list', size: expect.any(Number), cause: 'step 7 of threads' },
      { direction, seq: 2, kind: 'ask', id: 1, name: 'CREATE', size: expect.any(Number), cause: 'step 7 of threads' },
      { direction, seq: 3, kind: 'tell', name: 'panel', size: expect.any(Number), cause: 'step 7 of threads' },
      { direction, seq: 4, kind: 'left', id: 1, size: expect.any(Number), cause: 'step 7 of threads' },
      { direction, seq: 5, kind: 'unfollow', id: 1, size: expect.any(Number), cause: 'step 7 of threads' },
    ]
    expect(outA).toEqual(expected('out'))
    expect(inB).toEqual(expected('in'))
    // The size is the length of the frame's text, the same at both ends.
    expect(inB.map((traffic) => traffic.size)).toEqual(outA.map((traffic) => traffic.size))
    expect(outA[1]!.size).toBe(JSON.stringify({ seq: 2, frame: sent[1], cause: 'step 7 of threads' }).length)
  })

  it('is told of a frame once, as it is numbered, however long it waited', async () => {
    const [left, right] = memoryPair()
    const a = dial(left, { bound: { kept: { frames: 1, size: 1 << 20 } } })
    listen(right)
    const out = tapped(a)
    a.send({ kind: 'shown', id: 1, update: 1 })
    a.send({ kind: 'shown', id: 1, update: 2 })
    a.send({ kind: 'shown', id: 1, update: 3 })
    expect(out.map((traffic) => traffic.seq)).toEqual([1])
    await turn()
    await turn()
    expect(out.map((traffic) => traffic.seq)).toEqual([1, 2])
  })
})

describe('a tap that throws', () => {
  it('is the tap\'s to answer for: frames go on crossing, and the link does not end', async () => {
    const [left, right] = memoryPair()
    const a = dial(left)
    const b = listen(right)
    a.onTraffic(() => { throw new Error('the tap broke') })
    b.onTraffic(() => { throw new Error('the tap broke') })
    const heard: Frame[] = []
    const ended: Ending[] = []
    b.onFrame((frame) => { heard.push(frame) })
    b.onEnd((ending) => { ended.push(ending) })
    a.send({ kind: 'tell', to: 'x', event: 1 })
    a.send({ kind: 'tell', to: 'x', event: 2 })
    await turn()
    expect(heard).toHaveLength(2)
    expect(ended).toEqual([])
  })
})

describe('a cause', () => {
  it('of a result that overtook another is the later one\'s', async () => {
    const [left, right] = memoryPair()
    const a = dial(left, { bound: { kept: { frames: 1, size: 1 << 20 } } })
    const b = listen(right)
    const causes: Array<string | undefined> = []
    b.onFrame((_, cause) => { causes.push(cause) })
    a.send({ kind: 'shown', id: 1, update: 1 }, { cause: 'step 1' })
    a.send({ kind: 'shown', id: 1, update: 2 }, { cause: 'step 2' })
    a.send({ kind: 'shown', id: 1, update: 3 }, { cause: 'step 3' })
    for (let turns = 0; turns < 4; turns++) await turn()
    expect(causes).toEqual(['step 1', 'step 3'])
  })

  it('crosses with the frame it caused, and a frame sent without one arrives without one', async () => {
    const [left, right] = memoryPair()
    const a = dial(left)
    const b = listen(right)
    const heard: Array<[Frame, string | undefined]> = []
    b.onFrame((frame, cause) => { heard.push([frame, cause]) })
    a.send({ kind: 'tell', to: 'x', event: 1 }, { cause: 'threads: CREATED' })
    a.send({ kind: 'tell', to: 'x', event: 2 })
    await turn()
    expect(heard).toEqual([[{ kind: 'tell', to: 'x', event: 1 }, 'threads: CREATED'], [{ kind: 'tell', to: 'x', event: 2 }, undefined]])
  })
})

describe('a private frame', () => {
  it('is told of as having crossed, its number and size, and nothing else, at both ends', async () => {
    const [left, right] = memoryPair()
    const a = dial(left)
    const b = listen(right)
    const out = tapped(a)
    const in_ = tapped(b)
    const heard: Frame[] = []
    b.onFrame((frame) => { heard.push(frame) })
    a.send({ kind: 'ask', id: 1, to: 'vault', name: 'UNLOCK', args: { passphrase: 'p' } }, { cause: 'login', private: true })
    await turn()
    expect(out).toEqual([{ direction: 'out', seq: 1, private: true, size: expect.any(Number) }])
    expect(in_).toEqual([{ direction: 'in', seq: 1, private: true, size: expect.any(Number) }])
    // What it carries still reaches the other end: private is about what may be seen of it, not what it says.
    expect(heard).toEqual([{ kind: 'ask', id: 1, to: 'vault', name: 'UNLOCK', args: { passphrase: 'p' } }])
  })
})

describe('what a frame carries', () => {
  const MARK = 'MARKER-6c41e0'

  it('is in nothing a tap, an ending or a thrown error holds', async () => {
    const held: unknown[] = []
    const keep = (what: unknown): void => { held.push(what) }
    let thrownCount = 0
    const keepError = (error: unknown): void => {
      thrownCount++
      const thrown = error as Error
      keep({ text: String(error), message: thrown.message, stack: thrown.stack, cause: thrown.cause === undefined ? undefined : String(thrown.cause) })
    }

    // Every kind of frame, with the marker in all it carries, and private frames with it in their names too.
    const [left, right] = memoryPair()
    const a = dial(left)
    const b = listen(right)
    for (const end of [a, b]) { end.onTraffic(keep); end.onEnd(keep) }
    const carried = { [MARK]: MARK, list: [MARK] }
    const frames: Frame[] = [
      { kind: 'tell', to: 'panel', event: carried },
      { kind: 'ask', id: 1, to: 'threads', name: 'CREATE', args: carried },
      { kind: 'progress', id: 1, update: carried },
      { kind: 'answer', id: 1, outcome: { ok: false, failure: { kind: 'failed', message: MARK } } },
      { kind: 'follow', id: 1, feature: 'threads', view: 'list', args: carried },
      { kind: 'shown', id: 1, update: carried },
      { kind: 'over', id: 1, failure: { kind: 'reloaded', message: MARK } },
    ]
    for (const frame of frames) a.send(frame)
    a.send({ kind: 'tell', to: MARK, event: carried }, { private: true })
    a.send({ kind: 'ask', id: 2, to: MARK, name: MARK, args: carried }, { private: true })
    a.send({ kind: 'follow', id: 2, feature: MARK, view: MARK, args: carried }, { private: true })
    await turn()

    // Frames that cannot be put into text, refused where they are sent: by what they hold, and by a key.
    const circular: Record<string, unknown> = {}
    circular[MARK] = circular
    for (const event of [{ [MARK]: 1n }, circular]) {
      try { a.send({ kind: 'tell', to: 'x', event }) } catch (error) { keepError(error) }
    }
    // And through a peer, where the hold refuses them as they are said.
    const views = desk({ follow: () => ({ caughtUp: () => {} }) })
    const toWindow = join(b, views.port)
    join(a, desk().port).follow('threads', 'list', {}, () => {}, () => {})
    await turn()
    try { toWindow.tell(MARK, circular) } catch (error) { keepError(error) }

    // Every way a link ends that could have held what arrived.
    const endings: Ending[] = []
    for (const text of [MARK, JSON.stringify([{ [MARK]: MARK }]), JSON.stringify([{ link: 1, session: MARK, taken: 0 }, { seq: 9, frame: { kind: 'tell', to: MARK, event: carried } }])]) {
      const [bare, end] = memoryPair()
      dial(end).onEnd((ending) => { endings.push(ending) })
      bare.send(text)
    }
    const [over, under] = memoryPair(() => {})
    const full = dial(over, { bound: { kept: { frames: 1, size: 1 << 20 }, waiting: { frames: 2, size: 1 << 20 } } })
    full.onEnd((ending) => { endings.push(ending) })
    void under
    for (let at = 0; at < 4; at++) full.send({ kind: 'tell', to: MARK, event: carried })
    await turn()
    held.push(...endings)

    // Ten frames each way seen at both ends and the follow a peer sent; three refusals; four endings.
    expect(held.filter((one) => typeof one === 'object' && one !== null && 'direction' in one).length).toBe(22)
    expect(thrownCount).toBe(3)
    expect(endings.map((ending) => ending.why).sort()).toEqual(['not a frame', 'not a frame', 'out of order', 'overrun'])
    expect(JSON.stringify(held)).not.toContain(MARK)
  })
})
