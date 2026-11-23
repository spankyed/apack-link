// The scenarios of steps 1 and 2 once more over each thing a link is carried on: memory, a WebSocket, a message
// port and a stream of bytes on a socket path. Over memory every order is run; over the others, a seed's worth.
import { once as eventOnce } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { MessageChannel } from 'node:worker_threads'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { link, port, socket, stream, type Frame, type Message, type Transport } from '../src/index.ts'
import { carried, everyOrder, hold, memoryEnds, peers, sample, type KitScenario } from '../src/testing/index.ts'

const scenarios: readonly KitScenario[] = [...peers, ...hold]
/** How many orders each scenario is run under over something real. */
const RUNS = 20

/** Something real to carry a link on: makes joined pairs, and lets go of everything it made. */
interface Carrier {
  pair(): Promise<[Transport, Transport]>
  /** Ends every connection it made and stops what it started, waiting for each. */
  stop(): Promise<void>
}

const websockets = async (): Promise<Carrier> => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await eventOnce(server, 'listening')
  const { port: at } = server.address() as { port: number }
  const made: WebSocket[] = []
  return {
    pair: async () => {
      const client = new WebSocket(`ws://127.0.0.1:${at}`)
      const [[accepted]] = await Promise.all([eventOnce(server, 'connection') as Promise<[WebSocket]>, eventOnce(client, 'open')])
      made.push(client, accepted)
      return [socket(client as never), socket(accepted as never)]
    },
    stop: async () => {
      for (const ws of made) ws.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

const ports = async (): Promise<Carrier> => {
  const made: Array<{ close(): void }> = []
  return {
    pair: async () => {
      const channel = new MessageChannel()
      made.push(channel.port1, channel.port2)
      return [port(channel.port1), port(channel.port2)]
    },
    stop: async () => { for (const one of made) one.close() },
  }
}

/** A socket path, or on Windows a named pipe, of its own. */
let paths = 0
const socketPath = (folder: string): string => {
  paths++
  return process.platform === 'win32' ? `\\\\.\\pipe\\apack-link-${process.pid}-${paths}` : joinPath(folder, `${paths}.sock`)
}

const streams = async (): Promise<Carrier> => {
  const folder = mkdtempSync(joinPath(tmpdir(), 'apack-link-'))
  const path = socketPath(folder)
  const server: Server = createServer()
  server.listen(path)
  await eventOnce(server, 'listening')
  const made: Socket[] = []
  return {
    pair: async () => {
      const client = connect(path)
      const [[accepted]] = await Promise.all([eventOnce(server, 'connection') as Promise<[Socket]>, eventOnce(client, 'connect')])
      made.push(client, accepted)
      return [stream(client), stream(accepted)]
    },
    stop: async () => {
      for (const one of made) one.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(folder, { recursive: true, force: true })
    },
  }
}

describe('over memory', () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      expect(await everyOrder((schedule) => scenario.play(schedule, memoryEnds(schedule)))).toBeGreaterThan(0)
    })
  }
})

for (const [name, start] of [['a WebSocket', websockets], ['a message port', ports], ['a stream of bytes', streams]] as const) {
  describe(`over ${name}`, () => {
    let carrier: Carrier
    beforeAll(async () => { carrier = await start() })
    afterAll(async () => { await carrier.stop() })
    for (const [at, scenario] of scenarios.entries()) {
      it(scenario.name, async () => {
        // One after another: a server tells connections apart only by when they arrive.
        const pairs: Array<[Transport, Transport]> = []
        for (let made = 0; made < RUNS; made++) pairs.push(await carrier.pair())
        let used = 0
        const ran = await sample((schedule) => {
          const [left, right] = carried(schedule, pairs[used++]!)
          return scenario.play(schedule, { a: link(left), b: link(right) })
        }, { seed: at + 1, runs: RUNS })
        if (ran.failure) throw new Error(`Failed (replay with [${ran.failure.choices.join(', ')}]):\n  ${ran.failure.taken.join('\n  ')}`, { cause: ran.failure.error })
        expect(ran.orderings).toBe(RUNS)
      }, 30_000)
    }
  })
}

describe('a stream of bytes', () => {
  /** One end of a stream transport, and the bare stream at the other end of a socket path. */
  const bare = async () => {
    const folder = mkdtempSync(joinPath(tmpdir(), 'apack-link-'))
    const path = socketPath(folder)
    const server = createServer()
    server.listen(path)
    await eventOnce(server, 'listening')
    const client = connect(path)
    const [[accepted]] = await Promise.all([eventOnce(server, 'connection') as Promise<[Socket]>, eventOnce(client, 'connect')])
    const transport = stream(accepted)
    const heard: Message[] = []
    let closed = 0
    transport.onData((message) => { heard.push(message) })
    transport.onClose(() => { closed++ })
    return {
      client, transport, heard, closed: () => closed,
      stop: async () => {
        client.destroy()
        ;(accepted as Socket).destroy()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        rmSync(folder, { recursive: true, force: true })
      },
    }
  }
  const framed = (kind: number, body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(5 + body.length)
    out[0] = kind
    new DataView(out.buffer).setUint32(1, body.length)
    out.set(body, 5)
    return out
  }
  const settle = async (until: () => boolean): Promise<void> => { while (!until()) await new Promise((resolve) => setImmediate(resolve)) }

  it('puts together a message handed over in pieces, and takes apart two handed over at once', async () => {
    const end = await bare()
    try {
      const text = new TextEncoder().encode('[{"link":1}] — and more, past one byte: ✓')
      const one = framed(0, text)
      // Half of the first, a byte at a time for its head.
      for (let at = 0; at < 5; at++) { end.client.write(one.subarray(at, at + 1)); await new Promise((resolve) => setTimeout(resolve, 1)) }
      end.client.write(one.subarray(5, 20))
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(end.heard).toEqual([])
      // The rest of it, and two more whole, in one write.
      const bytes = new Uint8Array([0, 255, 7])
      const rest = one.subarray(20)
      const two = framed(1, bytes)
      const three = framed(0, new TextEncoder().encode('third'))
      const together = new Uint8Array(rest.length + two.length + three.length)
      together.set(rest)
      together.set(two, rest.length)
      together.set(three, rest.length + two.length)
      end.client.write(together)
      await settle(() => end.heard.length === 3)
      expect(end.heard).toEqual([new TextDecoder().decode(text), bytes, 'third'])
    } finally { await end.stop() }
  })

  it('closes when what arrives is not a message', async () => {
    const end = await bare()
    try {
      end.client.write(new Uint8Array([9, 0, 0, 0, 1, 1]))
      await settle(() => end.closed() > 0)
      expect([end.heard, end.closed()]).toEqual([[], 1])
    } finally { await end.stop() }
  })
})

