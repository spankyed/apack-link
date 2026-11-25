// Real Chromium browser + Web Worker tests for MessagePort (`port()`) and WebSocket (`socket()`).
import { describe, expect, it } from 'vitest'
import { dial, join, port, socket, timers, type Ending, type Outcome } from '../../src/index.js'
import { msgpack } from '../support/msgpack.js'

const until = async (check: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for browser condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('real browser environment', () => {
  it('runs cleanly with no Node globals present', () => {
    expect(typeof (globalThis as { process?: unknown }).process).toBe('undefined')
    expect(typeof MessageChannel).toBe('function')
    expect(typeof WebSocket).toBe('function')
    expect(typeof Worker).toBe('function')
  })

  it('carries text, binary Uint8Array, and close sentinel over a real browser MessageChannel', async () => {
    const channel = new MessageChannel()
    const a = port(channel.port1)
    const b = port(channel.port2)

    // Send before `b.onData` attaches: port() defers start() so browser port queues messages without dropping them.
    a.send('early-text')
    a.send(new Uint8Array([10, 20, 30, 255]))

    await new Promise((resolve) => setTimeout(resolve, 25))

    const heard: Array<string | Uint8Array> = []
    let closed = 0
    b.onClose(() => { closed++ })
    b.onData((msg) => { heard.push(msg) })

    await until(() => heard.length === 2)
    expect(heard[0]).toBe('early-text')
    expect(heard[1]).toBeInstanceOf(Uint8Array)
    expect([...(heard[1] as Uint8Array)]).toEqual([10, 20, 30, 255])

    a.close()
    await until(() => closed === 1)
    expect(closed).toBe(1)
  })

  it('runs a full joined link (tell, ask, follow, caughtUp view-before-answer ordering, goodbye) across a real Web Worker', async () => {
    const worker = new Worker(new URL('./echo.worker.ts', import.meta.url), { type: 'module' })
    const channel = new MessageChannel()
    worker.postMessage(channel.port2, [channel.port2])

    try {
      const link = dial(port(channel.port1))
      const acks: unknown[] = []
      const order: string[] = []
      const ended: Ending[] = []
      link.onEnd((e) => { ended.push(e) })

      const toWorker = join(link, {
        tell: (_to, event) => { acks.push(event) },
        ask: () => () => {},
        follow: () => ({ stop: () => {} }),
      })

      const shown: unknown[] = []
      const sub = toWorker.follow('counter', 'value', null, (u) => {
        shown.push(u)
        order.push(`shown:${String(u)}`)
      }, () => {})
      await until(() => shown.length === 1)
      expect(shown).toEqual([0])

      const progress: unknown[] = []
      const outcomes: Outcome[] = []
      toWorker.ask('counter', 'BUMP', { by: 1 }, (u) => {
        progress.push(u)
        order.push('progress')
      }, (o) => {
        outcomes.push(o)
        order.push('answer')
      })

      await until(() => outcomes.length === 1)
      expect(shown).toEqual([0, 1])
      expect(progress).toEqual([{ bumped: 1 }])
      expect(outcomes).toEqual([{ ok: true, value: { count: 1, args: { by: 1 } } }])
      // View update `shown:1` MUST arrive strictly before `answer` thanks to `caughtUp` across the Worker port.
      expect(order.indexOf('shown:1')).toBeLessThan(order.indexOf('answer'))

      toWorker.tell('notes', { hello: 'worker' })
      await until(() => acks.length === 1)
      expect(acks).toEqual([{ count: 1, last: { hello: 'worker' } }])

      sub.stop()
      link.close('ended')
      expect(ended).toEqual([{ why: 'closed' }])
    } finally {
      worker.terminate()
    }
  })

  it('runs a full joined link over a real browser WebSocket, including OPENING queue and reopen/resume after drop', async () => {
    const info = await (await fetch('/__apack_link_ws')).json() as { url: string }
    const owner = `browser-${Math.random().toString(36).slice(2)}`

    let opens = 0
    const link = dial(() => {
      opens++
      return socket(new WebSocket(`${info.url}/?owner=${owner}`))
    }, { reopen: { clock: timers, first: 20, most: 100 } })

    const toServer = join(link, {
      tell: () => {},
      ask: () => () => {},
      follow: () => ({ stop: () => {} }),
    })

    // Queue an ask + follows while the first WebSocket is still CONNECTING (OPENING);
    // DROP_THEN_ECHO deterministically terminates socket 1 on the server before answering so the answer must cross on socket 2.
    const progress: unknown[] = []
    const outcomes: Outcome[] = []
    const shown: unknown[] = []
    const missingOver: unknown[] = []

    toServer.ask('svc', 'DROP_THEN_ECHO', { from: 'chromium' }, (u) => { progress.push(u) }, (o) => { outcomes.push(o) })
    const sub = toServer.follow('f', 'live', { tag: 7 }, (u) => { shown.push(u) }, () => {})
    toServer.follow('f', 'missing', null, () => {}, (failure) => { missingOver.push(failure) })

    await until(() => outcomes.length === 1 && shown.length === 1 && missingOver.length === 1)

    expect(opens).toBeGreaterThanOrEqual(2)
    expect(progress).toEqual([{ step: 'after-drop', args: { from: 'chromium' } }])
    expect(outcomes).toEqual([{ ok: true, value: { resumed: { from: 'chromium' } } }])
    expect(shown).toEqual([{ initial: { tag: 7 } }])
    expect(missingOver).toEqual([{ kind: 'gone', message: 'No such view' }])

    sub.stop()
    link.close('ended')
  })

  it('carries binary Uint8Array frames (msgpack) over a real browser WebSocket using arraybuffer binaryType', async () => {
    const info = await (await fetch('/__apack_link_ws')).json() as { url: string }
    const owner = `browser-bin-${Math.random().toString(36).slice(2)}`
    const ws = new WebSocket(`${info.url}/?owner=${owner}&codec=msgpack`)
    const transport = socket(ws)
    expect(ws.binaryType).toBe('arraybuffer')

    const link = dial(transport, { codec: msgpack })
    const toServer = join(link, {
      tell: () => {},
      ask: () => () => {},
      follow: () => ({ stop: () => {} }),
    })

    const progress: unknown[] = []
    const outcomes: Outcome[] = []
    const input = new Uint8Array([0, 1, 42, 128, 255])
    toServer.ask('bin', 'INVERT', input, (u) => { progress.push(u) }, (o) => { outcomes.push(o) })

    await until(() => outcomes.length === 1)
    expect(progress).toEqual([{ gotBytes: true, len: 5 }])
    expect(outcomes[0]?.ok).toBe(true)
    if (outcomes[0]?.ok) {
      expect(outcomes[0].value).toBeInstanceOf(Uint8Array)
      expect([...(outcomes[0].value as Uint8Array)]).toEqual([255, 254, 213, 127, 0])
    }
    link.close('ended')
  })
})
