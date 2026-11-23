// The scenarios an end of a link is held to. Each is written against `Port`, `Link` and `Transport` as the package
// exports them and reaches into nothing else, and is run over whatever pair of ends it is handed: this package's
// own in memory, the same over a socket, or another implementation of an end behind a transport.
//
// A scenario builds what it checks on a schedule and returns what must hold once everything has come to rest.
// Whatever a system does in answer to something arriving it does in a lane of its own, so that it falls in every
// place among what crosses the link.
import type { Frame } from '../frames.ts'
import type { Link } from '../link.ts'
import { join } from '../peer.ts'
import { holds, same } from './check.ts'
import { asking, desk, watching } from './desk.ts'
import type { Schedule } from './schedule.ts'
import { made } from './views.ts'
import type { Dropping } from './dropping.ts'
import type { Ending } from '../link.ts'

/** Two ends of one link. */
export interface Ends { readonly a: Link; readonly b: Link }

export interface KitScenario {
  readonly name: string
  play(schedule: Schedule, ends: Ends): () => void
}

const disconnected = { ok: false, failure: { kind: 'disconnected', message: 'The link closed' } }
const unsendable = { kind: 'failed', message: 'A value could not be sent' }

/** Steps 1's: asks matched to their answers, views followed and let go, and everything ended when the link is. */
export const peers: readonly KitScenario[] = [
  {
    name: 'a tell is taken each way, in the order it was sent',
    play: (_, { a, b }) => {
      const window = desk()
      const backend = desk()
      const toBackend = join(a, window.port)
      const toWindow = join(b, backend.port)
      toBackend.tell('threads', { type: 'OPENED' })
      toWindow.tell('panel', { type: 'CREATED', id: 1 })
      toBackend.tell('threads', { type: 'CLOSED' })
      toWindow.tell('panel', { type: 'CREATED', id: 2 })
      return () => {
        same(backend.told, [{ to: 'threads', event: { type: 'OPENED' } }, { to: 'threads', event: { type: 'CLOSED' } }], 'what the backend was told')
        same(window.told, [{ to: 'panel', event: { type: 'CREATED', id: 1 } }, { to: 'panel', event: { type: 'CREATED', id: 2 } }], 'what the window was told')
      }
    },
  },
  {
    name: 'an ask is answered once',
    play: (schedule, { a, b }) => {
      const answers = { label: 'the backend answers' }
      // It answers twice, as a system that is wrong might. Only the first is an answer.
      const backend = desk({ ask: (asked) => schedule.later(answers, () => { asked.ended({ ok: true, value: asked.args }); asked.ended({ ok: true, value: 'again' }); asked.heard('late') }) })
      join(b, backend.port)
      const made = asking(join(a, desk().port), 'threads', 'CREATE', { topic: 'one' })
      return () => {
        same(backend.asks.map(({ to, name, args }) => ({ to, name, args })), [{ to: 'threads', name: 'CREATE', args: { topic: 'one' } }], 'what the backend was asked')
        same(made.log, ['ended'], 'what the asker heard')
        same(made.ended, [{ ok: true, value: { topic: 'one' } }], 'how the ask ended')
        same(backend.asks[0]!.left, 0, 'times the backend was told the asker had gone')
      }
    },
  },
  {
    name: 'progress is heard before its answer, in the order it was sent',
    play: (schedule, { a, b }) => {
      const works = { label: 'the backend works' }
      const backend = desk({
        ask: (asked) => {
          for (const part of [1, 2, 3]) schedule.later(works, () => asked.heard(part))
          schedule.later(works, () => asked.ended({ ok: true, value: 'done' }))
        },
      })
      join(b, backend.port)
      const made = asking(join(a, desk().port), 'imports', 'RUN', {})
      return () => {
        same(made.heard, [1, 2, 3], 'the progress heard')
        same(made.log, ['heard', 'heard', 'heard', 'ended'], 'what the asker heard')
        same(made.ended, [{ ok: true, value: 'done' }], 'how the ask ended')
      }
    },
  },
  {
    name: 'an ask left before its answer hears nothing after, and the one answering is told once',
    play: (schedule, { a, b }) => {
      const works = { label: 'the backend works' }
      const backend = desk({
        ask: (asked) => {
          schedule.later(works, () => asked.heard('half'))
          schedule.later(works, () => asked.ended({ ok: true, value: 'done' }))
        },
      })
      join(b, backend.port)
      const made = asking(join(a, desk().port), 'imports', 'RUN', {})
      schedule.does('the asker', ['leaves', () => made.leave()])
      return () => {
        const left = made.log.indexOf('left')
        same(made.log.slice(left), ['left'], 'what the asker heard after it left')
        holds(made.ended.length <= 1, 'the ask ended at most once')
        // Told the asker has gone unless the answer had already left when word of it arrived, and never twice.
        const asked = backend.asks[0]
        if (made.ended.length) same(asked?.left, 0, 'times the backend was told the asker had gone, having answered it')
        else holds((asked?.left ?? 0) <= 1, 'the backend was told the asker had gone at most once')
      }
    },
  },
  {
    name: 'an ask left is passed on to the one answering',
    play: (schedule, { a, b }) => {
      // It never answers, so the only way it stops is being told.
      const backend = desk()
      join(b, backend.port)
      const made = asking(join(a, desk().port), 'imports', 'RUN', {})
      schedule.does('the asker', ['leaves', () => made.leave()], ['leaves again', () => made.leave()])
      return () => {
        same(backend.asks.length, 1, 'asks the backend took')
        same(backend.asks[0]!.left, 1, 'times the backend was told the asker had gone')
        same(made.ended, [], 'how the ask ended')
      }
    },
  },
  {
    name: 'two asks cross each way at once, each answered with its own',
    play: (schedule, { a, b }) => {
      const answering = (who: string) => {
        const lane = { label: `${who} answers` }
        return desk({ ask: (asked) => schedule.later(lane, () => asked.ended({ ok: true, value: `${who} answers ${String(asked.args)}` })) })
      }
      const toB = join(a, answering('a').port)
      const toA = join(b, answering('b').port)
      const fromA = [asking(toB, 'x', 'ASK', 'a1'), asking(toB, 'x', 'ASK', 'a2')]
      const fromB = [asking(toA, 'y', 'ASK', 'b1'), asking(toA, 'y', 'ASK', 'b2')]
      return () => {
        same(fromA.map((made) => made.ended), [[{ ok: true, value: 'b answers a1' }], [{ ok: true, value: 'b answers a2' }]], 'how what a asked ended')
        same(fromB.map((made) => made.ended), [[{ ok: true, value: 'a answers b1' }], [{ ok: true, value: 'a answers b2' }]], 'how what b asked ended')
      }
    },
  },
  {
    name: 'a view is shown, changed and let go, and shows nothing after',
    play: (schedule, { a, b }) => {
      const changes = { label: 'the view changes' }
      const backend = desk({
        follow: (viewed) => {
          viewed.shown(['one'])
          schedule.later(changes, () => viewed.shown(['one', 'two']))
          schedule.later(changes, () => viewed.shown(['one', 'two', 'three']))
        },
      })
      join(b, backend.port)
      const view = watching(join(a, desk().port), 'threads', 'list', { open: true })
      schedule.does('the follower', ['lets go', () => view.stop()], ['lets go again', () => view.stop()])
      return () => {
        same(backend.views.map(({ feature, view: name, args }) => ({ feature, name, args })), [{ feature: 'threads', name: 'list', args: { open: true } }], 'what the backend ran')
        same(backend.views[0]!.stopped, 1, 'times the view was stopped')
        const all = [['one'], ['one', 'two'], ['one', 'two', 'three']]
        same(view.shown, all.slice(0, view.shown.length), 'what was shown, in order')
        same(view.log.slice(view.log.indexOf('stopped')).filter((entry) => entry !== 'stopped'), [], 'what the follower was shown after it let go')
        same(view.over, [], 'how the view ended')
      }
    },
  },
  {
    name: 'a view goes on being shown until it is let go',
    play: (schedule, { a, b }) => {
      const changes = { label: 'the view changes' }
      const backend = desk({ follow: (viewed) => { for (const result of [1, 2, 3]) schedule.later(changes, () => viewed.shown(result)) } })
      join(b, backend.port)
      const view = watching(join(a, desk().port), 'threads', 'count', {})
      return () => {
        same(view.shown, [1, 2, 3], 'what was shown')
        same(backend.views[0]!.stopped, 0, 'times the view was stopped')
      }
    },
  },
  {
    name: 'a view ended by the one running it is said to be over, once, and shows nothing after',
    play: (schedule, { a, b }) => {
      const runs = { label: 'the view runs' }
      const backend = desk({
        follow: (viewed) => {
          schedule.later(runs, () => viewed.shown(1))
          schedule.later(runs, () => { viewed.over({ kind: 'reloaded', message: 'The pack was reloaded' }); viewed.over({ kind: 'again', message: 'Twice' }); viewed.shown(2) })
        },
      })
      join(b, backend.port)
      const view = watching(join(a, desk().port), 'threads', 'list', {})
      return () => {
        same(view.log, ['shown', 'over'], 'what the follower heard')
        same(view.over, [{ kind: 'reloaded', message: 'The pack was reloaded' }], 'how the view ended')
        // The one running it ended it, so there is nothing to stop.
        same(backend.views[0]!.stopped, 0, 'times the view was stopped')
        view.stop()
      }
    },
  },
  {
    name: 'a view there is not is over at once',
    play: (_, { a, b }) => {
      const backend = desk({ follow: (viewed) => { viewed.over({ kind: 'unknown', message: 'There is no such view' }) } })
      join(b, backend.port)
      const view = watching(join(a, desk().port), 'threads', 'missing', {})
      return () => {
        same(view.log, ['over'], 'what the follower heard')
        same(view.over, [{ kind: 'unknown', message: 'There is no such view' }], 'how the view ended')
        same(backend.views[0]!.stopped, 0, 'times the view was stopped')
      }
    },
  },
  ...(['a', 'b'] as const).map((closer): KitScenario => ({
    name: `the link ending ends an ask waiting, an ask being answered and a view followed, once each (${closer} closes)`,
    play: (schedule, ends) => {
      const { a, b } = ends
      // Each end asks the other and follows a view of the other's, and neither answers: only the link ending ends them.
      const systems = { a: desk({ follow: (viewed) => { viewed.shown('first') } }), b: desk({ follow: (viewed) => { viewed.shown('first') } }) }
      const toB = join(a, systems.a.port)
      const toA = join(b, systems.b.port)
      const made = { a: asking(toB, 'x', 'ASK', 1), b: asking(toA, 'y', 'ASK', 2) }
      const views = { a: watching(toB, 'x', 'view', {}), b: watching(toA, 'y', 'view', {}) }
      schedule.does(closer, ['closes the link', () => ends[closer].close()])
      return () => {
        // Whatever was answering or showing goes on trying after the link has gone, and nobody hears it.
        for (const system of [systems.a, systems.b]) {
          for (const asked of system.asks) { asked.heard('late'); asked.ended({ ok: true, value: 'late' }) }
          for (const viewed of system.views) { viewed.shown('late'); viewed.over({ kind: 'late', message: 'late' }) }
        }
        for (const end of ['a', 'b'] as const) {
          same(made[end].ended, [disconnected], `how what ${end} asked ended`)
          same(made[end].heard, [], `the progress ${end} heard`)
          same(views[end].over, [disconnected.failure], `how the view ${end} follows ended`)
          holds(views[end].log.at(-1) === 'over', `nothing was shown to ${end} after its view was over`)
          // An ask or a follow the link ended before it arrived was never taken, so there is nothing to tell.
          same(systems[end].asks.map((asked) => asked.left), systems[end].asks.map(() => 1), `times ${end} was told its asker had gone`)
          same(systems[end].views.map((viewed) => viewed.stopped), systems[end].views.map(() => 1), `times the view ${end} runs was stopped`)
        }
        // What is asked or followed once the link has gone is ended there and then.
        same(asking(toB, 'x', 'ASK', 3).ended, [disconnected], 'how an ask made after the link ended ended')
        same(watching(toB, 'x', 'view', {}).over, [disconnected.failure], 'how a view followed after the link ended ended')
      }
    },
  })),
  {
    name: 'an answer that cannot be sent fails that ask, and the next ask is answered',
    play: (schedule, { a, b }) => {
      const answers = { label: 'the backend answers' }
      const backend = desk({ ask: (asked) => schedule.later(answers, () => asked.ended({ ok: true, value: asked.args === 'first' ? { big: 1n } : 'fine' })) })
      join(b, backend.port)
      const toBackend = join(a, desk().port)
      const made = [asking(toBackend, 'x', 'ASK', 'first'), asking(toBackend, 'x', 'ASK', 'second')]
      return () => {
        same(made[0]!.ended, [{ ok: false, failure: unsendable }], 'how the first ask ended')
        same(made[1]!.ended, [{ ok: true, value: 'fine' }], 'how the second ask ended')
      }
    },
  },
  {
    name: 'progress that cannot be sent fails its ask, once, and whoever was answering is told to stop',
    play: (schedule, { a, b }) => {
      const works = { label: 'the backend works' }
      const backend = desk({
        ask: (asked) => {
          schedule.later(works, () => asked.heard('one'))
          schedule.later(works, () => asked.heard({ big: 1n }))
          schedule.later(works, () => { asked.heard('three'); asked.ended({ ok: true, value: 'done' }) })
        },
      })
      join(b, backend.port)
      const made = asking(join(a, desk().port), 'x', 'ASK', {})
      return () => {
        same(made.heard, ['one'], 'the progress heard')
        same(made.ended, [{ ok: false, failure: unsendable }], 'how the ask ended')
        same(backend.asks[0]!.left, 1, 'times the backend was told to stop')
      }
    },
  },
  {
    name: 'an ask or a follow that cannot be sent is ended where it was made, and the next is taken',
    play: (schedule, { a, b }) => {
      const answers = { label: 'the backend answers' }
      const backend = desk({ ask: (asked) => schedule.later(answers, () => asked.ended({ ok: true, value: asked.args })), follow: (viewed) => { viewed.shown(viewed.args) } })
      join(b, backend.port)
      const toBackend = join(a, desk().port)
      const refused = asking(toBackend, 'x', 'ASK', { big: 1n })
      const unfollowed = watching(toBackend, 'x', 'view', { big: 1n })
      same(refused.ended, [{ ok: false, failure: unsendable }], 'how the ask that could not be sent ended')
      same(unfollowed.over, [unsendable], 'how the view that could not be followed ended')
      const made = asking(toBackend, 'x', 'ASK', 'next')
      const view = watching(toBackend, 'x', 'view', 'next')
      return () => {
        same(backend.asks.length, 1, 'asks the backend took')
        same(made.ended, [{ ok: true, value: 'next' }], 'how the next ask ended')
        same(view.shown, ['next'], 'what the next view showed')
        refused.leave()
        unfollowed.stop()
      }
    },
  },
  {
    name: 'a view whose result cannot be sent is over, and is stopped',
    play: (_, { a, b }) => {
      const backend = desk({ follow: (viewed) => { viewed.shown('one'); viewed.shown({ big: 1n }); viewed.shown('three') } })
      join(b, backend.port)
      const view = watching(join(a, desk().port), 'x', 'view', {})
      return () => {
        same(view.log, ['shown', 'over'], 'what the follower heard')
        same(view.over, [unsendable], 'how the view ended')
        same(backend.views[0]!.stopped, 1, 'times the view was stopped')
      }
    },
  },
  {
    name: 'a system that throws where it is asked or followed fails that one, and the next is taken',
    play: (schedule, { a, b }) => {
      const answers = { label: 'the backend answers' }
      const backend = desk({
        ask: (asked) => { if (asked.args === 'breaks') throw new Error('broken'); schedule.later(answers, () => asked.ended({ ok: true, value: 'fine' })) },
        follow: (viewed) => { if (viewed.args === 'breaks') throw new Error('broken'); viewed.shown('fine') },
      })
      join(b, backend.port)
      const toBackend = join(a, desk().port)
      const made = [asking(toBackend, 'x', 'ASK', 'breaks'), asking(toBackend, 'x', 'ASK', 'works')]
      const views = [watching(toBackend, 'x', 'view', 'breaks'), watching(toBackend, 'x', 'view', 'works')]
      return () => {
        const failed = { kind: 'failed', message: 'It could not be taken' }
        same(made.map((ask) => ask.ended), [[{ ok: false, failure: failed }], [{ ok: true, value: 'fine' }]], 'how the asks ended')
        same(views.map((view) => view.over), [[failed], []], 'how the views ended')
        same(views[1]!.shown, ['fine'], 'what the second view showed')
      }
    },
  },
  // In these the other end is a link with no peer on it, saying what a peer never would: more for an id after it
  // was forgotten. A frame for an id nobody holds is one that crossed a `left` or an `unfollow` on the way.
  {
    name: 'what arrives for an ask after its answer is dropped',
    play: (schedule, { a, b }) => {
      const says = { label: 'the other end says' }
      b.onFrame((frame) => {
        if (frame.kind !== 'ask') return
        const more: Frame[] = [
          { kind: 'answer', id: frame.id, outcome: { ok: true, value: 'once' } },
          { kind: 'answer', id: frame.id, outcome: { ok: true, value: 'twice' } },
          { kind: 'progress', id: frame.id, update: 'late' },
        ]
        for (const one of more) schedule.later(says, () => b.send(one))
      })
      const made = asking(join(a, desk().port), 'x', 'ASK', {})
      return () => {
        same(made.log, ['ended'], 'what the asker heard')
        same(made.ended, [{ ok: true, value: 'once' }], 'how the ask ended')
      }
    },
  },
  {
    name: 'what arrives for an ask after it was left is dropped',
    play: (schedule, { a, b }) => {
      const says = { label: 'the other end says' }
      b.onFrame((frame) => {
        if (frame.kind !== 'left') return
        schedule.later(says, () => b.send({ kind: 'progress', id: frame.id, update: 'late' }))
        schedule.later(says, () => b.send({ kind: 'answer', id: frame.id, outcome: { ok: true, value: 'late' } }))
      })
      const made = asking(join(a, desk().port), 'x', 'ASK', {})
      made.leave()
      return () => { same(made.log, ['left'], 'what the asker heard') }
    },
  },
  {
    name: 'what arrives for a view after it was let go, or after it was over, is dropped',
    play: (schedule, { a, b }) => {
      const says = { label: 'the other end says' }
      b.onFrame((frame) => {
        if (frame.kind === 'unfollow') {
          schedule.later(says, () => b.send({ kind: 'shown', id: frame.id, update: 'late' }))
          schedule.later(says, () => b.send({ kind: 'over', id: frame.id, failure: { kind: 'late', message: 'Late' } }))
        }
        if (frame.kind === 'follow' && frame.args === 'ended') {
          b.send({ kind: 'over', id: frame.id, failure: { kind: 'ended', message: 'Once' } })
          b.send({ kind: 'over', id: frame.id, failure: { kind: 'ended', message: 'Twice' } })
          b.send({ kind: 'shown', id: frame.id, update: 'late' })
        }
      })
      const toBackend = join(a, desk().port)
      const letGo = watching(toBackend, 'x', 'view', 'let go')
      letGo.stop()
      const ended = watching(toBackend, 'x', 'view', 'ended')
      return () => {
        same(letGo.log, ['stopped'], 'what the view that was let go heard')
        same(ended.log, ['over'], 'what the view that was ended heard')
        same(ended.over, [{ kind: 'ended', message: 'Once' }], 'how the ended view ended')
      }
    },
  },
  {
    name: 'what arrives for an id that was never used is dropped',
    play: (_, { a, b }) => {
      const window = desk()
      const toBackend = join(a, window.port)
      const made = asking(toBackend, 'x', 'ASK', {})
      const view = watching(toBackend, 'x', 'view', {})
      const stray: Frame[] = [
        { kind: 'answer', id: 99, outcome: { ok: true, value: 'nobody asked' } },
        { kind: 'progress', id: 99, update: 'nobody asked' },
        { kind: 'shown', id: 99, update: 'nobody follows' },
        { kind: 'over', id: 99, failure: { kind: 'stray', message: 'Nobody follows' } },
        { kind: 'left', id: 99 },
        { kind: 'unfollow', id: 99 },
      ]
      for (const frame of stray) b.send(frame)
      return () => {
        same(made.log, [], 'what the asker heard')
        same(view.log, [], 'what the follower heard')
        same([window.asks.length, window.views.length], [0, 0], 'what the window was asked and had followed')
      }
    },
  },
  // And in these the bare link listens: what a peer puts on the wire, whatever its system does.
  {
    name: 'a system that answers twice, or shows more after a view is over, puts one answer and one over on the wire',
    play: (schedule, { a, b }) => {
      const works = { label: 'the backend works' }
      const backend = desk({
        ask: (asked) => schedule.later(works, () => { asked.heard('half'); asked.ended({ ok: true, value: 'once' }); asked.ended({ ok: true, value: 'twice' }); asked.heard('late') }),
        follow: (viewed) => schedule.later(works, () => { viewed.shown(1); viewed.over({ kind: 'ended', message: 'Once' }); viewed.over({ kind: 'ended', message: 'Twice' }); viewed.shown(2) }),
      })
      join(b, backend.port)
      const arrived: Frame[] = []
      a.onFrame((frame) => { arrived.push(frame) })
      a.send({ kind: 'ask', id: 1, to: 'x', name: 'ASK', args: {} })
      a.send({ kind: 'follow', id: 1, feature: 'x', view: 'view', args: {} })
      return () => {
        same(arrived, [
          { kind: 'progress', id: 1, update: 'half' },
          { kind: 'answer', id: 1, outcome: { ok: true, value: 'once' } },
          { kind: 'shown', id: 1, update: 1 },
          { kind: 'over', id: 1, failure: { kind: 'ended', message: 'Once' } },
        ], 'what crossed')
      }
    },
  },
  {
    name: 'leaving an ask twice, or letting a view go twice, is said once',
    play: (_, { a, b }) => {
      const arrived: Frame[] = []
      b.onFrame((frame) => { arrived.push(frame) })
      const toBackend = join(a, desk().port)
      const made = asking(toBackend, 'x', 'ASK', {})
      const view = watching(toBackend, 'x', 'view', {})
      made.leave()
      made.leave()
      view.stop()
      view.stop()
      return () => { same(arrived.map((frame) => frame.kind), ['ask', 'follow', 'left', 'unfollow'], 'what crossed') }
    },
  },
  {
    name: 'an id is used once: an ask or a follow that uses one again is not taken',
    play: (_, { a, b }) => {
      const backend = desk()
      join(b, backend.port)
      a.send({ kind: 'ask', id: 1, to: 'x', name: 'ASK', args: 'first' })
      a.send({ kind: 'ask', id: 1, to: 'x', name: 'ASK', args: 'again' })
      a.send({ kind: 'left', id: 1 })
      a.send({ kind: 'ask', id: 1, to: 'x', name: 'ASK', args: 'after it was left' })
      a.send({ kind: 'follow', id: 1, feature: 'x', view: 'view', args: 'first' })
      a.send({ kind: 'follow', id: 1, feature: 'x', view: 'view', args: 'again' })
      a.send({ kind: 'ask', id: 2, to: 'x', name: 'ASK', args: 'second' })
      return () => {
        same(backend.asks.map((asked) => asked.args), ['first', 'second'], 'the asks the backend took')
        same(backend.views.map((viewed) => viewed.args), ['first'], 'the views the backend ran')
      }
    },
  },
]