describe('a message port as Electron has one', () => {
  it('takes listeners as an emitter does, and hears the other end close', async () => {
    const channel = new MessageChannel()
    // Electron's `MessagePortMain` hands each listener an event with `data`, as an emitter.
    const emitter = (real: typeof channel.port1) => ({
      postMessage: (message: unknown) => real.postMessage(message),
      close: () => real.close(),
      start: () => {},
      on: (type: 'message' | 'close', listener: (event: { data: unknown }) => void) => {
        real.on(type, (data: unknown) => listener({ data }))
      },
    })
    const a = port(emitter(channel.port1))
    const b = port(emitter(channel.port2))
    const heard: Message[] = []
    let closed = 0
    b.onData((message) => { heard.push(message) })
    b.onClose(() => { closed++ })
    a.send('one')
    a.send(new Uint8Array([1, 2]))
    a.close()
    while (!closed) await new Promise((resolve) => setImmediate(resolve))
    expect(heard).toEqual(['one', new Uint8Array([1, 2])])
    expect(closed).toBe(1)
  })
})

describe('a WebSocket', () => {
  it('keeps what is sent while it is opening, and sends it in order once open', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await eventOnce(server, 'listening')
    const heard: Frame[] = []
    server.on('connection', (accepted) => { link(socket(accepted as never)).onFrame((frame) => { heard.push(frame) }) })
    const client = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}`)
    try {
      expect(client.readyState).toBe(WebSocket.CONNECTING)
      const a = link(socket(client as never))
      a.send({ kind: 'tell', to: 'x', event: 1 })
      await Promise.resolve()
      a.send({ kind: 'tell', to: 'x', event: 2 })
      while (heard.length < 2) await new Promise((resolve) => setTimeout(resolve, 1))
      expect(heard.map((frame) => frame.kind === 'tell' && frame.event)).toEqual([1, 2])
    } finally {
      client.terminate()
      for (const accepted of server.clients) accepted.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('a message port that says nothing when the other end closes', () => {
  it('is told by the other end before it closes', async () => {
    const channel = new MessageChannel()
    // As a browser's port was before it had a close event: messages only.
    const quiet = (real: typeof channel.port1) => ({
      postMessage: (message: unknown) => real.postMessage(message),
      close: () => { setTimeout(() => real.close(), 50) },
      addEventListener: (type: string, listener: (event: { data: unknown }) => void) => { if (type === 'message') real.on('message', (data: unknown) => listener({ data })) },
    })
    const a = port(quiet(channel.port1) as never)
    const b = port(quiet(channel.port2) as never)
    let closed = 0
    b.onClose(() => { closed++ })
    a.close()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(closed).toBe(1)
    channel.port1.close()
  })
})

/** Waits for something to come about, a turn of the event loop at a time. */
const until = async (done: () => boolean): Promise<void> => { while (!done()) await new Promise((resolve) => setImmediate(resolve)) }

for (const [name, start] of [['a WebSocket', websockets], ['a message port', ports], ['a stream of bytes', streams]] as const) {
  describe(`${name}, carrying by itself`, () => {
    let carrier: Carrier
    beforeAll(async () => { carrier = await start() })
    afterAll(async () => { await carrier.stop() })

    it('hands over text as text and bytes as bytes, in order', async () => {
      const [a, b] = await carrier.pair()
      const heard: Message[] = []
      b.onData((message) => { heard.push(message) })
      const sent: Message[] = ['one ✓', new Uint8Array([0, 1, 255]), 'three', new Uint8Array(0)]
      for (const message of sent) a.send(message)
      await until(() => heard.length === sent.length)
      expect(heard).toEqual(sent)
      expect(heard.map((message) => typeof message)).toEqual(['string', 'object', 'string', 'object'])
    })

    it('hands nothing over at an end once that end has closed', async () => {
      const [a, b] = await carrier.pair()
      const heard: Message[] = []
      let closed = 0
      a.onData((message) => { heard.push(message) })
      b.onClose(() => { closed++ })
      a.close()
      b.send('late')
      await until(() => closed > 0)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(heard).toEqual([])
    })
  })
}

describe('a message port closed beneath its transport', () => {
  it('is heard to have closed at the other end', async () => {
    const channel = new MessageChannel()
    const b = port(channel.port2)
    let closed = 0
    b.onClose(() => { closed++ })
    channel.port1.close()
    await until(() => closed > 0)
    expect(closed).toBe(1)
  })
})
