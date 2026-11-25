// A stream of bytes, put back into messages: in work that grows with the bytes and not with how many pieces they
// came in, within a bound on how long a message may claim to be, and letting go of the stream beneath when it
// closes for what arrived. The stream beneath is one the spec feeds by hand.
import { setFlagsFromString } from 'node:v8'
import * as vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { stream, type DuplexLike, type Message } from '../src/index.ts'

/** A stream the spec is the other end of: `feed` hands it a piece, and what was written, ended or let go is noted. */
const fed = (has: { destroy: boolean } = { destroy: true }) => {
  const listeners: { data?: (chunk: Uint8Array) => void } = {}
  const noted = { written: [] as Uint8Array[], ended: 0, destroyed: 0 }
  const duplex: DuplexLike = {
    write: (chunk) => { noted.written.push(chunk) },
    end: () => { noted.ended++ },
    ...(has.destroy ? { destroy: () => { noted.destroyed++ } } : {}),
    on: (event: string, listener: never) => { if (event === 'data') listeners.data = listener },
  }
  return { duplex, noted, feed: (chunk: Uint8Array) => { listeners.data!(chunk) } }
}
const listening = (duplex: DuplexLike, options?: { most?: number }) => {
  const transport = stream(duplex, options)
  const heard: Message[] = []
  let closed = 0
  transport.onData((message) => { heard.push(message) })
  transport.onClose(() => { closed++ })
  return { transport, heard, closed: () => closed }
}
const framed = (kind: number, body: Uint8Array, claims = body.length): Uint8Array => {
  const out = new Uint8Array(5 + body.length)
  out[0] = kind
  new DataView(out.buffer).setUint32(1, claims)
  out.set(body, 5)
  return out
}
const pieces = (all: Uint8Array, size: number): Uint8Array[] => {
  const out: Uint8Array[] = []
  for (let at = 0; at < all.length; at += size) out.push(all.subarray(at, Math.min(all.length, at + size)))
  return out
}

/**
 * Runs something, counting every byte put into a new array of bytes or copied into one: the work putting a
 * message together is. Reading bytes where they lie, and turning them into text, are not counted.
 */
const counting = (run: () => void): number => {
  const Real = globalThis.Uint8Array
  const { set, slice } = Real.prototype
  let work = 0
  const counted: typeof Real = new Proxy(Real, {
    construct: (target, args: unknown[], newTarget) => {
      const made = Reflect.construct(target, args, newTarget === counted ? target : newTarget) as Uint8Array
      work += made.length
      return made
    },
  })
  globalThis.Uint8Array = counted
  Real.prototype.set = function (this: Uint8Array, source: ArrayLike<number>, offset?: number) { work += source.length; set.call(this, source, offset) }
  Real.prototype.slice = function (this: Uint8Array, start?: number, end?: number) { const made = slice.call(this, start, end); work += made.length; return made }
  try { run() } finally {
    globalThis.Uint8Array = Real
    Real.prototype.set = set
    Real.prototype.slice = slice
  }
  return work
}

