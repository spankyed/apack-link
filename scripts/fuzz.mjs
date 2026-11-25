// Deterministic seeded fuzzer for @apackdev/link:
//   1. Hostile / malformed inbound wire inputs (JSON + msgpack) against dial, listen, and accept
//   2. Randomized peer hold / caughtUp / stall-bound state machine (ordering + payload-free stall invariants)
//   3. Randomized chunker & codec round-trip across Unicode edge cases and narrow `most` / `part` limits
//
// Usage: node scripts/fuzz.mjs [--seed=N] [--iterations=N]
import { encode as mpEncode, decode as mpDecode } from '@msgpack/msgpack'
import { accept, dial, join, LEAST, LINK, listen, memoryPair } from '../dist/index.js'

const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? Number(hit.slice(name.length + 3)) : fallback
}

const SEED = argOf('seed', 20261125)
const ITERATIONS = argOf('iterations', 300)

const mulberry32 = (seed) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const msgpackCodec = {
  encode: (value) => mpEncode(value),
  decode: (message) => mpDecode(typeof message === 'string' ? new TextEncoder().encode(message) : message),
  list: (items) => {
    const encoded = items.map((i) => (typeof i === 'string' ? new TextEncoder().encode(i) : i))
    const head = encoded.length < 16 ? Uint8Array.of(0x90 | encoded.length) : encoded.length < 0x10000
      ? Uint8Array.of(0xdc, encoded.length >>> 8, encoded.length & 0xff)
      : Uint8Array.of(0xdd, encoded.length >>> 24, (encoded.length >>> 16) & 0xff, (encoded.length >>> 8) & 0xff, encoded.length & 0xff)
    const total = head.length + encoded.reduce((s, a) => s + a.length, 0)
    const out = new Uint8Array(total)
    out.set(head, 0)
    let at = head.length
    for (const item of encoded) { out.set(item, at); at += item.length }
    return out
  },
  record: (fields) => {
    const pairs = fields.map(([k, v]) => [mpEncode(k), typeof v === 'string' ? new TextEncoder().encode(v) : v])
    const head = Uint8Array.of(0x80 | pairs.length)
    const total = head.length + pairs.reduce((s, [k, v]) => s + k.length + v.length, 0)
    const out = new Uint8Array(total)
    out.set(head, 0)
    let at = head.length
    for (const [k, v] of pairs) { out.set(k, at); at += k.length; out.set(v, at); at += v.length }
    return out
  },
}

const pick = (rng, list) => list[Math.floor(rng() * list.length)]
const randInt = (rng, min, max) => min + Math.floor(rng() * (max - min + 1))

const randomUnicode = (rng, len) => {
  const alphabet = ['a', 'z', '"', '\\', '\n', '\r', '\t', '\u0000', 'é', '✓', '中', '𝄞', '🚀', '{', '}', '[', ']']
  let out = ''
  for (let i = 0; i < len; i++) out += pick(rng, alphabet)
  return out
}

const VALID_ENDINGS = new Set(['closed', 'goodbye', 'version', 'lost', 'out of order', 'not a frame', 'overrun', 'too narrow'])

