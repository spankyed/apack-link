// Transport adapter edge cases: early message buffering, close-vs-throw resilience, cross-realm ArrayBuffer, and late onClose.
import * as vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { memoryPair, port, socket, stream, type DuplexLike, type Message, type MessagePortLike, type WebSocketLike } from '../src/index.ts'

describe('port() transport hardening', () => {
  it('defers start() until first onData and buffers messages (and close sentinel) arriving before onData', () => {
    let messageHandler: ((event: { readonly data: unknown }) => void) | undefined
    let started = 0
    let portClosed = 0
    const fake: MessagePortLike = {
      postMessage: () => {},
      close: () => { portClosed++ },
      start: () => { started++ },
      addEventListener: (type: 'message' | 'close', listener: ((event: { readonly data: unknown }) => void) | (() => void)) => {
        if (type === 'message') messageHandler = listener as (event: { readonly data: unknown }) => void
      },
    }
    const t = port(fake)
    // start() is NOT called until an onData listener is attached, preventing browser/Electron message loss.
    expect(started).toBe(0)

    // Messages arriving before onData (e.g. on an emitter-style port) are buffered, followed by close sentinel.
    messageHandler!({ data: 'first' })
    messageHandler!({ data: new Uint8Array([1, 2, 3]) })
    messageHandler!({ data: null })
    expect(portClosed).toBe(1)

    const heard: Message[] = []
    let closed = 0
    t.onClose(() => { closed++ })
    expect(closed).toBe(0) // close waits until queued messages drain to the first onData listener
    t.onData((m) => { heard.push(m) })
    expect(heard).toEqual(['first', new Uint8Array([1, 2, 3])])
    expect(closed).toBe(1)
    expect(started).toBe(0) // already closed after draining queued sentinel, so start() is not called
  })

  it('calls start() on first onData when open and closes/fires onClose even if postMessage(null) throws', () => {
    let started = 0
    let portClosed = 0
    let closeEvents = 0
    const fake: MessagePortLike = {
      postMessage: (msg) => { if (msg === null) throw new Error('port detached') },
      close: () => { portClosed++ },
      start: () => { started++ },
      addEventListener: () => {},
    }
    const t = port(fake)
    t.onClose(() => { closeEvents++ })
    t.onData(() => {})
    expect(started).toBe(1)
    expect(() => t.close()).toThrow('port detached')
    expect(portClosed).toBe(1)
    expect(closeEvents).toBe(1)
    // Subsequent close is a safe no-op, and send after close is a no-op.
    expect(() => t.close()).not.toThrow()
    expect(() => t.send('after')).not.toThrow()
  })
})

describe('socket() transport hardening', () => {
  it('closes cleanly instead of throwing uncaught when ws.send() throws while draining queued messages on open', () => {
    const listeners: Record<string, Array<(arg?: unknown) => void>> = {}
    let wsClosed = 0
    let sendCalls = 0
    const fakeWs: WebSocketLike & { readyState: number } = {
      readyState: 0, // OPENING
      bufferedAmount: 0,
      binaryType: 'blob',
      send: () => {
        sendCalls++
        if (sendCalls === 2) throw new Error('socket broke on flush')
      },
      close: () => { wsClosed++ },
      addEventListener: ((type: string, listener: (arg?: unknown) => void) => {
        (listeners[type] ??= []).push(listener)
      }) as WebSocketLike['addEventListener'],
    }
    const t = socket(fakeWs)
    let closed = 0
    t.onClose(() => { closed++ })
    t.send('one')
    t.send('two')
    t.send('three')
    expect(t.waiting!()).toBe(11)

    fakeWs.readyState = 1 // OPEN
    expect(() => { for (const fn of listeners.open ?? []) fn() }).not.toThrow()
    expect(sendCalls).toBe(2)
    expect(wsClosed).toBe(1)
    expect(closed).toBe(1)
    expect(t.waiting!()).toBe(0)
  })

  it('decodes cross-realm ArrayBuffer messages and fires onClose even if ws.close() throws', () => {
    const listeners: Record<string, Array<(arg?: unknown) => void>> = {}
    const fakeWs: WebSocketLike = {
      readyState: 1,
      bufferedAmount: 0,
      binaryType: 'blob',
      send: () => {},
      close: () => { throw new Error('close failed') },
      addEventListener: ((type: string, listener: (arg?: unknown) => void) => {
        (listeners[type] ??= []).push(listener)
      }) as WebSocketLike['addEventListener'],
    }
    const t = socket(fakeWs)
    const heard: Message[] = []
    let closed = 0
    t.onData((m) => { heard.push(m) })
    t.onClose(() => { closed++ })

    const foreignBuffer = vm.runInNewContext('new Uint8Array([9, 8, 7]).buffer') as ArrayBuffer
    expect(foreignBuffer instanceof ArrayBuffer).toBe(false)
    for (const fn of listeners.message ?? []) fn({ data: foreignBuffer })
    expect(heard).toEqual([new Uint8Array([9, 8, 7])])

    expect(() => t.close()).toThrow('close failed')
    expect(closed).toBe(1)
    expect(() => t.close()).not.toThrow()
  })
})

describe('stream() and memoryPair() transport hardening', () => {
  it('fires onClose even when duplex.end() throws on close()', () => {
    const duplex: DuplexLike = {
      write: () => {},
      end: () => { throw new Error('end broke') },
      on: () => {},
    }
    const t = stream(duplex)
    let closed = 0
    t.onClose(() => { closed++ })
    expect(() => t.close()).toThrow('end broke')
    expect(closed).toBe(1)
    expect(() => t.close()).not.toThrow()
  })

  it('fires late onClose immediately on memoryPair() after close', async () => {
    const [a, b] = memoryPair()
    a.close()
    let lateA = 0
    a.onClose(() => { lateA++ })
    expect(lateA).toBe(1)
    await new Promise((resolve) => { setImmediate(resolve) })
    let lateB = 0
    b.onClose(() => { lateB++ })
    expect(lateB).toBe(1)
  })
})