/**
 * A window that follows views of how many things there are, and notes, for each answer and each tell it hears,
 * what its views showed then. Every answer and tell says how many there were at least when it was sent, so a
 * window told of a thing its views do not show yet is found.
 */
const window = (port: () => ReturnType<typeof join>) => {
  const views: Array<ReturnType<typeof watching>> = []
  const behind: string[] = []
  const heard: string[] = []
  const shows = (): number => Math.min(...views.map((view) => (view.shown.at(-1) as number | undefined) ?? -1))
  const check = (what: string, atLeast: number): void => {
    heard.push(what)
    if (shows() < atLeast) behind.push(`${what}, while its views showed ${shows()}`)
  }
  return {
    desk: desk({ tell: (_, event) => { const { what, atLeast } = event as { what: string; atLeast: number }; check(`told ${what}`, atLeast) } }),
    follow: (view = 'count') => { views.push(watching(port(), 'things', view, {})) },
    /** Asks for a thing to be made, and does `then` once it is answered. */
    ask: (what: string, then?: () => void) => {
      port().ask('things', 'MAKE', what, () => {}, (outcome) => {
        if (outcome.ok) check(`answered ${what}`, (outcome.value as { atLeast: number }).atLeast)
        else heard.push(`failed ${what}`)
        then?.()
      })
    },
    views,
    behind,
    heard,
  }
}

