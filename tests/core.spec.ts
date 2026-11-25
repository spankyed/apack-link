// What an end does, with nothing done, run from every state two ends can reach: no schedule, no transports and no
// clocks, only the core stepped by hand and a network that is values. Each state is looked at once, however many
// orders lead to it, and held to what a queue each way would have done.
import { describe, expect, it } from 'vitest'
import { around, core, LEAST, ready, setup, start, type Effect, type Event, type State } from '../src/core.ts'
import { json, sizeOf } from '../src/codec.ts'
import { msgpack } from './support/msgpack.ts'
import { space, type Act, type Script } from './support/space.ts'

const sends = (by: 'a' | 'b', count: number): Act[] => Array.from({ length: count }, () => ({ does: 'send', by }))
const drop: Act = { does: 'drop' }
const half: Act = { does: 'drop', half: true }

describe('every state two ends can reach', () => {
  const scripts: ReadonlyArray<readonly [string, Script]> = [
    ['on one connection, both send', { kind: 'once', lanes: [sends('a', 2), sends('b', 2)] }],
    ['on one connection, one says goodbye as the other sends', { kind: 'once', lanes: [[...sends('a', 2), { does: 'close', by: 'a', bye: 'ended' }], sends('b', 2)] }],
    ['on one connection, both close', { kind: 'once', lanes: [[...sends('a', 1), { does: 'close', by: 'a', bye: 'restarting' }], [...sends('b', 1), { does: 'close', by: 'b' }]] }],
    ['an end that opens its connections and one handed them, both send', { kind: 'opens', lanes: [sends('a', 2), sends('b', 2)] }],
    ['the connection drops as both send', { kind: 'opens', lanes: [sends('a', 1), sends('b', 1), [drop]] }],
    ['the connection drops with more sent than may be kept', { kind: 'opens', kept: 1, lanes: [sends('a', 3), sends('b', 1), [drop]] }],
    ['the first connection reaches nobody, and the next drops', { kind: 'opens', unreachable: 1, lanes: [sends('a', 1), sends('b', 1), [drop]] }],
    ['the listener restarts as both send', { kind: 'opens', lanes: [sends('a', 1), sends('b', 1), [{ does: 'restart' }]] }],
    ['the end that opens says goodbye', { kind: 'opens', lanes: [[...sends('a', 1), { does: 'close', by: 'a', bye: 'ended' }], sends('b', 1)] }],
    ['the listener says goodbye as the connection drops', { kind: 'opens', lanes: [sends('a', 1), [...sends('b', 1), { does: 'close', by: 'b', bye: 'ended' }], [drop]] }],
    ['a quiet connection is watched, and let go', { kind: 'opens', window: 100, quiet: 2, lanes: [sends('a', 1)] }],
    ['the connection goes at one end first, and the next reaches an end still on it', { kind: 'opens', lanes: [sends('a', 1), sends('b', 1), [half]] }],
    ['a watched connection goes at one end first', { kind: 'opens', window: 100, quiet: 1, lanes: [sends('a', 1), [half]] }],
    ["a view's results, more than may be kept, as the connection drops", { kind: 'opens', kept: 1, frames: 'results', lanes: [sends('a', 3), [drop]] }],
    ['a frame in parts as the connection drops', { kind: 'opens', frames: { part: 16 }, lanes: [sends('a', 1), [drop]] }],
    ['a frame longer than the connections take, as one drops', { kind: 'opens', most: LEAST, frames: { part: 2000 }, lanes: [sends('a', 1), [drop]] }],
  ]
  it.each(scripts)('%s', (_, script) => {
    const looked = space(script)
    expect(looked.states).toBeGreaterThan(100)
    expect(looked.rests).toBeGreaterThan(0)
  })

  it('says when a script is too wide to look at whole', () => {
    expect(() => space({ kind: 'opens', lanes: [sends('a', 2), sends('b', 2), [drop]], limit: 1000 })).toThrow(/More than 1000 states/)
  })
})

