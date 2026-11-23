// The model every scenario's ends are held to, shown able to fail: ends that are not a link's, each wrong in one
// way, are each found, and what a link may do is let pass.
import { describe, expect, it } from 'vitest'
import { link, type Bye, type Ending, type Frame, type Link, type Transport } from '../src/index.ts'
import { everyOrder, memoryEnds, model, underModel, type Model } from '../src/testing/index.ts'
import { msgpack } from './support/msgpack.ts'

/** An end that does what it is told to, and nothing a link does: it hands over what the spec says, when it says. */
const puppet = (refuses: (frame: Frame) => boolean = () => false) => {
  const hears: Array<(frame: Frame) => void> = []
  const ends: Array<(ending: Ending) => void> = []
  const closed: Array<Bye | undefined> = []
  const made = {
    closed,
    hand: (frame: Frame) => { for (const hear of hears) hear(frame) },
    end: (ending: Ending) => { for (const ended of ends) ended(ending) },
    link: {
      send: (frame) => { if (!('prepared' in frame) && refuses(frame)) throw new RangeError('refused') },
      prepare: (frame) => ({ prepared: frame.kind }),
      onFrame: (hear) => { hears.push(hear) },
      onTraffic: () => {},
      onEnd: (ended) => { ends.push(ended) },
      close: (bye) => { closed.push(bye) },
      carry: () => {},
      kept: () => 0,
      waiting: () => 0,
      awaiting: () => () => {},
    } satisfies Link as Link,
  }
  return made
}
const two = (held: Model = model()) => {
  const [left, right] = [puppet(), puppet()]
  return { held, left, right, a: held.end(left.link, 'a'), b: held.end(right.link, 'b') }
}
const tell = (event: unknown): Frame => ({ kind: 'tell', to: 'x', event })
const shown = (id: number, update: unknown): Frame => ({ kind: 'shown', id, update })

describe('what the model lets pass', () => {
  it('frames handed over in the order they were sent, each way', () => {
    const { held, left, right, a, b } = two()
    a.send(tell(1))
    b.send(tell('one'))
    a.send(tell(2))
    right.hand(tell(1))
    left.hand(tell('one'))
    right.hand(tell(2))
    held.check()
  })

  it("a view's result that took the place of an earlier one, where the earlier one was", () => {
    const { held, right, a } = two()
    a.send(shown(1, 'first'))
    a.send(tell('between'))
    a.send(shown(1, 'second'))
    a.send(shown(2, 'another'))
    a.send(shown(1, 'third'))
    right.hand(shown(1, 'third'))
    right.hand(tell('between'))
    right.hand(shown(2, 'another'))
    held.check()
  })

  it('a frame that was refused: it was never sent', () => {
    const held = model()
    const [left, right] = [puppet((frame) => frame.kind === 'tell' && frame.event === 'too much'), puppet()]
    const a = held.end(left.link, 'a')
    held.end(right.link, 'b')
    a.send(tell(1))
    expect(() => a.send(tell('too much'))).toThrow(RangeError)
    a.send(tell(2))
    right.hand(tell(1))
    right.hand(tell(2))
    held.check()
  })

  it('a frame as it was when it was prepared, whatever became of it after', () => {
    const { held, right, a } = two()
    const event = { at: 1 }
    const ready = a.prepare(tell(event))
    event.at = 2
    a.send(ready)
    right.hand(tell({ at: 1 }))
    held.check()
  })

  it('what an end sent before the end it reaches was made', () => {
    const held = model()
    const [left, first, second] = [puppet(), puppet(), puppet()]
    const a = held.end(left.link, 'a')
    held.end(first.link, 'b')
    a.send(tell(1))
    first.end({ why: 'closed' })
    held.end(second.link, 'b again')
    a.send(tell(2))
    second.hand(tell(1))
    second.hand(tell(2))
    held.check()
  })

  it('an end lost once the other has gone, and a goodbye that was said', () => {
    const { held, left, right, b } = two()
    b.close('ended')
    right.end({ why: 'closed' })
    left.end({ why: 'goodbye', bye: 'ended' })
    held.check()
    const again = two()
    again.right.end({ why: 'closed' })
    again.left.end({ why: 'lost' })
    again.held.check()
  })

  it('what was sent after an end ended, and what was sent to one that has', () => {
    const { held, left, right, a, b } = two()
    left.end({ why: 'closed' })
    a.send(tell('into nothing'))
    b.send(tell('to nobody'))
    held.check()
    expect(right.closed).toEqual([])
  })

  it('a frame as it crosses: what its encoding leaves out is not looked for', () => {
    const { held, right, a } = two()
    a.send(tell({ here: 1, gone: undefined }))
    right.hand(tell({ here: 1 }))
    held.check()
  })

  it('what an end was sent by one that is talking to another, and never handed', () => {
    const held = model()
    const [a, b, c] = [puppet(), puppet(), puppet()].map((one, at) => ({ one, link: held.end(one.link, 'abc'[at]!) }))
    c!.link.send(tell('from c'))
    a!.one.hand(tell('from c'))
    c!.one.end({ why: 'closed' })
    a!.link.send(tell('to c'))
    expect(b).toBeDefined()
    held.check()
  })

  it('bytes, with the codec the ends were given', () => {
    const { held, right, a } = two(model({ codec: msgpack }))
    a.send(tell(new Uint8Array([1, 2, 3])))
    right.hand(tell(new Uint8Array([1, 2, 3])))
    held.check()
  })
})