/** A backend whose `MAKE` makes a thing, tells the window it did, and answers. */
const backend = (things: ReturnType<typeof made>, toWindow: () => ReturnType<typeof join>) => desk({
  ask: (asked) => {
    const atLeast = things.make()
    toWindow().tell('panel', { what: String(asked.args), atLeast })
    asked.ended({ ok: true, value: { atLeast } })
  },
  follow: (viewed) => things.follow(viewed),
})

/** The hold's scenarios that need it: each fails in some order with views that offer no `caughtUp`. */
const needsTheHold = (offers: boolean): KitScenario[] => [
  {
    name: 'asked for one thing and then another, the asker is answered and told only after its view shows it',
    play: (schedule, { a, b }) => {
      const things = made(schedule, { offers })
      let toBackend!: ReturnType<typeof join>
      let toWindow!: ReturnType<typeof join>
      const it = window(() => toBackend)
      toBackend = join(a, it.desk.port)
      toWindow = join(b, backend(things, () => toWindow).port)
      it.follow()
      it.ask('one', () => it.ask('two'))
      return () => {
        same(it.behind, [], 'what the window heard before its views showed it')
        same([...it.heard].sort(), ['answered one', 'answered two', 'told one', 'told two'], 'what the window heard')
        same(it.views[0]!.shown.at(-1), 2, 'what the view shows at the end')
      }
    },
  },
  {
    name: 'with two views, the asker is answered and told only after both show it',
    play: (schedule, { a, b }) => {
      const things = made(schedule, { offers })
      let toBackend!: ReturnType<typeof join>
      let toWindow!: ReturnType<typeof join>
      const it = window(() => toBackend)
      toBackend = join(a, it.desk.port)
      toWindow = join(b, backend(things, () => toWindow).port)
      it.follow()
      it.follow()
      it.ask('one')
      return () => {
        same(it.behind, [], 'what the window heard before its views showed it')
        same([...it.heard].sort(), ['answered one', 'told one'], 'what the window heard')
      }
    },
  },
  {
    name: 'asked for two at once, the asker is answered and told of each only after its view shows it',
    play: (schedule, { a, b }) => {
      const things = made(schedule, { offers })
      let toBackend!: ReturnType<typeof join>
      let toWindow!: ReturnType<typeof join>
      const it = window(() => toBackend)
      toBackend = join(a, it.desk.port)
      toWindow = join(b, backend(things, () => toWindow).port)
      it.follow()
      it.ask('one')
      it.ask('two')
      return () => {
        same(it.behind, [], 'what the window heard before its views showed it')
        same([...it.heard].sort(), ['answered one', 'answered two', 'told one', 'told two'], 'what the window heard')
      }
    },
  },
  {
    name: 'what is said after a round of the hold began waits for the next round',
    play: (schedule, { a, b }) => {
      const things = made(schedule, { offers })
      let toBackend!: ReturnType<typeof join>
      let toWindow!: ReturnType<typeof join>
      const it = window(() => toBackend)
      toBackend = join(a, it.desk.port)
      // Told of nothing new, then something is made, then told of it: the second tell waits on the view's change.
      toWindow = join(b, desk({
        ask: (asked) => {
          toWindow.tell('panel', { what: 'before', atLeast: 0 })
          const atLeast = things.make()
          toWindow.tell('panel', { what: 'after', atLeast })
          asked.ended({ ok: true, value: { atLeast } })
        },
        follow: (viewed) => things.follow(viewed),
      }).port)
      it.follow()
      it.ask('one')
      return () => {
        same(it.behind, [], 'what the window heard before its views showed it')
        same(it.heard, ['told before', 'told after', 'answered one'], 'what the window heard')
      }
    },
  },
]

