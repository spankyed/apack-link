// What caused a frame crosses with it; a tap is told of each frame and never of what it carries; a private frame is
// told of as having crossed, and its size, and nothing else.
import { describe, expect, it } from 'vitest'
import { join, dial, json, listen, memoryPair, type Codec, type Ending, type Frame, type Traffic } from '../src/index.ts'
import { desk } from '../src/testing/index.ts'
import { msgpack } from './support/msgpack.ts'

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

  it('omits an incoming tap event rather than inventing a size when measurement is unavailable', async () => {
    // A tap added partway through a frame in parts cannot know the earlier parts' size: the frame is handed over,
    // and the tap hears nothing for it rather than a partial or zero size.
    const [bare, right] = memoryPair()
    const b = listen(right)
    const heard: Frame[] = []
    b.onFrame((frame) => { heard.push(frame) })
    bare.send(JSON.stringify([{ link: 1, session: 's', taken: 0 }]))
    bare.send(JSON.stringify([{ seq: 1, part: 0, of: 2, data: '{"kind":"tell","to":"x",' }]))
    await turn()
    const seen = tapped(b)
    bare.send(JSON.stringify([{ seq: 2, part: 1, of: 2, data: '"event":"whole"}' }]))
    bare.send(JSON.stringify([{ seq: 3, frame: { kind: 'tell', to: 'x', event: 'next' } }]))
    await turn()
    expect(heard).toEqual([{ kind: 'tell', to: 'x', event: 'whole' }, { kind: 'tell', to: 'x', event: 'next' }])
    expect(seen.map((traffic) => traffic.seq)).toEqual([3])

    // And for a custom codec without `sizes` whose fallback `encode` throws on a received entry: the frame is still
    // handed over and the unmeasurable tap event is omitted rather than throwing or inventing size 0.
    const [bare2, right2] = memoryPair()
    const custom: Codec = {
      encode: (value) => {
        if (typeof value === 'object' && value !== null && 'seq' in value) throw new TypeError('cannot re-encode')
        return json.encode(value)
      },
      list: json.list,
      record: json.record,
      decode: json.decode,
    }
    const b2 = listen(right2, { codec: custom })
    const heard2: Frame[] = []
    b2.onFrame((frame) => { heard2.push(frame) })
    const seen2 = tapped(b2)
    bare2.send(JSON.stringify([{ link: 1, session: 's', taken: 0 }, { seq: 1, frame: { kind: 'tell', to: 'x', event: 'ok' } }]))
    await turn()
    expect(heard2).toEqual([{ kind: 'tell', to: 'x', event: 'ok' }])
    expect(seen2).toEqual([])
  })

  it('can be removed, stopping notifications and turning tapping off until another tap is added', async () => {
    const [left, right] = memoryPair()
    const a = dial(left)
    const b = listen(right)
    const out: Traffic[] = []
    const in_: Traffic[] = []
    const offA = a.onTraffic((traffic) => { out.push(traffic) })
    const offB = b.onTraffic((traffic) => { in_.push(traffic) })
    a.send({ kind: 'tell', to: 'x', event: 1 })
    await turn()
    expect(out.map((t) => t.seq)).toEqual([1])
    expect(in_.map((t) => t.seq)).toEqual([1])
    offA()
    offA() // idempotent
    offB()
    a.send({ kind: 'tell', to: 'x', event: 2 })
    await turn()
    expect(out.map((t) => t.seq)).toEqual([1])
    expect(in_.map((t) => t.seq)).toEqual([1])
    // Adding a tap again resumes reporting.
    const in2: Traffic[] = []
    const offB2 = b.onTraffic((traffic) => { in2.push(traffic) })
    a.send({ kind: 'tell', to: 'x', event: 3 })
    await turn()
    expect(in2.map((t) => t.seq)).toEqual([3])
    offB2()
  })

  it('measures incoming frame sizes directly from arrived bytes without re-encoding, for JSON text, JSON bytes and msgpack', async () => {
    const counting = (base: Codec): { codec: Codec; encodes: () => number; reset: () => void } => {
      let count = 0
      return {
        codec: {
          encode: (value) => { count++; return base.encode(value) },
          list: (parts) => base.list(parts),
          record: (fields) => base.record(fields),
          decode: (message) => base.decode(message),
          ...(base.sizes ? { sizes: (message) => base.sizes!(message) } : {}),
        },
        encodes: () => count,
        reset: () => { count = 0 },
      }
    }
    const frames: Frame[] = [
      { kind: 'tell', to: 'panel', event: { text: 'café 😀 "quoted" \\ slash', nums: [1, 2, 3] } },
      { kind: 'ask', id: 1, to: 'threads', name: 'CREATE', args: { nested: { a: true, b: null } } },
    ]
    for (const [label, base, asBytes] of [
      ['json text', json, false],
      ['json bytes', json, true],
      ['msgpack', msgpack, false],
    ] as const) {
      const [left, right] = memoryPair()
      const wire = asBytes
        ? { ...left, send: (message: string | Uint8Array) => left.send(typeof message === 'string' ? new TextEncoder().encode(message) : message) }
        : left
      const a = dial(wire, { codec: base })
      const recv = counting(base)
      const b = listen(right, { codec: recv.codec })
      const outA = tapped(a)
      const inB = tapped(b)
      // Let handshake finish before counting encodes on the receiver (receiver encodes only its own hello + taken).
      a.send(frames[0]!, { cause: 'step 1' })
      await turn()
      await turn()
      recv.reset()
      a.send(frames[1]!, { cause: 'step 2' })
      // Only `taken` is encoded by the receiver when flushing — NEVER the arriving frame itself.
      await turn()
      expect(inB.map((t) => t.size), label).toEqual(outA.map((t) => t.size))
      // Receiver encoded at most the `{ taken }` control word (1 encode), never the arriving frame.
      expect(recv.encodes(), label).toBeLessThanOrEqual(1)
    }
    // Verify JSON byte sizes match actual arrived bytes even with extra whitespace on the wire.
    const [bare, right] = memoryPair()
    const recv = counting(json)
    const b = listen(right, { codec: recv.codec })
    const seen = tapped(b)
    bare.send(JSON.stringify([{ link: 1, session: 's', taken: 0 }]))
    await turn()
    recv.reset()
    const rawUnit = '{ "seq" : 1 , "frame" : { "kind" : "tell" , "to" : "x" , "event" : "café 😀" } }'
    bare.send(`[  ${rawUnit}  ]`)
    await turn()
    expect(seen).toEqual([{ direction: 'in', seq: 1, kind: 'tell', name: 'x', size: new TextEncoder().encode(rawUnit).byteLength }])
    expect(recv.encodes()).toBeLessThanOrEqual(1)
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