// --- 1. Hostile / malformed inbound wire fuzzing ---
function fuzzWire(rng, count) {
  const rawTransport = () => {
    let onDataCb
    let onCloseCb
    let closed = false
    const sent = []
    return {
      sent,
      deliver: (msg) => { if (!closed) onDataCb?.(msg) },
      drop: () => { if (!closed) { closed = true; onCloseCb?.() } },
      transport: {
        send: (msg) => { if (!closed) sent.push(msg) },
        onData: (cb) => { onDataCb = cb },
        onClose: (cb) => { onCloseCb = cb },
        close: () => { if (!closed) { closed = true; onCloseCb?.() } },
      },
    }
  }

  const randomEntry = (seq) => {
    const kind = randInt(rng, 0, 14)
    switch (kind) {
      case 0: return { seq, frame: { kind: 'tell', to: 'x', event: randInt(rng, 0, 99) } }
      case 1: return { seq, frame: { kind: 'tell', to: 'x', event: 'A'.repeat(randInt(rng, 900, 2200)) } }
      case 2: return { seq, frame: { kind: 'tell', to: 'x', event: 1 }, cause: 'c'.repeat(randInt(rng, 0, 1200)) }
      case 3: return { seq, frame: { kind: 'tell', to: 'x', event: 1 }, extraKey: true }
      case 4: return { seq, part: randInt(rng, -1, 3), of: pick(rng, [0, 1, 2, 10, 1_000_000]), data: pick(rng, ['', 'abc', new Uint8Array([1, 2]), 42]) }
      case 5: return { seq, part: 1, of: 2, data: 'tail', cause: 'forbidden-on-cont' }
      case 6: return { seq: pick(rng, [0, -1, 1.5, seq + 5, Number.MAX_SAFE_INTEGER + 1, '1']), frame: { kind: 'tell', to: 'x', event: 1 } }
      case 7: return { taken: pick(rng, [-1, 0, 1, 999, 'bad']), ...(rng() < 0.3 ? { lost: true } : {}) }
      case 8: return { there: pick(rng, [0, 1, -1, 'x']) }
      case 9: return { here: pick(rng, [0, 1, -1]) }
      case 10: return { bye: pick(rng, ['ended', 'restarting', 'other', 123]) }
      case 11: return { lost: pick(rng, [true, false, 1]) }
      case 12: return JSON.parse('{"__proto__":{"polluted":true},"seq":1,"frame":{"kind":"tell","to":"x","event":1}}')
      case 13: return { link: pick(rng, [0, 1, 2, -1, 1.5]), session: pick(rng, ['', 's', 42]), taken: pick(rng, [0, 5, -1]) }
      default: return pick(rng, [null, 42, 'str', [], {}])
    }
  }

  for (let i = 0; i < count; i++) {
    const useMsgpack = rng() < 0.35
    const codec = useMsgpack ? msgpackCodec : undefined
    const mode = i % 3
    const wire = rawTransport()
    const endings = []
    const thrown = []
    const opts = {
      ...(codec ? { codec } : {}),
      bound: { frame: 1024, kept: { frames: 16, size: 4096 }, waiting: { frames: 32, size: 8192 } },
      thrown: (err) => { thrown.push(err) },
    }
    if (mode === 0) {
      const l = dial(wire.transport, opts)
      l.onEnd((e) => { endings.push(e) })
    } else if (mode === 1) {
      const l = listen(wire.transport, opts)
      l.onEnd((e) => { endings.push(e) })
    } else {
      const acc = accept((l) => { l.onEnd((e) => { endings.push(e) }) }, opts)
      acc.take(wire.transport, `owner-${i % 5}`)
    }

    const encode = (val) => (useMsgpack ? mpEncode(val) : JSON.stringify(val))
    // Optionally send a valid hello first
    if (rng() < 0.7) {
      wire.deliver(encode([{ link: LINK, session: `fuzz-${i}`, taken: 0 }]))
    }

    const msgs = randInt(rng, 1, 8)
    let seq = 1
    for (let m = 0; m < msgs; m++) {
      const corrupt = rng()
      if (corrupt < 0.15) {
        // Invalid syntax or invalid UTF-8
        wire.deliver(pick(rng, ['{broken', '[1,2', '', new Uint8Array([0xff, 0xfe, 0xfd]), new Uint8Array(0)]))
      } else if (corrupt < 0.25) {
        // Non-array valid value
        wire.deliver(encode(pick(rng, [{ link: 1, session: 's', taken: 0 }, null, 123, 'hello', []])))
      } else if (corrupt < 0.35) {
        // Oversized raw blob
        wire.deliver('[' + '"a",'.repeat(5000) + '"z"]')
      } else {
        const batchLen = randInt(rng, 1, 4)
        const batch = []
        for (let b = 0; b < batchLen; b++) {
          batch.push(randomEntry(seq))
          if (rng() < 0.6) seq++
        }
        wire.deliver(encode(batch))
      }
    }
    wire.drop()

    if (thrown.length > 0) throw new Error(`fuzzWire iter ${i}: unexpected thrown: ${String(thrown[0])}`)
    if (endings.length > 1) throw new Error(`fuzzWire iter ${i}: ended more than once: ${JSON.stringify(endings)}`)
    for (const e of endings) {
      if (!VALID_ENDINGS.has(e.why)) throw new Error(`fuzzWire iter ${i}: invalid ending ${JSON.stringify(e)}`)
    }
    if (({}).polluted !== undefined) throw new Error(`fuzzWire iter ${i}: prototype polluted!`)
  }
}

