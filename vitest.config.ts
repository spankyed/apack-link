import * as http from 'node:http'
import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'
import { WebSocketServer } from 'ws'
import { accept, join, socket } from './src/index.js'

/** Starts an ephemeral Node WebSocketServer running `accept` + `join` for real browser WebSocket tests. */
const linkWsServerPlugin = () => {
  let rawServer: http.Server | undefined
  let wss: WebSocketServer | undefined
  let wsPort = 0
  return {
    name: 'apack-link-ws-test-server',
    async configureServer(server: {
      middlewares: { use(path: string, handler: (req: unknown, res: { setHeader(k: string, v: string): void; end(body: string): void }) => void): void }
      httpServer?: { once(event: string, listener: () => void): void } | null
    }) {
      rawServer = http.createServer()
      await new Promise<void>((resolve) => rawServer!.listen(0, '127.0.0.1', resolve))
      rawServer.unref()
      wsPort = (rawServer.address() as { port: number }).port
      wss = new WebSocketServer({ server: rawServer })

      const socketsByOwner = new Map<string, import('ws').WebSocket>()
      const droppedOwners = new Set<string>()
      const taking = accept<string>((link, owner) => {
        join(link, {
          tell: () => {},
          ask: (_to, name, args, heard, ended) => {
            if (name === 'ECHO') {
              heard({ step: 'seen', args })
              ended({ ok: true, value: { echoed: args } })
            } else if (name === 'DROP_THEN_ECHO') {
              if (!droppedOwners.has(owner)) {
                droppedOwners.add(owner)
                // Drop the active socket mid-ask before answering; the answer must cross on the reopened socket!
                socketsByOwner.get(owner)?.terminate()
              }
              heard({ step: 'after-drop', args })
              ended({ ok: true, value: { resumed: args } })
            } else {
              ended({ ok: false, failure: { kind: 'unknown', message: `Unknown: ${name}` } })
            }
            return () => {}
          },
          follow: (_feature, view, args, shown, over) => {
            if (view === 'missing') {
              over({ kind: 'gone', message: 'No such view' })
              return { stop: () => {} }
            }
            shown({ initial: args })
            return {
              stop: () => {},
              caughtUp: (then) => { queueMicrotask(then) },
            }
          },
        })
      })

      wss.on('connection', (ws, req) => {
        const parsed = new URL(req.url ?? '/', `http://127.0.0.1:${wsPort}`)
        const owner = parsed.searchParams.get('owner') ?? `anon-${Math.random()}`
        socketsByOwner.set(owner, ws)
        taking.take(socket(ws), owner)
      })

      server.middlewares.use('/__apack_link_ws', (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ url: `ws://127.0.0.1:${wsPort}` }))
      })

      server.httpServer?.once('close', () => {
        if (wss) {
          for (const client of wss.clients) client.terminate()
          wss.close()
          wss = undefined
        }
        rawServer?.close()
        rawServer = undefined
      })
    },
  }
}

export default defineConfig({
  test: {
    // A spec run under every order takes as long as there are orders, and longer on a machine running every file at
    // once: a minute is for one that never comes to rest, not for one that is slow.
    testTimeout: 60_000,
    projects: [
      {
        test: {
          name: 'node',
          testTimeout: 60_000,
          include: ['tests/**/*.spec.ts'],
          exclude: ['tests/browser/**'],
        },
      },
      {
        plugins: [linkWsServerPlugin()],
        test: {
          name: 'browser',
          testTimeout: 60_000,
          include: ['tests/browser/**/*.spec.ts'],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            screenshotFailures: false,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})
