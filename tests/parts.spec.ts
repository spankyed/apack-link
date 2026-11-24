// A frame longer than a part crosses as parts, each numbered, and is handed over whole, in the place of its first
// part, with nothing between: no one write is much longer than a part, and a resume picks up within a frame.
import { once as eventOnce } from 'node:events'
import { describe, expect, it } from 'vitest'
import { decode } from '@msgpack/msgpack'
import { WebSocket, WebSocketServer } from 'ws'
import { accept, dial, LEAST, listen, memoryPair, socket, timers, type Ending, type Frame, type Message, type Traffic, type Transport } from '../src/index.ts'
import { msgpack } from './support/msgpack.ts'

const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })
const until = async (done: () => boolean): Promise<void> => { while (!done()) await turn() }
const sizeOf = (message: Message): number => (typeof message === 'string' ? message.length : message.byteLength)
const tell = (event: unknown): Frame => ({ kind: 'tell', to: 'x', event })

describe('a frame longer than a part', () => {
  for (const [name, codec] of [['JSON', undefined], ['msgpack', msgpack]] as const) {
    it(`arrives whole, in its place, in ${name}, with no write much longer than a part`, async () => {
      const [left, right] = memoryPair()
      const writes: Message[] = []
      const counted: Transport = { ...left, send: (message) => { writes.push(message); left.send(message) } }
      const options = { part: 100, ...(codec ? { codec } : {}) }
      const a = dial(counted, options)
      const b = listen(right, options)
      const heard: Frame[] = []
      const seen: Traffic[] = []
      const ended: Ending[] = []
      b.onFrame((frame) => { heard.push(frame) })
      b.onTraffic((traffic) => { seen.push(traffic) })
      b.onEnd((ending) => { ended.push(ending) })
      const big: Frame = { kind: 'shown', id: 1, update: { rows: Array.from({ length: 200 }, (_, at) => `row ${at} ✓`) } }
      a.send(tell('before'))
      a.send(big, { cause: 'a long one' })
      a.send(tell('after'))
      await until(() => heard.length === 3 || ended.length > 0)
      expect(ended).toEqual([])
      expect(heard).toEqual([tell('before'), big, tell('after')])
      // What crosses is the codec's: text for JSON, msgpack's bytes for msgpack.
      expect(new Set(writes.map((message) => typeof message))).toEqual(new Set([codec ? 'object' : 'string']))
      if (codec) expect((decode(writes[0] as Uint8Array) as unknown[])[0]).toMatchObject({ link: 1 })
      // Its place is its first part's, and the frame after it is numbered after its last part.
      const units = writes.flatMap((message) => (codec ? decode(message as Uint8Array) : JSON.parse(message as string)) as Array<Record<string, unknown>>)
      const pieces = units.filter((one) => 'part' in one).map((one) => one.data as Message)
      const parts = pieces.length
      expect(parts).toBeGreaterThan(10)
      // A part is no longer than a part may be, in bytes: text with characters of more than one byte is cut by them.
      expect(Math.max(...pieces.map((piece) => (typeof piece === 'string' ? new TextEncoder().encode(piece).byteLength : piece.byteLength)))).toBeLessThanOrEqual(100)
      expect(seen.map((traffic) => traffic.seq)).toEqual([1, 2, 2 + parts])
      expect(seen[1]).toMatchObject({ kind: 'shown', cause: 'a long one' })
      expect(Math.max(...writes.map(sizeOf))).toBeLessThan(400)
    })
  }

  it('is not a frame when what arrives between its parts is anything but its next part', async () => {
    const part = (seq: number, at: number, of: number, data: string) => ({ seq, part: at, of, data })
    const hello = { link: 1, session: 'bare', taken: 0 }
    for (const between of [
      [part(1, 0, 3, '{"kind":'), { seq: 2, frame: tell('in the middle') }],
      [part(1, 0, 3, '{"kind":'), part(2, 2, 3, '}')],
      [part(1, 0, 3, '{"kind":'), part(2, 1, 4, '"tell"')],
      [part(1, 1, 3, '"tell"')],
      [part(1, 0, 2, '{"kind":'), part(2, 1, 2, 'not the rest')],
    ]) {
      const [bare, right] = memoryPair()
      const end = listen(right)
      const heard: Frame[] = []
      const ended: Ending[] = []
      end.onFrame((frame) => { heard.push(frame) })
      end.onEnd((ending) => { ended.push(ending) })
      bare.send(JSON.stringify([hello, ...between]))
      await turn()
      expect(heard).toEqual([])
      expect(ended).toEqual([{ why: 'not a frame', size: expect.any(Number) }])
    }
  })

  it('survives a drop part-way, picking up where the other end got to', async () => {
    const backend = listen(undefined, { part: 50 })
    const heard: Frame[] = []
    const backendEnded: Ending[] = []
    backend.onFrame((frame) => { heard.push(frame) })
    backend.onEnd((ending) => { backendEnded.push(ending) })
    let delivered = 0
    let current: Transport | undefined
    let connections = 0
    const window = dial(() => {
      // An opener paces itself: it does not dial a backend that has ended, which would close each connection as it
      // opened and be opened again, without end. This one stays shut instead.
      if (backendEnded.length) return { send: () => {}, onData: () => {}, onClose: () => {}, close: () => {} }
      connections++
      const [left, right] = memoryPair()
      // The first connection drops once a few messages have arrived, and what was on its way on it is lost with it.
      const first = connections === 1
      const counting: Transport = {
        ...right,
        onData: (heard_) => right.onData((message) => {
          if (first && delivered >= 6) return
          heard_(message)
          if (first && ++delivered === 6) queueMicrotask(() => current?.close())
        }),
      }
      current = left
      backend.carry(counting)
      return left
    }, { part: 50, reopen: { clock: timers } })
    const ended: Ending[] = []
    window.onEnd((ending) => { ended.push(ending) })
    const big = tell('x'.repeat(2000))
    window.send(tell('before'))
    window.send(big)
    window.send(tell('after'))
    await until(() => heard.length === 3 || ended.length > 0 || backendEnded.length > 0)
    expect([ended, backendEnded]).toEqual([[], []])
    expect(connections).toBe(2)
    expect(heard).toEqual([tell('before'), big, tell('after')])
    expect(ended).toEqual([])
  })
})