describe('what the model finds', () => {
  const found = (run: (ends: ReturnType<typeof two>) => void, held?: Model): string => {
    const ends = two(held)
    run(ends)
    try { ends.held.check() } catch (error) { return (error as Error).message }
    return 'nothing'
  }

  it('a frame handed over ahead of one sent before it', () => {
    expect(found(({ right, a }) => { a.send(tell(1)); a.send(tell(2)); right.hand(tell(2)) })).toMatch(/b was handed a frame that is not the next one any end sent it: .*"event":2/)
  })

  it('a frame handed over twice', () => {
    expect(found(({ right, a }) => { a.send(tell(1)); right.hand(tell(1)); right.hand(tell(1)) })).toMatch(/not the next one/)
  })

  it('a frame handed over that nobody sent, and one changed on the way', () => {
    expect(found(({ right }) => { right.hand(tell(1)) })).toMatch(/not the next one/)
    expect(found(({ right, a }) => { a.send(tell({ n: 1 })); right.hand(tell({ n: 1, more: true })) })).toMatch(/not the next one/)
    expect(found(({ right, a }) => { a.send(tell([1, 2])); right.hand(tell({ 0: 1, 1: 2 })) })).toMatch(/not the next one/)
  })

  it('a frame handed back to the end that sent it', () => {
    expect(found(({ left, a }) => { a.send(tell(1)); left.hand(tell(1)) })).toMatch(/a was handed a frame that is not the next one/)
  })

  it("a view's result left out with nothing to take its place, and one that took the place of another view's", () => {
    expect(found(({ right, a }) => { a.send(shown(1, 'first')); a.send(tell('after')); right.hand(tell('after')) })).toMatch(/not the next one/)
    expect(found(({ right, a }) => { a.send(shown(1, 'first')); a.send(shown(2, 'other')); right.hand(shown(2, 'other')) })).toMatch(/not the next one/)
  })

  it("a view's result handed over after the one that took its place", () => {
    expect(found(({ right, a }) => {
      a.send(shown(1, 'first'))
      a.send(shown(1, 'second'))
      right.hand(shown(1, 'second'))
      right.hand(shown(1, 'first'))
    })).toMatch(/not the next one/)
  })

  it("a frame that is not a view's result left out for a later one like it", () => {
    expect(found(({ right, a }) => { a.send(tell(1)); a.send(tell(2)); a.send(tell(1)); right.hand(tell(1)); right.hand(tell(1)) })).toMatch(/not the next one/)
  })

  it('a frame handed to an end after it ended, and an end ending twice', () => {
    expect(found(({ left, right, a }) => { a.send(tell(1)); right.end({ why: 'closed' }); right.hand(tell(1)); left.end({ why: 'closed' }) })).toMatch(/b was handed a frame after it ended/)
    expect(found(({ right }) => { right.end({ why: 'closed' }); right.end({ why: 'closed' }) })).toMatch(/b ended twice/)
  })

  it('an end lost with every end still there, and a goodbye nobody said', () => {
    expect(found(({ left }) => { left.end({ why: 'lost' }) })).toMatch(/a ended lost, with every end still there/)
    expect(found(({ left }) => { left.end({ why: 'lost' }) }, model({ may: ['lost'] }))).toBe('nothing')
    expect(found(({ left, right, b }) => { b.close('restarting'); right.end({ why: 'closed' }); left.end({ why: 'goodbye', bye: 'ended' }) })).toMatch(/a goodbye nobody said: ended/)
    expect(found(({ left, a }) => { a.close('ended'); left.end({ why: 'goodbye', bye: 'ended' }) })).toMatch(/a goodbye nobody said/)
  })

  it('an end that ended for what crossed, unless it may', () => {
    for (const ending of [{ why: 'out of order', expected: 1, got: 2 }, { why: 'not a frame', size: 1 }, { why: 'version', mine: 1, theirs: 2 }, { why: 'too narrow', most: 1, needs: 2 }] as const) {
      expect(found(({ left }) => { left.end(ending) })).toMatch(new RegExp(`a ended ${ending.why}`))
      expect(found(({ left }) => { left.end(ending) }, model({ may: [ending.why] }))).toBe('nothing')
    }
    expect(found(({ left }) => { left.end({ why: 'overrun', waiting: { frames: 2, size: 2 }, bound: { frames: 1, size: 1 } }) })).toBe('nothing')
  })

  it('what an end still there was sent by the other, and at rest has not been handed', () => {
    expect(found(({ right, a }) => { a.send(tell(1)); a.send(tell(2)); right.hand(tell(1)) })).toMatch(/at rest, b has not been handed what a sent it: .*"event":2/)
    expect(found(({ right, a }) => { a.send(tell(1)); a.send(tell(2)); right.hand(tell(1)) }, model({ unfinished: true }))).toBe('nothing')
    expect(found(({ a }) => { a.send(shown(1, 'first')); a.send(shown(1, 'second')) })).toMatch(/has not been handed/)
  })

  it('two ends handed the frames one end sent, and an end handed frames by one that is talking to another', () => {
    const held = model()
    const [left, first, second] = [puppet(), puppet(), puppet()]
    const a = held.end(left.link, 'a')
    held.end(first.link, 'b')
    held.end(second.link, 'c')
    a.send(tell(1))
    first.hand(tell(1))
    second.hand(tell(1))
    expect(() => held.check()).toThrow(/handed frames by an end that was handed its own by another/)

    const other = model()
    const ends = [puppet(), puppet(), puppet()].map((one, at) => ({ one, link: other.end(one.link, 'abc'[at]!) }))
    ends[0]!.link.send(tell('from a'))
    ends[2]!.link.send(tell('from c'))
    ends[1]!.one.hand(tell('from a'))
    ends[0]!.one.hand(tell('from c'))
    expect(() => other.check()).toThrow(/handed frames by an end that was handed its own by another/)
  })

  it('three ends each handed what another sent, where no two can be talking to each other', () => {
    const held = model()
    const ends = [puppet(), puppet(), puppet()].map((one, at) => ({ one, link: held.end(one.link, 'abc'[at]!) }))
    for (const { link: end } of ends) end.send(tell('the same'))
    for (const { one } of ends) one.hand(tell('the same'))
    expect(() => held.check()).toThrow(/handed frames by an end that was handed its own by another/)
  })

  it('a frame handed over that was sent by an end after it ended', () => {
    expect(found(({ left, right, a }) => { left.end({ why: 'closed' }); a.send(tell('after')); right.hand(tell('after')) })).toMatch(/not the next one/)
  })

  it('says what led to it', () => {
    expect(found(({ right, a }) => { a.send(tell(1)); a.send(tell(2)); right.hand(tell(2)) })).toMatch(/after:\n\s+a sent .*"event":1.*\n\s+a sent .*"event":2.*\n\s+b was handed/)
  })
})