/** Step 2's: what a system says waits until the views it runs for the other end have caught up. */
export const hold: readonly KitScenario[] = [
  ...needsTheHold(true),
  {
    name: 'an end that runs no views for the other holds nothing',
    play: (schedule, { a, b }) => {
      const things = made(schedule)
      let toWindow!: ReturnType<typeof join>
      // The window follows nothing, so a view that would never call back is never asked.
      const backendDesk = desk({ ask: (asked) => { toWindow.tell('panel', 'made'); asked.ended({ ok: true, value: 'made' }) }, follow: (viewed) => things.follow(viewed) })
      toWindow = join(b, backendDesk.port)
      const window = desk()
      const made_ = asking(join(a, window.port), 'things', 'MAKE', {})
      return () => {
        same(made_.ended, [{ ok: true, value: 'made' }], 'how the ask ended')
        same(window.told, [{ to: 'panel', event: 'made' }], 'what the window was told')
        same(things.soon, [], 'what the views were asked')
      }
    },
  },
  {
    name: 'a view stopped while it is waited on does not hold what waits',
    play: (schedule, { a, b }) => {
      const things = made(schedule)
      const backendDesk = desk({ ask: (asked) => { asked.ended({ ok: true, value: 'made' }) }, follow: (viewed) => things.follow(viewed) })
      join(b, backendDesk.port)
      const toBackend = join(a, desk().port)
      const view = watching(toBackend, 'things', 'stuck', {})
      const ask = asking(toBackend, 'things', 'MAKE', {})
      schedule.does('the window', ['lets the view go', () => view.stop()])
      return () => { same(ask.ended, [{ ok: true, value: 'made' }], 'how the ask ended') }
    },
  },
  {
    name: 'a view ended by the one running it while it is waited on does not hold what waits',
    play: (schedule, { a, b }) => {
      const things = made(schedule)
      const ends = { label: 'the view ends' }
      const backendDesk = desk({
        ask: (asked) => { asked.ended({ ok: true, value: 'made' }) },
        follow: (viewed) => { schedule.later(ends, () => viewed.over({ kind: 'reloaded', message: 'The pack was reloaded' })); return things.follow(viewed) },
      })
      join(b, backendDesk.port)
      const toBackend = join(a, desk().port)
      const view = watching(toBackend, 'things', 'stuck', {})
      const ask = asking(toBackend, 'things', 'MAKE', {})
      return () => {
        same(ask.ended, [{ ok: true, value: 'made' }], 'how the ask ended')
        same(view.over, [{ kind: 'reloaded', message: 'The pack was reloaded' }], 'how the view ended')
      }
    },
  },
  {
    name: 'a view followed after something was said is not waited on for it',
    play: (schedule, { a, b }) => {
      const things = made(schedule)
      const backendDesk = desk({ ask: (asked) => { asked.ended({ ok: true, value: 'made' }) }, follow: (viewed) => things.follow(viewed) })
      join(b, backendDesk.port)
      const toBackend = join(a, desk().port)
      watching(toBackend, 'things', 'count', {})
      const ask = asking(toBackend, 'things', 'MAKE', {})
      // Followed after the ask, so it arrives after the answer was said. It never calls back.
      const late = watching(toBackend, 'things', 'stuck', {})
      return () => {
        same(ask.ended, [{ ok: true, value: 'made' }], 'how the ask ended')
        same(late.shown, [0], 'what the late view showed')
      }
    },
  },
  {
    name: 'the views are asked to be soon for an answer, and not for progress alone',
    play: (schedule, { a, b }) => {
      const things = made(schedule)
      const works = { label: 'the backend works' }
      let answered = false
      let beforeTheAnswer = 0
      const backendDesk = desk({
        ask: (asked) => {
          schedule.later(works, () => asked.heard('one'))
          schedule.later(works, () => asked.heard('two'))
          schedule.later(works, () => { beforeTheAnswer = things.soon.length; answered = true; asked.ended({ ok: true, value: 'made' }) })
        },
        follow: (viewed) => things.follow(viewed),
      })
      join(b, backendDesk.port)
      const toBackend = join(a, desk().port)
      watching(toBackend, 'things', 'count', {})
      const ask = asking(toBackend, 'things', 'MAKE', {})
      return () => {
        holds(answered, 'the ask was answered')
        same(things.soon.slice(0, beforeTheAnswer), things.soon.slice(0, beforeTheAnswer).map(() => false), 'soon, for progress alone')
        holds(beforeTheAnswer >= 2, 'the views were asked for each progress')
        same(things.soon.slice(beforeTheAnswer), [true], 'soon, for the answer')
        same(ask.heard, ['one', 'two'], 'the progress heard')
      }
    },
  },
  {
    name: 'what cannot be sent while things wait is refused where it was said, and what waits still goes in order',
    play: (schedule, { a, b }) => {
      const things = made(schedule)
      let toWindow!: ReturnType<typeof join>
      const thrown: string[] = []
      const window = desk()
      const toBackend = join(a, window.port)
      toWindow = join(b, desk({
        ask: (asked) => {
          toWindow.tell('panel', 'first')
          try { toWindow.tell('panel', { big: 1n }) } catch (error) { thrown.push((error as Error).name) }
          if (asked.args === 'bad') asked.ended({ ok: true, value: { big: 1n } })
          else { toWindow.tell('panel', 'last'); asked.ended({ ok: true, value: 'fine' }) }
        },
        follow: (viewed) => things.follow(viewed),
      }).port)
      watching(toBackend, 'things', 'count', {})
      const bad = asking(toBackend, 'things', 'MAKE', 'bad')
      const fine = asking(toBackend, 'things', 'MAKE', 'fine')
      return () => {
        same(thrown, ['TypeError', 'TypeError'], 'what telling what cannot be sent threw')
        same(bad.ended, [{ ok: false, failure: { kind: 'failed', message: 'A value could not be sent' } }], 'how the ask whose answer could not be sent ended')
        same(fine.ended, [{ ok: true, value: 'fine' }], 'how the next ask ended')
        same(window.told.map((told) => told.event), ['first', 'first', 'last'], 'what the window was told')
      }
    },
  },
]

