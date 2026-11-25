// Fast seeded fuzz suite executed inside `npm test` against `src/` directly (full budget via `npm run fuzz`).
import { describe, expect, it } from 'vitest'
import { accept, dial, join, LEAST, LINK, listen, memoryPair, type Ending, type Message, type Transport } from '../src/index.js'

const mulberry32 = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(rng: () => number, list: readonly T[]): T => list[Math.floor(rng() * list.length)]!
const randInt = (rng: () => number, min: number, max: number): number => min + Math.floor(rng() * (max - min + 1))

const VALID_ENDINGS = new Set(['closed', 'goodbye', 'version', 'lost', 'out of order', 'not a frame', 'overrun', 'too narrow'])

describe('seeded protocol & hold fuzzing', () => {
  it('survives hostile/malformed inbound wire inputs without uncaught errors or prototype pollution', () => {
    const rng = mulberry32(1337)
    for (let i = 0; i < 60; i++) {
      let onDataCb: ((m: Message) => void) | undefined
      let onCloseCb: (() => void) | undefined
      let closed = false
      const transport: Transport = {
        send: () => {},
        onData: (cb) => { onDataCb = cb },
        onClose: (cb) => { onCloseCb = cb },
        close: () => { if (!closed) { closed = true; onCloseCb?.() } },
      }
      const endings: Ending[] = []
      const thrown: unknown[] = []
      const opts = { bound: { frame: 1024, kept: { frames: 16, size: 4096 }, waiting: { frames: 32, size: 8192 } }, thrown: (e: unknown) => { thrown.push(e) } }
      if (i % 3 === 0) dial(transport, opts).onEnd((e) => { endings.push(e) })
      else if (i % 3 === 1) listen(transport, opts).onEnd((e) => { endings.push(e) })
      else accept<string>((l) => { l.onEnd((e) => { endings.push(e) }) }, opts).take(transport, `o-${i % 4}`)

      if (rng() < 0.7) onDataCb?.(JSON.stringify([{ link: LINK, session: `s-${i}`, taken: 0 }]))
      for (let m = 0; m < randInt(rng, 1, 6); m++) {
        if (closed) break
        const kind = randInt(rng, 0, 7)
        if (kind === 0) onDataCb?.(pick(rng, ['{bad', '', '[]', new Uint8Array([0xff, 0xfe])]))
        else if (kind === 1) onDataCb?.(JSON.stringify([{ seq: m + 1, part: 0, of: pick(rng, [0, 1, 1_000_000]), data: 'x' }]))
        else if (kind === 2) onDataCb?.(JSON.stringify([{ seq: m + 1, frame: { kind: 'tell', to: 'x', event: 'A'.repeat(1200) } }]))
        else if (kind === 3) onDataCb?.(JSON.stringify([{ seq: m + 1, frame: { kind: 'tell', to: 'x', event: 1 }, cause: 'c'.repeat(1100) }]))
        else if (kind === 4) onDataCb?.('[{"__proto__":{"polluted":true},"seq":1,"frame":{"kind":"tell","to":"x","event":1}}]')
        else if (kind === 5) onDataCb?.(JSON.stringify([{ taken: pick(rng, [-1, 999]), lost: true }]))
        else if (kind === 6) onDataCb?.(JSON.stringify([{ seq: pick(rng, [0, -1, 1.5, m + 9]), frame: { kind: 'tell', to: 'x', event: 1 } }]))
        else onDataCb?.(JSON.stringify([{ seq: m + 1, frame: { kind: 'tell', to: 'x', event: m } }]))
      }
      transport.close()
      expect(thrown).toEqual([])
      expect(endings.length).toBeLessThanOrEqual(1)
      for (const e of endings) expect(VALID_ENDINGS.has(e.why)).toBe(true)
      expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
    }
  })

  it('maintains hold-bound isolation and payload-free HoldStall under randomized peer traffic', async () => {
    const rng = mulberry32(4242)
    const flush = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })
    for (let i = 0; i < 20; i++) {
      const [left, right] = memoryPair()
      const a = dial(left)
      const b = listen(right)
      const canary = `CANARY_${i}`
      const pending: Array<() => void> = []
      const toBackend = join(a, { tell: () => {}, ask: () => () => {}, follow: () => ({ stop: () => {} }) })
      const toWindow = join(b, {
        tell: () => {},
        ask: (_to, _name, args, _heard, ended) => { ended({ ok: true, value: args }); return () => {} },
        follow: (_f, view) => ({
          stop: () => {},
          caughtUp: (then) => {
            if (view === 'sync') then()
            else if (view === 'async') pending.push(then)
            else if (view === 'throw') throw new Error('boom')
            // 'stall' never calls back
          },
        }),
      }, {
        bound: { frames: randInt(rng, 2, 6), size: randInt(rng, 200, 800) },
        onStall: (stall) => {
          expect(JSON.stringify(stall)).not.toContain(canary)
          expect(stall.views.length).toBeGreaterThan(0)
        },
        thrown: () => {},
      })
      for (const view of ['sync', 'async', 'stall', 'throw']) toBackend.follow('f', view, { canary }, () => {}, () => {})
      await flush()
      let ended = 0
      toBackend.ask('x', 'A', canary, () => {}, () => { ended++ })
      for (let k = 0; k < 10; k++) toWindow.tell('t', `${canary}:${k}`, { cause: `${canary}:c` })
      while (pending.length) pending.shift()!()
      await flush()
      a.close('ended')
      await flush()
      expect(ended).toBe(1)
    }
  })

  it('round-trips randomized Unicode frames under narrow most/part limits', async () => {
    const rng = mulberry32(9999)
    const flush = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })
    const encoder = new TextEncoder()
    const chars = ['a', '"', '\\', '\n', 'é', '✓', '中', '𝄞', '🚀']
    for (let i = 0; i < 20; i++) {
      const most = randInt(rng, LEAST, LEAST + 1500)
      const part = randInt(rng, 16, 600)
      const [rawL, rawR] = memoryPair()
      const wrap = (t: Transport): Transport => ({
        ...t,
        most,
        send: (msg) => {
          const len = typeof msg === 'string' ? encoder.encode(msg).byteLength : msg.byteLength
          expect(len).toBeLessThanOrEqual(most)
          t.send(msg)
        },
      })
      const a = dial(wrap(rawL), { part })
      const b = listen(wrap(rawR), { part })
      const heard: unknown[] = []
      b.onFrame((f) => { if (f.kind === 'tell') heard.push(f.event) })
      let payload = ''
      for (let c = 0; c < randInt(rng, 20, 900); c++) payload += pick(rng, chars)
      a.send({ kind: 'tell', to: 'u', event: payload }, { cause: 'fuzz' })
      await flush()
      await flush()
      expect(heard).toEqual([payload])
      a.close()
    }
  })
})