describe('real ends under the model', () => {
  it('a scenario whose check passes fails for what the model finds in it', async () => {
    // The second end hands over each frame twice, as a link that took a frame again would: nothing here looks.
    const doubled = (real: Link): Link => ({ ...real, onFrame: (hear) => real.onFrame((frame, cause) => { hear(frame, cause); hear(frame, cause) }) })
    await expect(everyOrder((schedule) => underModel((held) => {
      const ends = memoryEnds(schedule)
      const [a] = [held.end(ends.a, 'a'), held.end(doubled(ends.b), 'b')]
      a.send(tell(1))
      return () => {}
    }))).rejects.toThrow(/Not what the model does: b was handed a frame that is not the next one/)
  })

  it('holds a link to it across every order of both ends sending and one closing', async () => {
    expect(await everyOrder((schedule) => underModel((held) => {
      const { a, b } = memoryEnds(schedule, {}, held)
      schedule.does('a', ['sends', () => a.send(tell(1))], ['closes', () => a.close('ended')])
      schedule.does('b', ['sends', () => b.send(tell('one'))])
      return () => {}
    }))).toBeGreaterThan(10)
  })

  it('finds two links carried on something that loses what it is handed', () => {
    const lossy = (): Transport => ({ send: () => {}, onData: () => {}, onClose: () => {}, close: () => {} })
    const held = model()
    const a = held.end(link(lossy()), 'a')
    held.end(link(lossy()), 'b')
    a.send(tell(1))
    expect(() => held.check()).toThrow(/at rest, b has not been handed what a sent it/)
  })
})