describe('fifty megabytes over a WebSocket', () => {
  it('crosses in parts, arrives whole and in its place, and survives a drop part-way', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 4 * 1024 * 1024 })
    await eventOnce(server, 'listening')
    const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`
    const heard: Frame[] = []
    let accepted = 0
    const take = accept((made) => { made.onFrame((frame) => { heard.push(frame) }) })
    server.on('connection', (ws) => {
      accepted++
      let messages = 0
      // The first connection is cut once some of the frame has arrived.
      if (accepted === 1) ws.on('message', () => { if (++messages === 10) ws.terminate() })
      take(socket(ws as never))
    })
    const clients: WebSocket[] = []
    const writes: number[] = []
    const window = dial(() => {
      const ws = new WebSocket(url)
      clients.push(ws)
      const transport = socket(ws as never)
      return { ...transport, send: (message) => { writes.push(sizeOf(message)); transport.send(message) } }
    }, { reopen: { clock: timers } })
    const ended: Ending[] = []
    window.onEnd((ending) => { ended.push(ending) })
    try {
      const big = tell('é'.repeat(25 * 1024 * 1024))
      window.send(tell('before'))
      window.send(big)
      window.send(tell('after'))
      while (heard.length < 3 && !ended.length) await new Promise((resolve) => setTimeout(resolve, 5))
      expect(ended).toEqual([])
      expect(accepted).toBe(2)
      expect(heard).toHaveLength(3)
      expect(heard[0]).toEqual(tell('before'))
      expect(heard[1]).toEqual(big)
      expect(heard[2]).toEqual(tell('after'))
      expect(Math.max(...writes)).toBeLessThan(2 * 1024 * 1024)
    } finally {
      // The window first, so that it opens no more connections while the server closes.
      window.close()
      for (const ws of clients) ws.terminate()
      for (const ws of server.clients) ws.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 60_000)
})

describe('a part as it crosses', () => {
  const bytes = (message: Message): number => (typeof message === 'string' ? new TextEncoder().encode(message).byteLength : message.byteLength)
  /** One end on something that takes no message longer than `most`, noting how long each it is handed is. */
  const narrow = (most: number) => {
    const [left, right] = memoryPair()
    const writes: number[] = []
    const transport: Transport = { ...left, most, send: (message) => { writes.push(bytes(message)); left.send(message) } }
    return { transport, right, writes }
  }

  for (const [name, codec] of [['JSON', undefined], ['msgpack', msgpack]] as const) {
    for (const [what, event] of [
      ['quotes, each said in two as a part\'s data', '"'.repeat(960)],
      ['backslashes', '\\'.repeat(960)],
      ['what is said in six, with characters of more than one byte among it', '\u0001✓𝄞'.repeat(150)],
      ['plain text', 'x'.repeat(1900)],
    ] as const) {
      it(`is no longer than what carries the link takes, whatever the frame holds, in ${name}: ${what}`, async () => {
        // A frame may be 2048 bytes, a part nearly as long, and what carries the link takes no more than it must.
        const most = 2048 + 102 + 2
        const options = { bound: { frame: 2048 }, part: 1500, ...(codec ? { codec } : {}) }
        const { transport, right, writes } = narrow(most)
        const a = dial(transport, options)
        const heard: Frame[] = []
        const ended: Ending[] = []
        const b = listen(right, options)
        b.onFrame((frame) => { heard.push(frame) })
        b.onEnd((ending) => { ended.push(ending) })
        a.send(tell(event), { cause: 'c'.repeat(40) })
        await until(() => heard.length === 1 || ended.length > 0)
        expect([ended, heard]).toEqual([[], [tell(event)]])
        expect(Math.max(...writes)).toBeLessThanOrEqual(most)
      })
    }
  }

  it('holds no more than a part of data, in bytes as it crosses, down to the shortest a part may be', async () => {
    for (const part of [16, 17, 50, 333]) {
      const [left, right] = memoryPair()
      const said: Array<Record<string, unknown>> = []
      const a = dial({ ...left, send: (message) => { said.push(...JSON.parse(message as string) as Array<Record<string, unknown>>); left.send(message) } }, { part })
      const heard: Frame[] = []
      listen(right, { part }).onFrame((frame) => { heard.push(frame) })
      // The second is nothing but what is said in two, and in two again as data: cut once more is not enough for it.
      const frames = [tell('"\\\u0001✓𝄞 plain '.repeat(60)), tell('"'.repeat(200))]
      for (const frame of frames) a.send(frame)
      await until(() => heard.length === 2)
      expect(heard).toEqual(frames)
      const data = said.filter((one) => 'part' in one).map((one) => JSON.stringify(one.data))
      expect([part, Math.max(...data.map(bytes)) <= part]).toEqual([part, true])
    }
    expect(() => dial(memoryPair()[0], { part: 15 })).toThrow(RangeError)
  })
})

describe('the parts of a frame, as they arrive', () => {
  const part = (seq: number, at: number, of: number, data: string) => ({ seq, part: at, of, data })
  const hello = { link: 1, session: 'bare', taken: 0 }
  /** A link that takes frames of 2048 bytes at most, facing a bare end. */
  const facing = () => {
    const [bare, right] = memoryPair()
    const heard: Frame[] = []
    const ended: Ending[] = []
    const b = listen(right, { bound: { frame: 2048 } })
    b.onFrame((frame) => { heard.push(frame) })
    b.onEnd((ending) => { ended.push(ending) })
    bare.send(JSON.stringify([hello]))
    return { bare, heard, ended }
  }

  it('end the link once they add up to more than a frame may be, however many more are said to be coming', async () => {
    const { bare, heard, ended } = facing()
    const piece = 'x'.repeat(1000)
    const last = JSON.stringify([part(3, 2, 1_000_000, piece)])
    bare.send(JSON.stringify([part(1, 0, 1_000_000, piece)]))
    bare.send(JSON.stringify([part(2, 1, 1_000_000, piece)]))
    await turn()
    expect(ended).toEqual([])
    // The third is past 2048 bytes.
    bare.send(last)
    for (let at = 3; at < 50; at++) bare.send(JSON.stringify([part(at + 1, at, 1_000_000, piece)]))
    await turn()
    expect([heard, ended]).toEqual([[], [{ why: 'not a frame', size: last.length }]])
  })

  it('are taken when they add up to exactly as much as a frame may be', async () => {
    const { bare, heard, ended } = facing()
    const frame = tell('x'.repeat(2048 - JSON.stringify(tell('')).length))
    const text = JSON.stringify(frame)
    bare.send(JSON.stringify([part(1, 0, 2, text.slice(0, 1024)), part(2, 1, 2, text.slice(1024))]))
    await turn()
    expect([heard, ended]).toEqual([[frame], []])
  })

  it('end the link when one of them holds nothing', async () => {
    const { bare, heard, ended } = facing()
    const text = JSON.stringify([part(1, 0, 1_000_000, '{"kind":'), part(2, 1, 1_000_000, '')])
    bare.send(text)
    await turn()
    expect([heard, ended]).toEqual([[], [{ why: 'not a frame', size: text.length }]])
  })
})

describe('how a frame is cut', () => {
  const bytes = (message: Message): number => (typeof message === 'string' ? new TextEncoder().encode(message).byteLength : message.byteLength)

  for (const [what, event] of [
    ['plain text', 'x'.repeat(3000)],
    ['quotes, each said in two and in two again as data', '"'.repeat(1500)],
    ['backslashes', '\\'.repeat(1500)],
    ['characters of three bytes', '✓'.repeat(1000)],
  ] as const) {
    it(`leaves no part but the last much shorter than a part may be: ${what}`, async () => {
      for (const part of [100, 257]) {
        const [left, right] = memoryPair()
        const said: Array<Record<string, unknown>> = []
        const a = dial({ ...left, send: (message) => { said.push(...JSON.parse(message as string) as Array<Record<string, unknown>>); left.send(message) } }, { part })
        const heard: Frame[] = []
        listen(right, { part }).onFrame((frame) => { heard.push(frame) })
        a.send(tell(event))
        await until(() => heard.length === 1)
        expect(heard).toEqual([tell(event)])
        const data = said.filter((one) => 'part' in one).map((one) => bytes(JSON.stringify(one.data)))
        expect([part, Math.max(...data) <= part]).toEqual([part, true])
        // Within a character or two of full: a quote is four bytes as data, and a part's data has two around it.
        expect([part, Math.min(...data.slice(0, -1)) >= part - 8]).toEqual([part, true])
      }
    })
  }
})

describe('what a link needs of what carries it, with frames in parts', () => {
  const bytes = (message: Message): number => (typeof message === 'string' ? new TextEncoder().encode(message).byteLength : message.byteLength)
  const options = { bound: { frame: 100_000 } }
  const narrow = (most: number) => {
    const [left, right] = memoryPair()
    const writes: number[] = []
    let closed = 0
    const transport: Transport = { ...left, most, send: (message) => { writes.push(bytes(message)); left.send(message) }, close: () => { closed++; left.close() } }
    return { transport, right, writes, closed: () => closed }
  }
  const watched = (link: ReturnType<typeof dial>) => {
    const heard: Array<{ frame: Frame; cause: string | undefined }> = []
    const ended: Ending[] = []
    link.onFrame((frame, cause) => { heard.push({ frame, cause }) })
    link.onEnd((ending) => { ended.push(ending) })
    return { heard, ended }
  }
  const cause = 'c'.repeat(1022)
  const around = JSON.stringify(tell('')).length
  /** As large as a frame may be here, of text that is twice as long as a part's data. */
  const largest = tell('"'.repeat((100_000 - 1024 - around) / 2))

  it('is 1144 bytes at the least, whatever a link is set with: the shortest part, the longest cause, what goes around them, and the batch\'s two', () => {
    expect(LEAST).toBe(16 + 1024 + 102 + 2)
  })

  it('is the least any link is carried on, however long a part is said to be: a frame as large as one may be crosses on it, cut to fit', async () => {
    for (const part of [undefined, 2000, 64]) {
      const { transport, right, writes } = narrow(LEAST)
      const a = dial(transport, { ...options, ...(part ? { part } : {}) })
      const { heard, ended } = watched(listen(right, options))
      // And one short enough to cross whole, beside the longest cause there may be.
      const whole = tell('x')
      // And one that would cross whole by itself, and not beside what caused it.
      const beside = tell('y'.repeat(900))
      a.send(largest, { cause })
      a.send(whole, { cause })
      a.send(beside, { cause })
      await until(() => heard.length === 3 || ended.length > 0)
      expect([part, ended]).toEqual([part, []])
      expect(heard).toEqual([{ frame: largest, cause }, { frame: whole, cause }, { frame: beside, cause }])
      expect([part, Math.max(...writes) <= LEAST]).toEqual([part, true])
    }
  })

  it('is as much of a part as there is room for: parts are no shorter than what carries them makes them', async () => {
    const sizes = async (most: number, part: number | undefined, caused?: string): Promise<number[]> => {
      const { transport, right } = narrow(most)
      const a = dial(transport, { ...options, ...(part ? { part } : {}) })
      const crossed: number[] = []
      right.onData((message) => { for (const said of JSON.parse(message as string) as Array<{ data?: string }>) if (said.data !== undefined) crossed.push(bytes(JSON.stringify(said.data))) })
      a.send(tell('x'.repeat(50_000)), caused === undefined ? {} : { cause: caused })
      await turn()
      return crossed
    }
    // What carries it takes 5000: a part's data is all of that but what goes around it, and no more than a part where one is said.
    const fitted = await sizes(5000, undefined)
    expect(Math.max(...fitted)).toBeLessThanOrEqual(5000 - 104)
    expect(Math.min(...fitted.slice(0, -1))).toBeGreaterThan(5000 - 104 - 8)
    // What caused the frame crosses beside its first part, which is that much shorter, and beside no other.
    const [first, ...after] = await sizes(5000, undefined, cause)
    expect(first).toBeLessThanOrEqual(5000 - 104 - 1024)
    expect(first).toBeGreaterThan(5000 - 104 - 1024 - 8)
    expect(Math.min(...after.slice(0, -1))).toBeGreaterThan(5000 - 104 - 8)
    const capped = await sizes(5000, 2000)
    expect(Math.max(...capped)).toBeLessThanOrEqual(2000)
    expect(Math.min(...capped.slice(0, -1))).toBeGreaterThan(2000 - 8)
  })

  it('is what the other end says it takes, where that is less: what is sent once it has said so is cut to it', async () => {
    // This end is on something that takes any length, and the other on something that takes 3000.
    const [left, right] = memoryPair()
    const writes: number[] = []
    const a = dial({ ...left, send: (message) => { writes.push(bytes(message)); left.send(message) } }, options)
    const { heard, ended } = watched(listen({ ...right, most: 3000 }, options))
    const at = watched(a)
    await turn()
    a.send(largest, { cause })
    await until(() => heard.length === 1 || ended.length > 0)
    expect([ended, at.ended]).toEqual([[], []])
    expect(heard).toEqual([{ frame: largest, cause }])
    expect(Math.max(...writes)).toBeLessThanOrEqual(3000)
  })

  it('is found wanting as it is handed over, and in the other end\'s hello, one byte short of what any link needs', async () => {
    const short = narrow(LEAST - 1)
    expect(() => dial(short.transport, options)).toThrow(RangeError)
    expect(short.closed()).toBe(1)
    expect(() => accept(() => {}, options)(narrow(LEAST - 1).transport)).toThrow(RangeError)
    expect(() => accept(() => {}, options)(narrow(LEAST).transport)).not.toThrow()
    for (const [most, ending] of [[LEAST, []], [LEAST - 1, [{ why: 'too narrow', most: LEAST - 1, needs: LEAST }]]] as const) {
      const [bare, right] = memoryPair()
      const ended: Ending[] = []
      dial(right, options).onEnd((end) => { ended.push(end) })
      bare.send(JSON.stringify([{ link: 1, session: 'bare', taken: 0, most }]))
      await turn()
      expect([most, ended]).toEqual([most, ending])
    }
  })

  it('is no less than what a link keeps was cut for: an end that said a long thing before it knew ends saying how long', async () => {
    // On one connection alone it sends at once, beside its hello: here, before the other end has said what it takes.
    const [bare, right] = memoryPair()
    const sent: number[] = []
    bare.onData((message) => { sent.push(bytes(message)) })
    const a = dial(right, options)
    const { ended } = watched(a)
    a.send(tell('x'.repeat(5000)))
    await turn()
    bare.send(JSON.stringify([{ link: 1, session: 'bare', taken: 0, most: 3000 }]))
    await turn()
    // What it kept, and the batch's two: the frame as it was numbered, which is what would be sent again.
    const texts: string[] = []
    const again = memoryPair()
    again[0].onData((message) => { texts.push(message as string) })
    const other = dial(again[1], options)
    other.send(tell('x'.repeat(5000)))
    await turn()
    const kept = JSON.stringify((JSON.parse(texts[0]!) as unknown[])[1]).length
    expect(sent.length).toBeGreaterThan(0)
    expect(ended).toEqual([{ why: 'too narrow', most: 3000, needs: kept + 2 }])
    // One byte short of that it is too narrow, and at that it is not.
    for (const [most, endings] of [[kept + 1, 1], [kept + 2, 0]] as const) {
      const [far, near] = memoryPair()
      const one = dial(near, options)
      const at = watched(one)
      one.send(tell('x'.repeat(5000)))
      await turn()
      far.send(JSON.stringify([{ link: 1, session: 'bare', taken: 0, most }]))
      await turn()
      expect([most, at.ended.length]).toEqual([most, endings])
    }
  })

  it('is no less than what a link keeps was cut for, on a connection that comes back, and anything once that has been taken', async () => {
    const b = listen(undefined, options)
    const { ended } = watched(b)
    const first = memoryPair()
    const said: Array<{ session?: string; seq?: number }> = []
    first[0].onData((message) => { said.push(...(JSON.parse(message as string) as typeof said)) })
    b.carry(first[1])
    first[0].send(JSON.stringify([{ link: 1, session: 'w', taken: 0 }]))
    await turn()
    // Cut for a connection that takes any length, and not taken.
    b.send(tell('x'.repeat(5000)))
    await turn()
    first[0].close()
    await turn()
    const mine = said[0]!.session
    // Handed something that takes less than that: nothing is known of what was taken until a hello says, so it is
    // taken as any other is, and turned away, told the session is lost, when the hello says that was not taken.
    const tight = narrow(3000)
    const refused: unknown[] = []
    tight.right.onData((message) => { refused.push(...(JSON.parse(message as string) as unknown[])) })
    expect(() => b.carry(tight.transport)).not.toThrow()
    expect(tight.closed()).toBe(0)
    tight.right.send(JSON.stringify([{ link: 1, session: 'w', taken: 0, resumes: mine }]))
    await turn()
    expect(refused).toEqual([{ link: 1, session: '', taken: 0 }, { lost: true }])
    expect(tight.closed()).toBe(1)
    // One that says it takes less is turned away, told the session is lost.
    const saying = memoryPair()
    const told: unknown[] = []
    saying[0].onData((message) => { told.push(...(JSON.parse(message as string) as unknown[])) })
    b.carry(saying[1])
    saying[0].send(JSON.stringify([{ link: 1, session: 'w', taken: 0, resumes: mine, most: 3000 }]))
    await turn()
    expect(told).toEqual([{ link: 1, session: '', taken: 0 }, { lost: true }])
    expect(ended).toEqual([])
    // One that takes it goes on, takes what was kept, and after that what is sent is cut to whatever carries it.
    const wide = memoryPair()
    const crossed: number[] = []
    wide[0].onData((message) => { crossed.push(bytes(message)) })
    b.carry(wide[1])
    wide[0].send(JSON.stringify([{ link: 1, session: 'w', taken: 0, resumes: mine }]))
    await turn()
    wide[0].send(JSON.stringify([{ taken: 1 }]))
    await turn()
    expect(b.kept()).toBe(0)
    wide[0].close()
    await turn()
    const again = narrow(3000)
    const heard: unknown[] = []
    again.right.onData((message) => { heard.push(...(JSON.parse(message as string) as unknown[])) })
    expect(() => b.carry(again.transport)).not.toThrow()
    again.right.send(JSON.stringify([{ link: 1, session: 'w', taken: 1, resumes: mine }]))
    await turn()
    b.send(tell('y'.repeat(5000)))
    await turn()
    expect(Math.max(...again.writes)).toBeLessThanOrEqual(3000)
    expect(heard.filter((one) => typeof one === 'object' && one !== null && 'part' in one).length).toBeGreaterThan(1)
    expect(ended).toEqual([])
  })

  it('is the least a link is carried on in msgpack too, with a frame as large as one may be and the longest cause there may be', async () => {
    const { transport, right, writes } = narrow(LEAST)
    const opts = { ...options, codec: msgpack }
    const a = dial(transport, opts)
    const { heard, ended } = watched(listen(right, opts))
    // Three-byte str16 header + 1021 bytes = 1024 bytes, the longest cause there may be.
    const maxCause = 'c'.repeat(1021)
    const whole = tell('x')
    const beside = tell('y'.repeat(900))
    a.send(largest, { cause: maxCause })
    a.send(whole, { cause: maxCause })
    a.send(beside, { cause: maxCause })
    await until(() => heard.length === 3 || ended.length > 0)
    expect(ended).toEqual([])
    expect(heard).toEqual([{ frame: largest, cause: maxCause }, { frame: whole, cause: maxCause }, { frame: beside, cause: maxCause }])
    expect(Math.max(...writes)).toBeLessThanOrEqual(LEAST)
  })

  it('is found at the hello where a backend accepts connections: one narrower than what is kept is turned away, and taken once its hello says that was taken', async () => {
    let made!: ReturnType<typeof dial>
    const ended: Ending[] = []
    const take = accept((link) => { made = link; link.onEnd((end) => { ended.push(end) }) }, options)
    const first = memoryPair()
    const said: Array<{ session?: string }> = []
    first[0].onData((message) => { said.push(...(JSON.parse(message as string) as typeof said)) })
    take(first[1])
    first[0].send(JSON.stringify([{ link: 1, session: 'w', taken: 0 }]))
    await turn()
    // Numbered for a wide connection, not yet taken.
    made.send(tell('x'.repeat(5000)))
    await turn()
    first[0].close()
    await turn()
    const mine = said[0]!.session
    // Going on with the session on something narrower, without having taken it: turned away, told the session is lost.
    const tight = narrow(3000)
    const told: unknown[] = []
    let tightClosed = false
    tight.right.onData((message) => { told.push(...(JSON.parse(message as string) as unknown[])) })
    tight.right.onClose(() => { tightClosed = true })
    take(tight.transport)
    tight.right.send(JSON.stringify([{ link: 1, session: 'w', taken: 0, resumes: mine }]))
    await turn()
    expect(told).toEqual([{ link: 1, session: '', taken: 0 }, { lost: true }])
    expect(tightClosed).toBe(true)
    expect(ended).toEqual([])
    // On something as narrow, with a hello that says it took what was kept: it goes on, and what is sent is cut to fit.
    const resumed = narrow(3000)
    const heard: unknown[] = []
    resumed.right.onData((message) => { heard.push(...(JSON.parse(message as string) as unknown[])) })
    take(resumed.transport)
    resumed.right.send(JSON.stringify([{ link: 1, session: 'w', taken: 1, resumes: mine }]))
    await turn()
    expect(made.kept()).toBe(0)
    made.send(tell('y'.repeat(5000)))
    await turn()
    expect(Math.max(...resumed.writes)).toBeLessThanOrEqual(3000)
    expect(heard.filter((one) => typeof one === 'object' && one !== null && 'part' in one).length).toBeGreaterThan(1)
    expect(ended).toEqual([])
  })

  it('is no less than what the hello has not taken: an end whose hello says it took what was kept, and that it takes less, goes on', async () => {
    // An end that listens keeps a frame cut for any length; the other end comes back saying it took it, and takes 3000.
    const b = listen(undefined, options)
    const bWatch = watched(b)
    const first = memoryPair()
    const said: Array<{ session?: string }> = []
    first[0].onData((message) => { said.push(...(JSON.parse(message as string) as typeof said)) })
    b.carry(first[1])
    first[0].send(JSON.stringify([{ link: 1, session: 'w', taken: 0 }]))
    await turn()
    b.send(tell('x'.repeat(5000)))
    await turn()
    first[0].close()
    await turn()
    const bSession = said[0]!.session
    const second = memoryPair()
    const secondWrites: number[] = []
    second[0].onData((message) => { secondWrites.push(bytes(message)) })
    b.carry(second[1])
    second[0].send(JSON.stringify([{ link: 1, session: 'w', taken: 1, resumes: bSession, most: 3000 }]))
    await turn()
    expect(b.kept()).toBe(0)
    b.send(tell('y'.repeat(5000)))
    await turn()
    expect(Math.max(...secondWrites)).toBeLessThanOrEqual(3000)
    expect(bWatch.ended).toEqual([])

    // An end that dials keeps the same; on the connection it opens next, the hello says it was taken, and takes 3000.
    const pairs = [memoryPair(), memoryPair()]
    let opened = 0
    const dialWrites: number[] = []
    const a = dial(() => {
      const pair = pairs[opened++]!
      return { ...pair[1], send: (message) => { dialWrites.push(bytes(message)); pair[1].send(message) } }
    }, { ...options, reopen: { clock: { after: (_, run) => { queueMicrotask(run); return () => {} } } } })
    const aWatch = watched(a)
    const aHello: Array<{ session?: string }> = []
    pairs[0]![0].onData((message) => { aHello.push(...(JSON.parse(message as string) as typeof aHello)) })
    await turn()
    const aSession = aHello[0]!.session
    pairs[0]![0].send(JSON.stringify([{ link: 1, session: 'peer', taken: 0 }]))
    await turn()
    a.send(tell('x'.repeat(5000)))
    await turn()
    pairs[0]![0].close()
    await until(() => opened === 2)
    await turn()
    dialWrites.length = 0
    pairs[1]![0].send(JSON.stringify([{ link: 1, session: 'peer', taken: 1, resumes: aSession, most: 3000 }]))
    await turn()
    expect(a.kept()).toBe(0)
    a.send(tell('y'.repeat(5000)))
    await turn()
    expect(Math.max(...dialWrites)).toBeLessThanOrEqual(3000)
    expect(aWatch.ended).toEqual([])
  })

  for (const [name, codec] of [['JSON', undefined], ['msgpack', msgpack]] as const) {
    it(`is not sent what was numbered for more, where the other end says how little it takes in the turn that was numbered: it is told the session is lost, after a hello, in ${name}`, () => {
      const writes: Message[] = []
      let deliver!: (message: Message) => void
      const transport: Transport = {
        send: (message) => { writes.push(message) },
        onData: (heard) => { deliver = heard },
        onClose: () => {},
        close: () => {},
      }
      const read = (message: Message): Array<Record<string, unknown>> => (codec ? codec.decode(message) : JSON.parse(message as string)) as Array<Record<string, unknown>>
      const hello = { link: 1, session: 'bare', taken: 0, most: 3000 }
      // Turns are held, so that the other end's hello arrives before this end's first batch has left.
      const pending: Array<() => void> = []
      const a = dial(transport, { ...options, ...(codec ? { codec } : {}), later: (run) => { pending.push(run) } })
      const { ended } = watched(a)
      a.send(tell('x'.repeat(5000)))
      expect(writes).toEqual([])
      deliver(codec ? codec.list([codec.encode(hello)]) : JSON.stringify([hello]))
      expect(ended).toHaveLength(1)
      expect(ended[0]).toMatchObject({ why: 'too narrow', most: 3000 })
      expect(writes.length).toBeGreaterThan(0)
      expect(Math.max(...writes.map(bytes))).toBeLessThanOrEqual(3000)
      const sent = writes.flatMap(read)
      // Its hello is still said, and first: whoever is told the session is lost is told by which link. Nothing
      // numbered is said, whole or in parts.
      expect(sent.map((one) => Object.keys(one).sort().join())).toEqual(['link,session,taken', 'lost'])
    })
  }

  it('says its hello and that the session is lost in messages no longer than the other end said it takes, however short that is', () => {
    const writes: Message[] = []
    let deliver!: (message: Message) => void
    const transport: Transport = { send: (message) => { writes.push(message) }, onData: (heard) => { deliver = heard }, onClose: () => {}, close: () => {} }
    const pending: Array<() => void> = []
    const a = dial(transport, { ...options, later: (run) => { pending.push(run) } })
    const { ended } = watched(a)
    // Each of the two is shorter than 75 bytes, and the two as one message are longer.
    deliver(JSON.stringify([{ link: 1, session: 'bare', taken: 0, most: 75 }]))
    expect(ended).toMatchObject([{ why: 'too narrow', most: 75, needs: LEAST }])
    expect(writes.flatMap((message) => JSON.parse(message as string) as unknown[])).toMatchObject([{ link: 1 }, { lost: true }])
    expect(Math.max(...writes.map(bytes))).toBeLessThanOrEqual(75)
  })

  it('is held, where an end is handed it or opens it for itself, to what the hello on it has not taken, and to no more', async () => {
    // An end that listens keeps something cut for a wide connection, and is handed a narrow one by whoever took it.
    const b = listen(undefined, options)
    const listening = watched(b)
    const first = memoryPair()
    const said: Array<{ session?: string }> = []
    first[0].onData((message) => { said.push(...(JSON.parse(message as string) as typeof said)) })
    b.carry(first[1])
    first[0].send(JSON.stringify([{ link: 1, session: 'w', taken: 0 }]))
    await turn()
    b.send(tell('x'.repeat(5000)))
    await turn()
    first[0].close()
    await turn()
    const tight = narrow(3000)
    b.carry(tight.transport)
    tight.right.send(JSON.stringify([{ link: 1, session: 'w', taken: 1, resumes: said[0]!.session }]))
    await turn()
    expect(b.kept()).toBe(0)
    b.send(tell('y'.repeat(5000)))
    await turn()
    expect(tight.writes.length).toBeGreaterThan(1)
    expect(Math.max(...tight.writes)).toBeLessThanOrEqual(3000)
    expect([tight.closed(), listening.ended]).toEqual([0, []])

    // An end that dials keeps the same, and the next connection it opens is a narrow one.
    for (const taken of [1, 0]) {
      const wide = memoryPair()
      const next = narrow(3000)
      const opening = [wide[1], next.transport]
      let opened = 0
      const thrown: unknown[] = []
      const a = dial(() => opening[opened++]!, { ...options, thrown: (error) => { thrown.push(error) }, reopen: { clock: { after: (_, run) => { queueMicrotask(run); return () => {} } } } })
      const dialling = watched(a)
      const hello: Array<{ session?: string }> = []
      const crossed: number[] = []
      wide[0].onData((message) => { hello.push(...(JSON.parse(message as string) as typeof hello)); crossed.push(bytes(message)) })
      await turn()
      wide[0].send(JSON.stringify([{ link: 1, session: 'peer', taken: 0 }]))
      await turn()
      a.send(tell('x'.repeat(5000)))
      await turn()
      wide[0].close()
      await until(() => opened === 2)
      await turn()
      // It is opened and spoken on, whatever is kept: what the other end took is not known before it says.
      expect([taken, thrown, next.closed(), opened]).toEqual([taken, [], 0, 2])
      next.right.send(JSON.stringify([{ link: 1, session: 'peer', taken, resumes: hello[0]!.session }]))
      await turn()
      if (taken) {
        a.send(tell('y'.repeat(5000)))
        await turn()
        expect(dialling.ended).toEqual([])
        expect(a.kept()).toBeGreaterThan(1)
      } else expect(dialling.ended).toEqual([{ why: 'too narrow', most: 3000, needs: crossed.at(-1)! }])
      expect(Math.max(...next.writes)).toBeLessThanOrEqual(3000)
      expect(opened).toBe(2)
    }
  })

  it('says, ending too narrow, what it needs for what the other end has not taken, and not for what it has', async () => {
    const pairs = [memoryPair(), memoryPair()]
    let opened = 0
    const a = dial(() => pairs[opened++]![1], { ...options, reopen: { clock: { after: (_, run) => { queueMicrotask(run); return () => {} } } } })
    const { ended } = watched(a)
    const hello: Array<{ session?: string }> = []
    const crossed: number[] = []
    pairs[0]![0].onData((message) => {
      hello.push(...(JSON.parse(message as string) as typeof hello))
      crossed.push(bytes(message))
    })
    await turn()
    pairs[0]![0].send(JSON.stringify([{ link: 1, session: 'peer', taken: 0 }]))
    await turn()
    a.send(tell('x'.repeat(5000)))
    await turn()
    a.send(tell('y'.repeat(3000)))
    await turn()
    const second = crossed.at(-1)!
    pairs[0]![0].close()
    await until(() => opened === 2)
    await turn()
    // It took the first, and takes nothing as long as the second.
    pairs[1]![0].send(JSON.stringify([{ link: 1, session: 'peer', taken: 1, resumes: hello[0]!.session, most: 2000 }]))
    await turn()
    expect(ended).toEqual([{ why: 'too narrow', most: 2000, needs: second }])
  })
})

describe('what caused a frame', () => {
  it('is 1024 bytes at most as it crosses, and a frame with a longer one is refused where it is sent', async () => {
    const [left, right] = memoryPair()
    const a = dial(left)
    const heard: Array<string | undefined> = []
    listen(right).onFrame((_, cause) => { heard.push(cause) })
    // With the two around it as text.
    a.send(tell(1), { cause: 'c'.repeat(1022) })
    expect(() => a.send(tell(2), { cause: 'c'.repeat(1023) })).toThrow(RangeError)
    expect(() => a.prepare(tell(2), { cause: '✓'.repeat(341) })).toThrow(RangeError)
    a.send(tell(3))
    await until(() => heard.length === 2)
    expect(heard).toEqual(['c'.repeat(1022), undefined])
  })
})

describe('sending', () => {
  it('hands nothing to what carries the link before the turn is out, however much is sent', async () => {
    const [left, right] = memoryPair()
    let writes = 0
    const a = dial({ ...left, send: (message) => { writes++; left.send(message) } }, { part: 100 })
    const heard: Frame[] = []
    listen(right, { part: 100 }).onFrame((frame) => { heard.push(frame) })
    const frames = [tell('x'.repeat(5000)), tell('after')]
    for (const frame of frames) a.send(frame)
    expect(writes).toBe(0)
    await until(() => heard.length === 2)
    expect(heard).toEqual(frames)
    expect(writes).toBeGreaterThan(10)
  })

  it('does not end the link under whoever is sending, when what carries it throws', async () => {
    const thrown: unknown[] = []
    const a = dial({ send: () => { throw new Error('cannot send') }, onData: () => {}, onClose: () => {}, close: () => {} }, { part: 100, thrown: (error) => { thrown.push(error) } })
    const ended: Ending[] = []
    a.onEnd((ending) => { ended.push(ending) })
    a.send(tell('x'.repeat(5000)))
    expect([ended, thrown]).toEqual([[], []])
    await until(() => ended.length > 0)
    expect(ended).toEqual([{ why: 'closed' }])
    expect(thrown).toEqual([new Error('cannot send')])
  })
})

describe('a WebSocket that takes no message longer than some length', () => {
  it('says so when it is told, and says nothing when it is not', () => {
    const ws = { readyState: 0, bufferedAmount: 0, binaryType: '', send: () => {}, close: () => {}, addEventListener: () => {} }
    expect(socket(ws, { most: 4 * 1024 * 1024 }).most).toBe(4 * 1024 * 1024)
    expect(socket(ws).most).toBeUndefined()
    expect('most' in socket(ws)).toBe(false)
  })

  it('carries a link whatever length of message it takes, down to the least any link needs: what is sent is cut to it', () => {
    const ws = { readyState: 0, bufferedAmount: 0, binaryType: '', send: () => {}, close: () => {}, addEventListener: () => {} }
    // A part is 1 MiB at most unless told: on a server that takes a megabyte, it is as much less as it takes to fit.
    expect(() => dial(socket(ws, { most: 1024 * 1024 }))).not.toThrow()
    expect(() => dial(socket(ws, { most: LEAST }))).not.toThrow()
    expect(() => dial(socket(ws, { most: LEAST - 1 }))).toThrow(RangeError)
  })
})

describe('the work of cutting a frame', () => {
  const inBytes = (message: Message): number => (typeof message === 'string' ? new TextEncoder().encode(message).byteLength : message.byteLength)
  /** A codec that counts each piece it is handed to encode as a part's data: text or bytes by itself. */
  const counting = (codec: typeof msgpack) => {
    const count = { pieces: 0 }
    return { count, codec: { ...codec, encode: (value: unknown) => { if (typeof value === 'string' || value instanceof Uint8Array) count.pieces++; return codec.encode(value) } } }
  }
  const jsonCodec = { encode: (value: unknown) => JSON.stringify(value), list: (parts: readonly Message[]) => `[${parts.join(',')}]`, record: (fields: ReadonlyArray<readonly [string, Message]>) => `{${fields.map(([name, value]) => `${JSON.stringify(name)}:${value as string}`).join(',')}}`, decode: (message: Message) => JSON.parse(message as string) as unknown }

  for (const [name, base] of [['JSON', jsonCodec], ['msgpack', msgpack]] as const) {
    for (const [what, event] of [
      ['plain text', 'x'.repeat(200_000)],
      ['plain text with a wall of quotes wherever a part would end', ('x'.repeat(3900) + '"'.repeat(400)).repeat(40)],
      ['runs of plain text and of quotes', ('x'.repeat(997) + '"'.repeat(503)).repeat(100)],
      ['quotes and then plain text, in each part', ('"'.repeat(700) + 'x'.repeat(2600)).repeat(40)],
      ['a little plain text and then quotes, in each part', ('x'.repeat(300) + '"'.repeat(1500)).repeat(60)],
      ['quotes, backslashes and characters of every length, mixed', Array.from({ length: 60_000 }, (_, at) => ['x', '"', '\\', '✓', '𝄞', '\n'][(at * 7919 + (at >> 3) * 31) % 6]).join('')],
    ] as const) {
      it(`is in proportion to the frame, whatever it holds, in ${name}: ${what}`, async () => {
        for (const part of [64, 4096]) {
          const { count, codec } = counting(base)
          const [left, right] = memoryPair()
          let parts = 0
          const data: number[] = []
          const a = dial({ ...left, send: (message) => {
            for (const one of base.decode(message) as Array<Record<string, unknown>>) if ('part' in one) { parts++; data.push(inBytes(base.encode(one.data))) }
            left.send(message)
          } }, { part, codec })
          const heard: Frame[] = []
          listen(right, { part, codec: base }).onFrame((frame) => { heard.push(frame) })
          a.send(tell(event))
          await until(() => heard.length === 1)
          expect(heard).toEqual([tell(event)])
          // No piece is tried more than a few times, and so no frame encoded more than a few times over.
          expect([part, count.pieces <= 6 * parts]).toEqual([part, true])
          // And for it no part but the last is left far short of what it may be.
          expect([part, Math.min(...data.slice(0, -1)) >= 0.8 * part]).toEqual([part, true])
        }
      })
    }
  }

  it('leaves no part but the last much shorter than a part may be, in msgpack as in JSON', async () => {
    const [left, right] = memoryPair()
    const data: number[] = []
    const a = dial({ ...left, send: (message) => { for (const one of decode(message as Uint8Array) as Array<Record<string, unknown>>) if ('part' in one) data.push((one.data as Uint8Array).byteLength); left.send(message) } }, { part: 300, codec: msgpack })
    const heard: Frame[] = []
    listen(right, { part: 300, codec: msgpack }).onFrame((frame) => { heard.push(frame) })
    a.send(tell('"✓'.repeat(2000)))
    await until(() => heard.length === 1)
    expect(Math.min(...data.slice(0, -1))).toBeGreaterThanOrEqual(300 - 8 - 3)
  })
})

describe('what accepts connections', () => {
  it('is not made with options no link is made with: found there, and not where a connection says hello', () => {
    expect(() => accept(() => {}, { part: 15 })).toThrow(RangeError)
    expect(() => accept(() => {}, { bound: { frame: 1023 } })).toThrow(RangeError)
    expect(() => accept(() => {}, { part: Number.NaN })).toThrow(RangeError)
    expect(() => dial(memoryPair()[0], { part: Number.NaN })).toThrow(RangeError)
    expect(() => accept(() => {}, { part: 16, bound: { frame: 1024 } })).not.toThrow()
  })
})
