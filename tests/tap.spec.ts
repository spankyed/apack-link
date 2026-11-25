// What caused a frame crosses with it; a tap is told of each frame and never of what it carries; a private frame is
// told of as having crossed, and its size, and nothing else.
import { describe, expect, it } from 'vitest'
import { join, dial, json, listen, memoryPair, type Codec, type Ending, type Frame, type Port, type Traffic } from '../src/index.ts'
import { explore } from '@apackdev/orderings'
import { asking, desk, scheduledPair, trackedJoin, watching } from '../src/testing/index.ts'
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

  it('starts with frames that begin after it is added, and reports a broken codec to thrown', async () => {
    // A tap added partway through a frame in parts starts with the next frame that begins after it was added,
    // rather than reporting an under-counted size for parts it never saw.
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
    expect(seen).toEqual([{ direction: 'in', seq: 3, kind: 'tell', name: 'x', size: expect.any(Number) }])

    // A codec that cannot re-encode what it just decoded is broken: the error goes to `thrown`, that one tap event
    // is skipped, and the frame is still handed over as normal.
    const [bare2, right2] = memoryPair()
    const boom = new TypeError('cannot re-encode')
    const custom: Codec = {
      encode: (value) => {
        if (typeof value === 'object' && value !== null && 'seq' in value) throw boom
        return json.encode(value)
      },
      list: json.list,
      record: json.record,
      decode: json.decode,
    }
    const reported: unknown[] = []
    const b2 = listen(right2, { codec: custom, thrown: (error) => { reported.push(error) } })
    const heard2: Frame[] = []
    b2.onFrame((frame) => { heard2.push(frame) })
    const seen2 = tapped(b2)
    bare2.send(JSON.stringify([{ link: 1, session: 's', taken: 0 }, { seq: 1, frame: { kind: 'tell', to: 'x', event: 'ok' } }]))
    await turn()
    expect(heard2).toEqual([{ kind: 'tell', to: 'x', event: 'ok' }])
    expect(seen2).toEqual([])
    expect(reported).toEqual([boom])
  })

  it('can be removed, stopping notifications and measurement until another tap is added', async () => {
    let entryEncodes = 0
    const tracked: Codec = {
      ...json,
      encode: (value) => {
        if (typeof value === 'object' && value !== null && 'seq' in value) entryEncodes++
        return json.encode(value)
      },
    }
    const [left, right] = memoryPair()
    const a = dial(left)
    const b = listen(right, { codec: tracked })
    const out: Traffic[] = []
    const in1: Traffic[] = []
    const in2: Traffic[] = []
    const offA = a.onTraffic((traffic) => { out.push(traffic) })
    const offB1 = b.onTraffic((traffic) => { in1.push(traffic) })
    const offB2 = b.onTraffic((traffic) => { in2.push(traffic) })
    a.send({ kind: 'tell', to: 'x', event: 1 })
    await turn()
    expect(out.map((t) => t.seq)).toEqual([1])
    expect(in1.map((t) => t.seq)).toEqual([1])
    expect(in2.map((t) => t.seq)).toEqual([1])
    expect(entryEncodes).toBe(1)

    // Removing one of two taps keeps measuring for the remaining tap.
    offB1()
    offB1() // idempotent
    entryEncodes = 0
    a.send({ kind: 'tell', to: 'x', event: 2 })
    await turn()
    expect(in1.map((t) => t.seq)).toEqual([1])
    expect(in2.map((t) => t.seq)).toEqual([1, 2])
    expect(entryEncodes).toBe(1)

    // Removing the last tap tells the core so arriving frames are no longer re-encoded until another tap is added.
    offA()
    offB2()
    entryEncodes = 0
    a.send({ kind: 'tell', to: 'x', event: 3 })
    await turn()
    expect(out.map((t) => t.seq)).toEqual([1, 2])
    expect(in2.map((t) => t.seq)).toEqual([1, 2])
    expect(entryEncodes).toBe(0)

    // Adding a tap again resumes measurement and reporting.
    const in3: Traffic[] = []
    const offB3 = b.onTraffic((traffic) => { in3.push(traffic) })
    a.send({ kind: 'tell', to: 'x', event: 4 })
    await turn()
    expect(in3.map((t) => t.seq)).toEqual([4])
    expect(entryEncodes).toBe(1)
    offB3()

    // Removing and re-adding a tap partway through a frame in parts stops measuring intermediate parts and starts
    // the new tap on the next frame that begins after it was added.
    let partEncodes = 0
    const partTracked: Codec = {
      ...json,
      encode: (value) => {
        if (typeof value === 'object' && value !== null && 'seq' in value) partEncodes++
        return json.encode(value)
      },
    }
    const [bare, right2] = memoryPair()
    const b2 = listen(right2, { codec: partTracked })
    const offPart = b2.onTraffic(() => {})
    bare.send(JSON.stringify([{ link: 1, session: 's', taken: 0 }]))
    bare.send(JSON.stringify([{ seq: 1, part: 0, of: 3, data: '{"kind":"tell",' }]))
    await turn()
    expect(partEncodes).toBe(1)

    offPart()
    partEncodes = 0
    bare.send(JSON.stringify([{ seq: 2, part: 1, of: 3, data: '"to":"x",' }]))
    await turn()
    expect(partEncodes).toBe(0)

    const seenPart = tapped(b2)
    bare.send(JSON.stringify([{ seq: 3, part: 2, of: 3, data: '"event":"whole"}' }]))
    bare.send(JSON.stringify([{ seq: 4, frame: { kind: 'tell', to: 'x', event: 'after' } }]))
    await turn()
    expect(seenPart).toEqual([{ direction: 'in', seq: 4, kind: 'tell', name: 'x', size: expect.any(Number) }])
  })

  it('measures incoming frame sizes identically to outgoing for JSON text, JSON bytes and msgpack', async () => {
    const frames: Frame[] = [
      { kind: 'tell', to: 'panel', event: { text: 'café 😀 "},]" end \\', after: [1, 2, 3] } },
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
      const b = listen(right, { codec: base })
      const outA = tapped(a)
      const inB = tapped(b)
      a.send(frames[0]!, { cause: 'step 1' })
      a.send(frames[1]!, { cause: 'step 2' })
      await turn()
      expect(inB.map((t) => t.size), label).toEqual(outA.map((t) => t.size))
    }
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

describe('a port carries cause and private both ways through join', () => {
  it('forwards cause and private across tell, ask, progress, answer, follow, shown, and over (both unheld and held)', async () => {
    const [left, right] = memoryPair()
    const a = dial(left)
    const b = listen(right)
    const tapA = tapped(a)
    const tapB = tapped(b)

    const release: Array<() => void> = []
    const backend = desk({
      ask: (asked) => {
        if (asked.name === 'HOLD') {
          asked.heard('step-1', { cause: 'progress-cause' })
          asked.ended({ ok: true, value: 'done' }, { cause: 'answer-cause' })
        } else if (asked.name === 'SECRET') {
          asked.ended({ ok: true, value: 'token' }, { cause: 'secret-answer', private: true })
        }
      },
      follow: (viewed) => {
        if (viewed.view === 'held') {
          viewed.shown([1], { cause: 'shown-cause' })
          return { caughtUp: (then) => { release.push(then) } }
        }
        viewed.shown([2], { cause: 'secret-shown', private: true })
        viewed.over({ kind: 'gone', message: 'closed' }, { cause: 'over-cause' })
      },
    })
    const toWindow = join(b, backend.port)
    const windowDesk = desk()
    const toBackend = join(a, windowDesk.port)

    // Unheld outbound tell (public + private) and follow (starts hold on backend).
    toBackend.tell('svc', { type: 'PING' }, { cause: 'tell-cause' })
    toBackend.tell('vault', { type: 'UNLOCK' }, { cause: 'secret-tell', private: true })
    const heldShownCauses: Array<string | undefined> = []
    toBackend.follow('f', 'held', null, (_u, how) => { heldShownCauses.push(how?.cause) }, () => {}, { cause: 'follow-cause' })
    await turn()

    // While backend holds behind `caughtUp`, ask and backend->window tell go through `link.prepare(frame, how)`.
    const heardCauses: Array<string | undefined> = []
    const answerCauses: Array<string | undefined> = []
    toBackend.ask('svc', 'HOLD', null, (_u, how) => { heardCauses.push(how?.cause) }, (_o, how) => { answerCauses.push(how?.cause) }, { cause: 'ask-cause' })
    toWindow.tell('ui', { type: 'HELD' }, { cause: 'held-tell-cause' })
    await turn()
    expect(release.length).toBeGreaterThan(0)
    for (const done of release.splice(0)) done()
    await turn()

    // Private ask + private answer, plus private shown + caused over.
    const secretAnswerCauses: Array<string | undefined> = []
    toBackend.ask('vault', 'SECRET', null, () => {}, (_o, how) => { secretAnswerCauses.push(how?.cause) }, { cause: 'secret-ask', private: true })
    const secretShownCauses: Array<string | undefined> = []
    const overCauses: Array<string | undefined> = []
    toBackend.follow('f', 'secret', null, (_u, how) => { secretShownCauses.push(how?.cause) }, (_f, how) => { overCauses.push(how?.cause) }, { cause: 'secret-follow', private: true })
    await turn()
    for (const done of release.splice(0)) done()
    await turn()

    expect(backend.told).toEqual([
      { to: 'svc', event: { type: 'PING' }, cause: 'tell-cause' },
      { to: 'vault', event: { type: 'UNLOCK' }, cause: 'secret-tell' },
    ])
    expect(backend.asks.map((x) => ({ name: x.name, cause: x.cause }))).toEqual([
      { name: 'HOLD', cause: 'ask-cause' },
      { name: 'SECRET', cause: 'secret-ask' },
    ])
    expect(backend.views.map((x) => ({ view: x.view, cause: x.cause }))).toEqual([
      { view: 'held', cause: 'follow-cause' },
      { view: 'secret', cause: 'secret-follow' },
    ])
    expect(windowDesk.told).toEqual([{ to: 'ui', event: { type: 'HELD' }, cause: 'held-tell-cause' }])
    expect(heardCauses).toEqual(['progress-cause'])
    expect(answerCauses).toEqual(['answer-cause'])
    expect(secretAnswerCauses).toEqual(['secret-answer'])
    expect(heldShownCauses).toEqual(['shown-cause'])
    expect(secretShownCauses).toEqual(['secret-shown'])
    expect(overCauses).toEqual(['over-cause'])

    // Public frames carry `cause` on the tap; private frames hide both body and cause at both ends.
    expect(tapA.some((t) => t.direction === 'out' && !('private' in t) && t.kind === 'tell' && t.cause === 'tell-cause')).toBe(true)
    expect(tapB.some((t) => t.direction === 'in' && !('private' in t) && t.kind === 'ask' && t.cause === 'ask-cause')).toBe(true)
    expect(tapB.some((t) => t.direction === 'out' && !('private' in t) && t.kind === 'answer' && t.cause === 'answer-cause')).toBe(true)
    expect(tapA.some((t) => t.direction === 'in' && !('private' in t) && t.kind === 'over' && t.cause === 'over-cause')).toBe(true)
    expect(tapA.filter((t) => t.direction === 'out' && 'private' in t)).toHaveLength(3)
    expect(tapB.filter((t) => t.direction === 'in' && 'private' in t)).toHaveLength(3)
    expect(tapB.filter((t) => t.direction === 'out' && 'private' in t)).toHaveLength(2)
    expect(tapA.filter((t) => t.direction === 'in' && 'private' in t)).toHaveLength(2)
    expect(JSON.stringify([...tapA, ...tapB])).not.toContain('secret-')
  })

  it('refuses oversized cause through Port without breaking the link, and works through trackedJoin and legacy Ports', async () => {
    const tooLong = 'c'.repeat(1025)
    const [left, right] = memoryPair()
    const a = dial(left)
    const b = listen(right)
    const backend = desk({
      ask: (asked) => {
        if (asked.name === 'BAD_ANS') asked.ended({ ok: true, value: 1 }, { cause: tooLong })
        else asked.ended({ ok: true, value: 'ok' }, { cause: 'good' })
      },
      follow: (viewed) => {
        if (viewed.view === 'bad_shown') viewed.shown(1, { cause: tooLong })
        else if (viewed.view === 'bad_over') viewed.over({ kind: 'gone', message: 'x' }, { cause: tooLong })
      },
    })
    join(b, backend.port)
    // Structural compatibility: a Port omitting `how` still passes directly into `join()`.
    const legacyPort: {
      tell(to: string, event: unknown): void
      ask(to: string, name: string, args: unknown, heard: (u: unknown) => void, ended: (o: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly failure: { readonly kind: string; readonly message: string } }) => void): () => void
      follow(feature: string, view: string, args: unknown, shown: (u: unknown) => void, over: (f: { readonly kind: string; readonly message: string }) => void): { stop(): void }
    } = { tell: () => {}, ask: () => () => {}, follow: () => ({ stop: () => {} }) }
    const toBackend: Port = join(a, legacyPort)

    expect(() => toBackend.tell('svc', 1, { cause: tooLong })).toThrow(RangeError)
    const badAsk = asking(toBackend, 'svc', 'OK', null, { cause: tooLong })
    const badFollow = watching(toBackend, 'f', 'v', null, { cause: tooLong })
    const badAns = asking(toBackend, 'svc', 'BAD_ANS', null)
    const badShown = watching(toBackend, 'f', 'bad_shown', null)
    const badOver = watching(toBackend, 'f', 'bad_over', null)
    const goodAsk = asking(toBackend, 'svc', 'OK', null, { cause: 'ok-cause' })
    await turn()

    expect(badAsk.ended).toEqual([{ ok: false, failure: { kind: 'failed', message: 'A value could not be sent' } }])
    expect(badFollow.over).toEqual([{ kind: 'failed', message: 'A value could not be sent' }])
    expect(badAns.ended).toEqual([{ ok: false, failure: { kind: 'failed', message: 'A value could not be sent' } }])
    expect(badShown.over).toEqual([{ kind: 'failed', message: 'A value could not be sent' }])
    expect(badOver.over).toEqual([{ kind: 'failed', message: 'A value could not be sent' }])
    expect(goodAsk.ended).toEqual([{ ok: true, value: 'ok' }])

    // Also verify trackedJoin preserves `how` end-to-end under wakeup-tree DPOR.
    const seenCauses: string[] = []
    const explored = await explore((schedule) => {
      const resW = schedule.resource('w')
      const resB = schedule.resource('b')
      const [l, r] = scheduledPair(schedule, ['w', 'b'], { tracked: true, resources: [resW, resB] })
      const bDesk = desk({
        ask: (asked) => {
          if (asked.cause) seenCauses.push(`ask:${asked.cause}`)
          asked.ended({ ok: true, value: 1 }, { cause: 'tj-ans' })
        },
      })
      const p = trackedJoin(dial(l), desk().port, schedule, resW)
      trackedJoin(listen(r), bDesk.port, schedule, resB)
      p.ask('s', 'Q', null, () => {}, (_o, how) => { if (how?.cause) seenCauses.push(`ans:${how.cause}`) }, { cause: 'tj-ask' })
      return () => {}
    })
    expect(explored.complete).toBe(true)
    expect(seenCauses).toEqual(['ask:tj-ask', 'ans:tj-ans'])
  })
})
