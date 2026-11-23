// The codec built in, and the pieces of the testing kit a spec of another end is written with: each does what its
// doc says, so that a scenario that passes says something.
import { describe, expect, it } from 'vitest'
import { asFrame, join, json, dial, listen, memoryPair, type Port } from '../src/index.ts'
import { asking, desk, everyOrder, holds, made, memoryEnds, same, watching } from '../src/testing/index.ts'

describe('json', () => {
  it('gives back what it was given, from text and from the same text as bytes', () => {
    const value = { a: [1, 'two', null, { three: true }], é: 'ü' }
    expect(json.decode(json.encode(value))).toEqual(value)
    expect(json.decode(new TextEncoder().encode(json.encode(value) as string))).toEqual(value)
  })

  it('joins encoded values as a list and as a record, which read back as the values', () => {
    const parts = [json.encode(1), json.encode({ b: 'c' })]
    expect(json.decode(json.list(parts))).toEqual([1, { b: 'c' }])
    expect(json.decode(json.record([['x', parts[0]!], ['a "quoted" name', parts[1]!]]))).toEqual({ x: 1, 'a "quoted" name': { b: 'c' } })
  })

  it('refuses a value JSON cannot hold, and text it did not make', () => {
    expect(() => json.encode(undefined)).toThrow()
    expect(() => json.encode(() => {})).toThrow()
    expect(() => json.encode(1n)).toThrow()
    expect(() => json.decode('{not json')).toThrow()
  })
})

describe('asFrame', () => {
  it('gives back each of the nine frames with its own fields, and nothing else that came with it', () => {
    const failure = { kind: 'gone', message: 'No such view' }
    const frames = [
      { kind: 'tell', to: 't', event: { any: ['thing'] } },
      { kind: 'ask', id: 1, to: 't', name: 'N', args: null },
      { kind: 'progress', id: 1, update: 1 },
      { kind: 'answer', id: 1, outcome: { ok: true, value: 2 } },
      { kind: 'left', id: 1 },
      { kind: 'follow', id: 2, feature: 'f', view: 'v', args: [] },
      { kind: 'shown', id: 2, update: 'x' },
      { kind: 'unfollow', id: 2 },
      { kind: 'over', id: 2, failure },
    ]
    for (const frame of frames) expect(asFrame({ ...frame, extra: 'left behind' })).toEqual(frame)
    expect(asFrame({ kind: 'over', id: 2, failure: { ...failure, stack: 'left behind' } })).toEqual({ kind: 'over', id: 2, failure })
  })

  it('is nothing for what is not one of them', () => {
    for (const arrived of [
      null, 'tell', [], { kind: 'shout', id: 1 },
      { kind: 'tell', event: 1 }, { kind: 'ask', id: 1, to: 't', args: 1 }, { kind: 'follow', id: 1, feature: 'f', args: 1 },
      { kind: 'left', id: 0 }, { kind: 'left', id: 1.5 }, { kind: 'left', id: '1' },
      { kind: 'over', id: 1, failure: 'gone' }, { kind: 'over', id: 1, failure: { kind: 'gone' } },
    ]) expect(asFrame(arrived)).toBeUndefined()
  })
})

describe('same and holds', () => {
  it('pass what holds and throw, saying what was looked at, for what does not', () => {
    same({ a: [1, { b: null }] }, { a: [1, { b: null }] }, 'alike')
    holds(true, 'true')
    for (const [actual, expected] of [[{ a: 1 }, { a: 1, b: 2 }], [[1, 2], [2, 1]], [[], {}], [null, {}], [{ a: undefined }, { b: undefined }], [NaN, 0]] as const) {
      expect(() => same(actual, expected, 'the thing')).toThrow(/the thing/)
    }
    expect(() => holds(false, 'that one')).toThrow(/that one/)
  })
})

describe('two ends in memory', () => {
  it('are one that dials and one that listens: the second says nothing until the first has, so there is one order they meet in', async () => {
    expect(await everyOrder((schedule) => { memoryEnds(schedule); return () => {} })).toBe(1)
  })
})

describe('asking and watching', () => {
  const ends = (mine: Port): Port => {
    const [left, right] = memoryPair()
    join(listen(right), mine)
    return join(dial(left), desk().port)
  }

  it('note what an asker hears and how it ended, in order', async () => {
    const other = desk({ ask: (asked) => { asked.heard('half'); asked.ended({ ok: true, value: 'done' }) } })
    const ask = asking(ends(other.port), 'threads', 'CREATE', { topic: 'one' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(other.asks.map(({ to, name, args }) => ({ to, name, args }))).toEqual([{ to: 'threads', name: 'CREATE', args: { topic: 'one' } }])
    expect(ask.heard).toEqual(['half'])
    expect(ask.ended).toEqual([{ ok: true, value: 'done' }])
    expect(ask.log).toEqual(['heard', 'ended'])
  })

  it('note leaving, which reaches the system asked', async () => {
    const other = desk()
    const ask = asking(ends(other.port), 'threads', 'WAIT', null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    ask.leave()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ask.log).toEqual(['left'])
    expect(other.asks.map((asked) => asked.left)).toEqual([1])
  })

  it('note what a view is shown and its stopping, which reaches the system running it', async () => {
    const other = desk({ follow: (viewed) => { viewed.shown(['first']) } })
    const view = watching(ends(other.port), 'threads', 'list', { open: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    other.views[0]!.shown(['first', 'second'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    view.stop()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.shown).toEqual([['first'], ['first', 'second']])
    expect(view.log).toEqual(['shown', 'shown', 'stopped'])
    expect(other.views.map((viewed) => viewed.stopped)).toEqual([1])
  })

  it('note a view ending, with why', async () => {
    const other = desk({ follow: (viewed) => { viewed.over({ kind: 'gone', message: 'No such list' }) } })
    const view = watching(ends(other.port), 'threads', 'list', null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.over).toEqual([{ kind: 'gone', message: 'No such list' }])
    expect(view.log).toEqual(['over'])
  })
})

describe('made', () => {
  it('shows each view the count when followed and each new count after, and calls back once caught up', async () => {
    await everyOrder((schedule) => {
      const things = made(schedule)
      const shown: unknown[] = []
      let caught = 0
      const viewed = { feature: 'f', view: 'count', args: null, shown: (update: unknown) => { shown.push(update) }, over: () => {}, stopped: 0 }
      const offered = things.follow(viewed)
      things.make()
      things.make()
      offered?.caughtUp?.(() => { caught++ }, true)
      return () => {
        // The count when followed, then each one made, in order, and the call back after the last.
        same(shown, [0, 1, 2], 'what the view was shown')
        same(caught, 1, 'times it called back')
        same(things.count, 2, 'how many were made')
        same(things.soon, [true], 'what it was asked with')
      }
    })
  })

  it('offers nothing to wait for when made without offers', async () => {
    await everyOrder((schedule) => {
      const things = made(schedule, { offers: false })
      const offered = things.follow({ feature: 'f', view: 'count', args: null, shown: () => {}, over: () => {}, stopped: 0 })
      return () => { holds(!offered?.caughtUp, 'no caughtUp is offered') }
    })
  })
})
