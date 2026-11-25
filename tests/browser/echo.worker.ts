// Real browser Web Worker endpoint hosting a joined link over a transferred MessagePort.
import { join, listen, port } from '../../src/index.js'

const workerGlobal = globalThis as unknown as {
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void
}

workerGlobal.addEventListener('message', (event) => {
  const transferred = event.data as MessagePort
  const link = listen(port(transferred))
  const seenTells: unknown[] = []
  let shownCallback: ((update: unknown) => void) | undefined
  let count = 0

  const toMain = join(link, {
    tell: (_to, payload) => {
      seenTells.push(payload)
      toMain.tell('ack', { count: seenTells.length, last: payload })
    },
    ask: (_to, name, args, heard, ended) => {
      if (name === 'BUMP') {
        count++
        // Update view asynchronously via microtask, and hold the answer via caughtUp so main sees view BEFORE answer.
        queueMicrotask(() => { shownCallback?.(count) })
        heard({ bumped: count })
        ended({ ok: true, value: { count, args } })
      } else {
        ended({ ok: true, value: { worker: true, name, args } })
      }
      return () => {}
    },
    follow: (_feature, _view, _args, shown) => {
      shownCallback = shown
      shown(count)
      return {
        stop: () => { shownCallback = undefined },
        caughtUp: (then) => { queueMicrotask(then) },
      }
    },
  })
})