describe('putting a message together', () => {
  for (const [what, kind, length, size] of [
    ['bytes, four million in pieces of four thousand', 1, 4 << 20, 4096],
    ['text, four million in pieces of four thousand', 0, 4 << 20, 4096],
    ['bytes, a quarter of a million in pieces of sixteen', 1, 1 << 18, 16],
    ['bytes, forty thousand in pieces of one', 1, 40_000, 1],
  ] as const) {
    it(`copies each byte a fixed number of times, however many pieces it came in: ${what}`, () => {
      const body = new Uint8Array(length).fill(0x61)
      const message = framed(kind, body)
      const chunks = pieces(message, size)
      const { duplex, feed } = fed()
      const { heard } = listening(duplex)
      const work = counting(() => { for (const chunk of chunks) feed(chunk) })
      expect(heard).toHaveLength(1)
      expect(heard[0]).toHaveLength(length)
      // Joined once. Copying everything pending for each piece would be hundreds of times this.
      expect(work).toBeLessThanOrEqual(2 * message.length)
    })
  }

  it('copies each byte a fixed number of times when many messages arrive as one piece', () => {
    const one = framed(1, new Uint8Array(100).fill(7))
    const all = new Uint8Array(one.length * 10_000)
    for (let at = 0; at < all.length; at += one.length) all.set(one, at)
    const { duplex, feed } = fed()
    const { heard } = listening(duplex)
    const work = counting(() => { feed(all) })
    expect(heard).toHaveLength(10_000)
    expect(work).toBeLessThanOrEqual(2 * all.length)
  })

  it('hands over the same messages however they are cut into pieces', () => {
    const text = '[{"link":1}] — past one byte a character: ✓ 𝄞'
    const sent = [framed(0, new TextEncoder().encode(text)), framed(1, new Uint8Array([0, 255, 7])), framed(0, new Uint8Array(0)), framed(1, new Uint8Array(0))]
    const all = new Uint8Array(sent.reduce((sum, one) => sum + one.length, 0))
    let at = 0
    for (const one of sent) { all.set(one, at); at += one.length }
    for (const size of [1, 2, 3, 5, 7, 64, all.length]) {
      const { duplex, feed } = fed()
      const { heard, closed } = listening(duplex)
      for (const chunk of pieces(all, size)) feed(chunk)
      expect(heard).toEqual([text, new Uint8Array([0, 255, 7]), '', new Uint8Array(0)])
      expect(closed()).toBe(0)
    }
  })

  it('hands over bytes that are nobody else\'s: the piece they came in can be used again', () => {
    const { duplex, feed } = fed()
    const { heard } = listening(duplex)
    const piece = framed(1, new Uint8Array([1, 2, 3]))
    feed(piece)
    piece.fill(9)
    expect(heard).toEqual([new Uint8Array([1, 2, 3])])
  })

  it('lets go of pieces already taken even when no piece ends on a message boundary', async () => {
    setFlagsFromString('--expose_gc')
    const gc = vm.runInNewContext('gc') as () => void
    const { duplex, feed } = fed()
    let count = 0
    stream(duplex).onData(() => { count++ })
    const one = framed(1, new Uint8Array(1024).fill(7))
    const ref = (() => { const piece = one.slice(0, 3); feed(piece); return new WeakRef(piece) })()
    for (let at = 0; at < 1000; at++) {
      const chunk = new Uint8Array(one.length)
      chunk.set(one.subarray(3), 0)
      chunk.set(one.subarray(0, 3), one.length - 3)
      feed(chunk)
    }
    expect(count).toBe(1000)
    // WeakRef.deref() pins its target for the current job, so run gc() on a fresh turn before reading deref().
    for (let tries = 0; tries < 20; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      gc()
      if (ref.deref() === undefined) break
    }
    expect(ref.deref()).toBeUndefined()
  })
})

describe('a message longer than a stream takes', () => {
  it('closes the stream where its head arrives, and lets go of the stream beneath', () => {
    const { duplex, noted, feed } = fed()
    const { heard, closed } = listening(duplex, { most: 10 })
    feed(framed(0, new TextEncoder().encode('0123456789')))
    expect([heard, closed(), noted.destroyed]).toEqual([['0123456789'], 0, 0])
    // Only its head: nothing is kept to wait for the rest.
    feed(framed(0, new Uint8Array(0), 11))
    expect([heard.length, closed(), noted.destroyed]).toEqual([1, 1, 1])
    feed(framed(0, new TextEncoder().encode('late')))
    expect(heard).toHaveLength(1)
  })

  it('is, unless told, one of more than 128 MiB, and the transport says so', () => {
    const most = 128 * 1024 * 1024
    expect(stream(fed().duplex).most).toBe(most)
    expect(stream(fed().duplex, { most: 10 }).most).toBe(10)
    const within = fed()
    const taking = listening(within.duplex)
    within.feed(framed(1, new Uint8Array(0), most))
    expect(taking.closed()).toBe(0)
    const past = fed()
    const refusing = listening(past.duplex)
    past.feed(framed(1, new Uint8Array(0), most + 1))
    expect([refusing.closed(), past.noted.destroyed]).toEqual([1, 1])
  })

  it('is not sent: the stream closes, with nothing written', () => {
    const { duplex, noted } = fed()
    const { transport, closed } = listening(duplex, { most: 4 })
    transport.send('four')
    expect(noted.written).toHaveLength(1)
    transport.send('✓✓')
    expect([noted.written.length, closed(), noted.ended]).toEqual([1, 1, 1])
  })

  it('refuses a most that is not a positive whole number of bytes within 32-bit length range', () => {
    for (const most of [0, -1, 1.5, NaN, Infinity, 0x1_0000_0000]) {
      expect(() => stream(fed().duplex, { most })).toThrow(RangeError)
    }
    expect(stream(fed().duplex, { most: 0xffff_ffff }).most).toBe(0xffff_ffff)
  })
})

describe('a stream that closes for what arrived', () => {
  for (const [what, bytes] of [
    ['a kind that is neither text nor bytes', new Uint8Array([9, 0, 0, 0, 1, 1])],
    ['text that is not UTF-8', framed(0, new Uint8Array([0xff, 0xfe]))],
  ] as const) {
    it(`lets go of the stream beneath: ${what}`, () => {
      const { duplex, noted, feed } = fed()
      const { heard, closed } = listening(duplex)
      feed(bytes)
      expect([heard, closed(), noted.destroyed, noted.ended]).toEqual([[], 1, 1, 0])
    })

    it(`ends a stream beneath that cannot be let go at once: ${what}`, () => {
      const { duplex, noted, feed } = fed({ destroy: false })
      const { closed } = listening(duplex)
      feed(bytes)
      expect([closed(), noted.ended]).toEqual([1, 1])
    })
  }
})