// --- 2. Randomized peer hold / caughtUp / stall-bound state machine ---
async function fuzzPeerHold(rng, count) {
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  for (let i = 0; i < count; i++) {
    const [left, right] = memoryPair()
    const a = dial(left)
    const b = listen(right)
    const canary = `SECRET_CANARY_${i}`
    const maxFrames = randInt(rng, 2, 12)
    const maxSize = randInt(rng, 180, 1200)
    const stalls = []
    const reported = []
    const clientOrder = []

    const toBackend = join(a, {
      tell: (_to, ev) => { clientOrder.push(`tell:${String(ev)}`) },
      ask: () => () => {},
      follow: () => ({ stop: () => {} }),
    })

    const pendingCatchups = []
    const viewCaughtUpCount = new Map()
    const viewDefs = []
    const toWindow = join(b, {
      tell: () => {},
      ask: (_to, _name, args, heard, ended) => {
        if (rng() < 0.5) heard(`p:${String(args)}`)
        ended({ ok: true, value: `ans:${String(args)}` })
        return () => {}
      },
      follow: (_f, view, args, shown) => {
        const behavior = view // 'sync' | 'async' | 'stall' | 'throw' | 'then-throw'
        const tag = args.tag
        viewCaughtUpCount.set(tag, 0)
        viewDefs.push({ behavior, shown })
        let stopped = false
        return {
          stop: () => { stopped = true },
          caughtUp: (then) => {
            if (behavior === 'sync') { viewCaughtUpCount.set(tag, (viewCaughtUpCount.get(tag) ?? 0) + 1); then(); return }
            if (behavior === 'throw') throw new Error(`view ${behavior} broke`)
            if (behavior === 'then-throw') { then(); throw new Error(`view ${behavior} broke`) }
            if (behavior === 'async') {
              pendingCatchups.push(() => {
                if (!stopped) viewCaughtUpCount.set(tag, (viewCaughtUpCount.get(tag) ?? 0) + 1)
                then()
              })
              return
            }
            // 'stall': never calls then
          },
        }
      },
    }, {
      bound: { frames: maxFrames, size: maxSize },
      onStall: (stall) => {
        stalls.push(stall)
        if (JSON.stringify(stall).includes(canary)) {
          throw new Error(`fuzzPeerHold iter ${i}: canary leaked into HoldStall!`)
        }
      },
      thrown: (err) => { reported.push(err) },
    })

    const behaviors = ['sync', 'async', 'stall', 'throw', 'then-throw']
    const subs = []
    const viewOverIndex = new Map()
    const numViews = randInt(rng, 1, 4)
    for (let v = 0; v < numViews; v++) {
      const behavior = pick(rng, behaviors)
      const tag = `v${v}:${behavior}`
      subs.push(toBackend.follow('f', behavior, { secret: canary, tag }, (u) => {
        clientOrder.push(`shown:${tag}:${String(u)}`)
      }, (failure) => {
        viewOverIndex.set(tag, { index: clientOrder.length, message: failure.message })
        clientOrder.push(`over:${tag}:${failure.message}`)
      }))
    }
    await flush()

    const asks = []
    const steps = randInt(rng, 4, 24)
    for (let s = 0; s < steps; s++) {
      const op = randInt(rng, 0, 5)
      if (op <= 2) {
        toWindow.tell('t', `${canary}:${s}`, { cause: `${canary}:cause:${s}` })
      } else if (op === 3) {
        let endedCount = 0
        asks.push({
          get ended() { return endedCount },
          leave: toBackend.ask(
            'svc',
            'DO',
            `${canary}:a${s}`,
            () => { clientOrder.push('held:progress') },
            (o) => { endedCount++; if (o.ok) clientOrder.push('held:answer') },
          ),
        })
      } else if (op === 4 && pendingCatchups.length > 0) {
        const idx = randInt(rng, 0, pendingCatchups.length - 1)
        const fn = pendingCatchups.splice(idx, 1)[0]
        fn()
      } else if (op === 5 && subs.length > 0) {
        const idx = randInt(rng, 0, subs.length - 1)
        subs.splice(idx, 1)[0].stop()
      }
    }

    // Drain any remaining async catchups
    while (pendingCatchups.length > 0) pendingCatchups.shift()()
    await flush()

    // Close and verify every ask ended exactly once.
    a.close('ended')
    await flush()
    for (const ask of asks) {
      if (ask.ended !== 1) throw new Error(`fuzzPeerHold iter ${i}: ask ended ${ask.ended} times (expected 1)`)
    }
    // Every view that failed due to `caughtUp` throw or stall must have delivered `over` strictly before any held
    // frame (`tell`, `progress`, or `answer`) beyond the rounds that view had caught up for while live.
    const heldIndices = []
    for (let idx = 0; idx < clientOrder.length; idx++) {
      if (clientOrder[idx].startsWith('tell:') || clientOrder[idx].startsWith('held:')) heldIndices.push(idx)
    }
    for (const [tag, over] of viewOverIndex) {
      if (over.message === 'The link closed') continue
      const caught = viewCaughtUpCount.get(tag) ?? 0
      const firstUnapproved = heldIndices[caught]
      if (firstUnapproved !== undefined && over.index > firstUnapproved) {
        throw new Error(`fuzzPeerHold iter ${i}: view ${tag} over (${over.message}) at ${over.index} arrived after unapproved held frame #${caught} at ${firstUnapproved}`)
      }
    }
    for (const stall of stalls) {
      if (stall.views.length === 0) throw new Error(`fuzzPeerHold iter ${i}: empty HoldStall.views`)
      if (stall.held.frames <= 0 || stall.held.size <= 0) throw new Error(`fuzzPeerHold iter ${i}: non-positive HoldStall.held`)
    }
  }
}