/** The hold's scenarios with the hold taken out: views that offer no `caughtUp`. Each fails in some order. */
export const withoutTheHold: readonly KitScenario[] = needsTheHold(false)

export interface DroppingScenario {
  readonly name: string
  play(schedule: Schedule, ends: Dropping): () => void
}

const dropsOnce = (schedule: Schedule, ends: Dropping): void => { schedule.does('the network', ['drops', () => ends.drop()]) }

/** Step 5's: a link that outlives what carries it, with nothing taken twice. Each drops at a moment the schedule picks. */
export const resume: readonly DroppingScenario[] = [
  {
    name: 'an ask is answered once, and the one answering asked once, whenever the connection drops',
    play: (schedule, ends) => {
      const answers = { label: 'the backend answers' }
      const backend = desk({ ask: (asked) => schedule.later(answers, () => asked.ended({ ok: true, value: asked.args })) })
      join(ends.b, backend.port)
      const made = asking(join(ends.a, desk().port), 'threads', 'CREATE', 'one')
      dropsOnce(schedule, ends)
      return () => {
        same(made.ended, [{ ok: true, value: 'one' }], 'how the ask ended')
        same(backend.asks.length, 1, 'times the backend was asked')
      }
    },
  },
  {
    name: 'a view goes on being shown after a drop, with nothing shown twice',
    play: (schedule, ends) => {
      const changes = { label: 'the view changes' }
      const backend = desk({ follow: (viewed) => { viewed.shown(0); for (const result of [1, 2]) schedule.later(changes, () => viewed.shown(result)) } })
      join(ends.b, backend.port)
      const view = watching(join(ends.a, desk().port), 'threads', 'count', {})
      dropsOnce(schedule, ends)
      return () => {
        same(view.shown, [0, 1, 2], 'what was shown')
        same(backend.views.length, 1, 'times the view was followed')
      }
    },
  },
  {
    name: 'tells cross each way once, in order, whenever the connection drops',
    play: (schedule, ends) => {
      const window = desk()
      const backend = desk()
      const toBackend = join(ends.a, window.port)
      const toWindow = join(ends.b, backend.port)
      toBackend.tell('x', 1)
      toWindow.tell('y', 1)
      schedule.does('the window', ['tells 2', () => toBackend.tell('x', 2)])
      schedule.does('the backend', ['tells 2', () => toWindow.tell('y', 2)])
      dropsOnce(schedule, ends)
      return () => {
        same(backend.told.map((told) => told.event), [1, 2], 'what the backend was told')
        same(window.told.map((told) => told.event), [1, 2], 'what the window was told')
      }
    },
  },
  {
    name: 'what the other end says it took is let go',
    play: (schedule, ends) => {
      const toWindow = join(ends.b, desk().port)
      // The window answers each tell with one of its own, and what it sends says what it took.
      let toBackend!: ReturnType<typeof join>
      toBackend = join(ends.a, desk({ tell: (_, event) => { toBackend.tell('x', `back ${String(event)}`) } }).port)
      toWindow.tell('y', 1)
      toWindow.tell('y', 2)
      dropsOnce(schedule, ends)
      return () => { same(ends.b.kept(), 0, 'what the backend keeps') }
    },
  },
  {
    name: 'a link that cannot be resumed ends, and every ask and view with it',
    play: (schedule, ends) => {
      const backend = desk()
      join(ends.b, backend.port)
      const toBackend = join(ends.a, desk().port)
      const made = asking(toBackend, 'threads', 'CREATE', 'one')
      const view = watching(toBackend, 'threads', 'count', {})
      const ended: Ending[] = []
      ends.a.onEnd((ending) => { ended.push(ending) })
      schedule.does('the backend', ['restarts', () => ends.restart()])
      return () => {
        same(ended, [{ why: 'lost' }], 'how the window\'s link ended')
        same(made.ended, [{ ok: false, failure: { kind: 'disconnected', message: 'The link closed' } }], 'how the ask ended')
        same(view.over, [{ kind: 'disconnected', message: 'The link closed' }], 'how the view ended')
      }
    },
  },
  {
    name: 'an end that says it is restarting is reached again, and found to be a new session',
    play: (schedule, ends) => {
      const ended: Ending[] = []
      ends.a.onEnd((ending) => { ended.push(ending) })
      schedule.does('the backend', ['says it is restarting', () => ends.b.close('restarting')], ['comes back new', () => ends.restart()])
      return () => {
        same(ended, [{ why: 'lost' }], 'how the window\'s link ended')
        holds(ends.connections >= 2, 'the window opened another connection')
      }
    },
  },
  {
    name: 'an end that says it has ended is not reached again',
    play: (schedule, ends) => {
      join(ends.b, desk().port)
      join(ends.a, desk().port)
      const ended: Ending[] = []
      ends.a.onEnd((ending) => { ended.push(ending) })
      schedule.does('the backend', ['says it has ended', () => ends.b.close('ended')])
      return () => {
        same(ended, [{ why: 'goodbye', bye: 'ended' }], 'how the window\'s link ended')
        same(ends.connections, 1, 'connections opened')
      }
    },
  },
]
