// What an end does, with nothing done, run from every state two ends can reach: no schedule, no transports and no
// clocks, only the core stepped by hand and a network that is values. Each state is looked at once, however many
// orders lead to it, and held to what a queue each way would have done.
import { describe, expect, it } from 'vitest'
import { core, ready, setup, start, type Effect, type Event, type State } from '../src/core.ts'
import { space, type Act, type Script } from './support/space.ts'

const sends = (by: 'a' | 'b', count: number): Act[] => Array.from({ length: count }, () => ({ does: 'send', by }))
const drop: Act = { does: 'drop' }

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
  const set = setup({ kind: 'once', session: 'here' })
  const other = setup({ kind: 'once', session: 'there' })
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
    const step = core(setup({ kind: 'handed', session: 'here' }))
    const state = start()
    step(state, { is: 'carry', on: 1 })
    step(state, { is: 'carry', on: 2 })
    expect(does(step(state, { is: 'turn', on: 1 }))).toEqual([])
    expect(does(step(state, { is: 'turn', on: 2 }))).toEqual(['write'])
  })

  it('takes nothing more from a connection it turned away, whatever is said on it next', () => {
    const step = core(setup({ kind: 'handed', session: 'here' }))
    const state = start()
    step(state, { is: 'carry', on: 1 })
    expect(does(step(state, { is: 'data', on: 1, message: '["not a hello"]', backlog: 0 }))).toEqual(['write', 'close'])
    expect(step(state, { is: 'data', on: 1, message: helloOf('there'), backlog: 0 })).toEqual([])
    expect(state.theirs).toBeUndefined()
  })

  it('takes nothing from a connection that waited and closed', () => {
    const step = core(setup({ kind: 'handed', session: 'here' }))
    const state = start()
    step(state, { is: 'carry', on: 1 })
    step(state, { is: 'data', on: 1, message: helloOf('there'), backlog: 0 })
    step(state, { is: 'carry', on: 2 })
    step(state, { is: 'closed', on: 2 })
    expect(step(state, { is: 'data', on: 2, message: helloOf('there', { resumes: 'here' }), backlog: 0 })).toEqual([])
    expect(state.now?.id).toBe(1)
  })

  it('opens no connection for a clock that was called off, or while it is on one', () => {
    const step = core(setup({ kind: 'opens', session: 'here' }))
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
    expect(() => setup({ kind: 'once', session: 'x', part: 8 })).toThrow(RangeError)
    expect(() => setup({ kind: 'once', session: 'x', bound: { frame: 100 } })).toThrow(RangeError)
  })
})