describe('an end that did otherwise is found', () => {
  const both: Script = { kind: 'opens', lanes: [sends('a', 2), sends('b', 1), [drop]] }
  const spoiled = (spoil: NonNullable<Script['spoil']>, script: Script = both): string => {
    try { space({ ...script, spoil }) } catch (error) { return (error as Error).message }
    return 'nothing'
  }

  it('one that hands a frame over twice', () => {
    expect(spoiled((effects) => effects.flatMap((effect): Effect[] => (effect.do === 'hand' ? [effect, effect] : [effect])))).toMatch(/was handed frame 1 of .*'s, after 1 of/)
  })

  it('one that leaves a message unsent, on a connection that never drops', () => {
    let left = false
    expect(spoiled((effects, session) => effects.filter((effect) => {
      if (session !== 'a' || effect.do !== 'write' || left || !effect.messages.some((message) => String(message).includes('"frame"'))) return true
      left = true
      return false
    }), { kind: 'once', lanes: [sends('a', 1)] })).toMatch(/at rest, b has been handed 0 of the 1 that a sent/)
  })

  it('one that sends a message twice, where it holds a frame out of turn', () => {
    expect(spoiled((effects) => effects.map((effect) => (effect.do === 'write' && effect.messages.some((message) => String(message).includes('"seq":1')) ? { ...effect, messages: [...effect.messages, ...effect.messages] } : effect))))
      .toMatch(/ended \{"why":"(out of order|not a frame)"/)
  })

  it('one that ends lost with the other still there', () => {
    expect(spoiled((effects, session): Effect[] => (session === 'a' && effects.some((effect) => effect.do === 'hand') ? [{ do: 'ended', ending: { why: 'lost' } }, ...effects] : effects)))
      .toMatch(/a ended lost, with every end still there/)
  })

  it('says what led to it', () => {
    expect(spoiled((effects) => effects.flatMap((effect): Effect[] => (effect.do === 'hand' ? [effect, effect] : [effect])))).toMatch(/after:\n(.*\n)*.*the script: \{"does":"send".*\n(.*\n)*.*a to b on \d/)
  })
})

describe('a step', () => {
  const set = setup({ role: 'dials', connections: 'one', session: 'here' })
  const other = setup({ role: 'dials', connections: 'one', session: 'there' })
  const tell = (event: string): Event => ({ is: 'send', one: ready(set, { kind: 'tell', to: 'x', event }, {}), backlog: 0 })
  /** Every step of an end that says hello, is met, sends, is sent a frame and is closed, with what each asked for. */
  const run = (): { state: State; asked: Effect[][] } => {
    const step = core(set)
    const state = start()
    const hello = other.codec.encode({ link: 1, session: 'there', taken: 0 })
    const frame = other.codec.record([['seq', '1'], ['frame', other.codec.encode({ kind: 'tell', to: 'y', event: 'in' })]])
    const events: Event[] = [
      { is: 'carry', on: 1 },
      tell('before'),
      { is: 'turn', on: 1 },
      { is: 'data', on: 1, message: other.codec.list([hello, frame, other.codec.encode({ taken: 1 })]), backlog: 0 },
      { is: 'more', backlog: 0 },
      tell('after'),
      { is: 'turn', on: 1 },
      { is: 'close', bye: 'ended' },
    ]
    return { state, asked: events.map((event) => step(state, event)) }
  }

  it('asks for the same, and leaves an end holding the same, each time it is given the same', () => {
    const [once, again] = [run(), run()]
    expect(again.asked).toEqual(once.asked)
    expect(again.state).toEqual(once.state)
  })

  it('does nothing itself: what is written, handed over and closed is only asked for', () => {
    const { asked, state } = run()
    expect(asked.map((effects) => effects.map((effect) => effect.do))).toEqual([
      ['later'],
      [],
      ['write'],
      ['later', 'hand'],
      [],
      [],
      ['write'],
      ['write', 'close', 'ended'],
    ])
    expect(asked[3]![1]).toMatchObject({ do: 'hand', frame: { kind: 'tell', to: 'y', event: 'in' } })
    expect(state.ending).toEqual({ why: 'closed' })
  })

  it('goes on from a copy of what an end holds as it would have from what was copied', () => {
    const step = core(set)
    const state = start()
    step(state, { is: 'carry', on: 1 })
    step(state, tell('one'))
    const copy = structuredClone(state)
    expect(step(copy, { is: 'turn', on: 1 })).toEqual(step(state, { is: 'turn', on: 1 }))
    expect(copy).toEqual(state)
  })

  const helloOf = (session: string, more: object = {}): string => JSON.stringify([{ link: 1, session, taken: 0, ...more }])
  const does = (effects: Effect[]): string[] => effects.map((effect) => effect.do)

  it('writes nothing when a turn ends for a connection the end has left', () => {
    const step = core(setup({ role: 'dials', connections: 'opened', session: 'here' }))
    const state = start()
    step(state, { is: 'carry', on: 1 })
    step(state, { is: 'carry', on: 2 })
    expect(does(step(state, { is: 'turn', on: 1 }))).toEqual([])
    expect(does(step(state, { is: 'turn', on: 2 }))).toEqual(['write'])
  })

  it('takes nothing more from a connection it turned away, whatever is said on it next', () => {
    const step = core(setup({ role: 'listens', connections: 'handed', session: 'here' }))
    const state = start()
    step(state, { is: 'carry', on: 1 })
    expect(does(step(state, { is: 'data', on: 1, message: '["not a hello"]', backlog: 0 }))).toEqual(['away'])
    expect(step(state, { is: 'data', on: 1, message: helloOf('there'), backlog: 0 })).toEqual([])
    expect(state.theirs).toBeUndefined()
  })

  it('takes nothing from a connection that waited and closed', () => {
    const step = core(setup({ role: 'listens', connections: 'handed', session: 'here' }))
    const state = start()
    step(state, { is: 'carry', on: 1 })
    step(state, { is: 'data', on: 1, message: helloOf('there'), backlog: 0 })
    step(state, { is: 'carry', on: 2 })
    step(state, { is: 'closed', on: 2 })
    expect(step(state, { is: 'data', on: 2, message: helloOf('there', { resumes: 'here' }), backlog: 0 })).toEqual([])
    expect(state.now?.id).toBe(1)
  })

  it('opens no connection for a clock that was called off, or while it is on one', () => {
    const step = core(setup({ role: 'dials', connections: 'opened', session: 'here' }))
    const state = start()
    step(state, { is: 'carry', on: 1 })
    // It could not be carried after all, though the end was put on it: another is to be opened, when the clock says.
    const [waits] = step(state, { is: 'unopened' })
    expect(waits).toMatchObject({ do: 'after', clock: 'reopen' })
    const timer = (waits as { timer: number }).timer
    expect(step(state, { is: 'due', timer: timer + 100 })).toEqual([])
    expect(step(state, { is: 'due', timer })).toEqual([])
    step(state, { is: 'closed', on: 1 })
    expect(step(state, { is: 'due', timer: state.reopening! + 100 })).toEqual([])
    const again = step(state, { is: 'due', timer: state.reopening! })
    expect(does(again)).toEqual(['open'])
  })

  it('refuses a setting no end could work with', () => {
    expect(() => setup({ role: 'dials', connections: 'one', session: 'x', part: 8 })).toThrow(RangeError)
    expect(() => setup({ role: 'dials', connections: 'one', session: 'x', bound: { frame: 100 } })).toThrow(RangeError)
  })
})

describe('what is around a frame', () => {
  const codecs = [['JSON', json], ['msgpack', msgpack]] as const
  /** What a link counts on being around a thing numbered: all of the least it is carried on but a part, a cause and the batch's two. */
  const counted = LEAST - 16 - 1024 - 2

  it('is, in JSON, a first part that is private and has a cause, with three numbers as long as a count is: 102 bytes', () => {
    const count = Number.MAX_SAFE_INTEGER
    const longest = JSON.stringify({ seq: count, part: count, of: count, data: '', cause: '', private: true })
    expect(around(json)).toBe(longest.length - 4)
    expect(around(json)).toBe(102)
    expect(counted).toBe(102)
  })

  it('is no more in msgpack, and an end is not set with a codec that puts more', () => {
    expect(around(msgpack)).toBeLessThanOrEqual(counted)
    const given = { role: 'dials', connections: 'one', session: 'a' } as const
    expect(() => setup({ ...given, codec: msgpack })).not.toThrow()
    expect(() => setup({ ...given, codec: json })).not.toThrow()
    const wordy = { ...json, record: (fields: ReadonlyArray<readonly [string, unknown]>) => json.record(fields.map(([name, value]) => [name === 'seq' ? 'sequence' : name, value as string])) }
    expect(around(wordy)).toBe(counted + 5)
    expect(() => setup({ ...given, codec: wordy })).toThrow(TypeError)
    const exact = { ...json, record: (fields: ReadonlyArray<readonly [string, unknown]>) => json.record(fields.map(([name, value]) => [name === 'seq' ? 'qes' : name, value as string])) }
    expect(() => setup({ ...given, codec: exact })).not.toThrow()
  })

  it.each(codecs)('is never more than is counted on, and nothing written is longer than is taken, whatever is sent and however far the numbering has got: %s', (_, codec) => {
    // The same cases each run: a generator with nothing of the clock in it.
    let seed = 0x2545f491
    const random = (below: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return Math.floor(seed / 2 ** 32 * below)
    }
    const letters = ['x', '"', '\\', '\u0001', '✓', '𝄞', ' ']
    const text = (most: number): string => Array.from({ length: random(most + 1) }, () => letters[random(letters.length)]).join('')
    let longest = 0
    for (let run = 0; run < 120; run++) {
      const set = setup({ role: 'dials', connections: 'one', session: 'a', codec })
      const step = core(set)
      const state = start()
      // What carries it takes the least there is, or a little more, and the other end says the same or less, or nothing.
      const most = LEAST + (random(3) ? random(3000) : 0)
      const theirs = random(3) ? LEAST + random(most - LEAST + 1) : undefined
      const takes = Math.min(most, theirs ?? Infinity)
      step(state, { is: 'carry', on: 1, most })
      step(state, { is: 'turn', on: 1 })
      step(state, { is: 'data', on: 1, message: codec.list([codec.encode({ link: 1, session: 'b', taken: 0, ...(theirs === undefined ? {} : { most: theirs }) })]), backlog: 0 })
      expect(state.ending).toBeUndefined()
      // Numbered from nothing, or from as far as numbers go: each number is then as long as one is.
      if (random(2)) state.sent = state.released = Number.MAX_SAFE_INTEGER - 100_000
      const written: number[] = []
      for (let sent = 0; sent < 3; sent++) {
        const cause = random(3) ? 'c'.repeat(random(4) ? random(1022) : 1021) : undefined
        const one = ready(set, { kind: 'tell', to: 'x', event: text(random(2) ? 40 : 4000) }, { ...(cause === undefined ? {} : { cause }), ...(random(2) ? { private: true } : {}) })
        step(state, { is: 'send', one, backlog: 0 })
      }
      for (const effect of step(state, { is: 'turn', on: 1 })) if (effect.do === 'write') written.push(...effect.messages.map(sizeOf))
      expect(state.ending).toBeUndefined()
      expect(written.length).toBeGreaterThan(0)
      expect(Math.max(...written)).toBeLessThanOrEqual(takes)
      for (let at = state.keptHead; at < state.kept.length; at++) {
        const unit = state.kept[at]!
        const said = codec.decode(unit.encoded) as { frame?: unknown; data?: unknown; cause?: string }
        const held = sizeOf(codec.encode('frame' in said ? said.frame : said.data)) + (said.cause === undefined ? 0 : sizeOf(codec.encode(said.cause)))
        expect(unit.size - held).toBeLessThanOrEqual(counted)
        expect(unit.size + 2).toBeLessThanOrEqual(takes)
        longest = Math.max(longest, unit.size + 2 - takes)
      }
    }
    // And the room is used: something numbered came within a few bytes of all that is taken.
    expect(longest).toBeGreaterThan(-40)
  })
})
