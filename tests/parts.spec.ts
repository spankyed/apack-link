// A frame longer than a part crosses as parts, each numbered, and is handed over whole, in the place of its first
// part, with nothing between: no one write is much longer than a part, and a resume picks up within a frame.
import { once as eventOnce } from 'node:events'
import { describe, expect, it } from 'vitest'
import { decode } from '@msgpack/msgpack'
import { WebSocket, WebSocketServer } from 'ws'
import { accept, link, memoryPair, socket, timers, type Ending, type Frame, type Message, type Traffic, type Transport } from '../src/index.ts'
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
      const a = link(counted, options)
      const b = link(right, options)
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
      const end = link(right)
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
    const backend = link(undefined, { part: 50 })
    const heard: Frame[] = []
    const backendEnded: Ending[] = []
    backend.onFrame((frame) => { heard.push(frame) })
    backend.onEnd((ending) => { backendEnded.push(ending) })
    let delivered = 0
    let current: Transport | undefined
    let connections = 0
    const window = link(() => {
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
    const window = link(() => {
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