// --- 3. Randomized chunker & codec round-trip ---
async function fuzzChunker(rng, count) {
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  const encoder = new TextEncoder()
  const byteSize = (m) => (typeof m === 'string' ? encoder.encode(m).byteLength : m.byteLength)

  for (let i = 0; i < count; i++) {
    const useMsgpack = rng() < 0.4
    const codec = useMsgpack ? msgpackCodec : undefined
    const most = randInt(rng, LEAST, LEAST + 3000)
    const part = randInt(rng, 16, 1500)
    const [rawL, rawR] = memoryPair()
    const wrap = (t) => ({
      ...t,
      most,
      send: (msg) => {
        const len = byteSize(msg)
        if (len > most) throw new Error(`fuzzChunker iter ${i}: wire message ${len} > most ${most}`)
        t.send(msg)
      },
    })
    const a = dial(wrap(rawL), { ...(codec ? { codec } : {}), part })
    const b = listen(wrap(rawR), { ...(codec ? { codec } : {}), part })
    const heard = []
    b.onFrame((frame, cause) => { heard.push({ frame, cause }) })

    const n = randInt(rng, 1, 5)
    const expected = []
    for (let k = 0; k < n; k++) {
      const payload = randomUnicode(rng, randInt(rng, 0, 2000))
      const cause = rng() < 0.5 ? randomUnicode(rng, randInt(rng, 0, 80)) : undefined
      const frame = { kind: 'tell', to: 'ch', event: payload }
      a.send(frame, cause === undefined ? undefined : { cause })
      expected.push({ frame, cause })
    }
    await flush()
    await flush()
    if (heard.length !== expected.length) {
      throw new Error(`fuzzChunker iter ${i}: expected ${expected.length} frames, got ${heard.length}`)
    }
    for (let k = 0; k < expected.length; k++) {
      if (heard[k].frame.event !== expected[k].frame.event || heard[k].cause !== expected[k].cause) {
        throw new Error(`fuzzChunker iter ${i}: frame ${k} mismatch`)
      }
    }
    a.close()
  }
}

const rng = mulberry32(SEED)
const start = Date.now()
fuzzWire(rng, ITERATIONS)
await fuzzPeerHold(rng, Math.max(40, Math.floor(ITERATIONS / 3)))
await fuzzChunker(rng, Math.max(40, Math.floor(ITERATIONS / 3)))
console.log(`fuzz passed (seed=${SEED}, wire=${ITERATIONS}, peerHold=${Math.max(40, Math.floor(ITERATIONS / 3))}, chunker=${Math.max(40, Math.floor(ITERATIONS / 3))}) in ${Date.now() - start}ms`)
