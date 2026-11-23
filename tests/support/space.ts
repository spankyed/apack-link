// Every state two ends of a link can reach, each looked at once: the core of each end is stepped by hand, what it
// asks for is done to a network that is only values, and whatever can happen next (a message arriving, a turn
// ending, a clock running out, a step of the script) is tried from every state not seen before. Each state is held
// to what a queue each way would have done, and to what an end holds adding up.
import { core, ready, setup, start, type Bye, type Effect, type Ending, type Event, type State } from '../../src/core.ts'
import type { Frame } from '../../src/frames.ts'
import type { Message } from '../../src/transport.ts'

/** One thing the script does. `b` is whoever listens now. */
export type Act =
  | { readonly does: 'send'; readonly by: 'a' | 'b' }
  | { readonly does: 'close'; readonly by: 'a' | 'b'; readonly bye?: Bye }
  /** The connection the first end is on goes, at both ends. */
  | { readonly does: 'drop' }
  /** The listener goes, and another with a session of its own listens in its place. */
  | { readonly does: 'restart' }

export interface Script {
  /** Each list is done in order, and between lists any order. */
  readonly lanes: ReadonlyArray<readonly Act[]>
  /** `opens`: the first end opens each connection and the second is handed it. `once`: each is on one connection alone. */
  readonly kind: 'opens' | 'once'
  /** How many of the first end's connections reach nobody before one does. */
  readonly unreachable?: number
  /** How long a connection may be quiet, for ends that watch one, and how many times in all a watch's clock runs out. */
  readonly window?: number
  readonly quiet?: number
  /** How many frames may be kept before nothing more is numbered. */
  readonly kept?: number
  /** Changes what a step asked for before it is done: for showing that an end that did otherwise would be found. */
  readonly spoil?: (effects: Effect[], session: string) => Effect[]
  /** More states than this is a script too wide to run whole. */
  readonly limit?: number
}

/** A message crossing, or that the end it came from closed. */
type Crossing = Message | null

interface End {
  readonly kind: 'once' | 'opens' | 'handed'
  readonly session: string
  readonly state: State
  /** The connections a turn is to end for, and what is on a clock. */
  turns: number[]
  timers: number[]
  ended?: Ending
  byes: Bye[]
  /** How many frames it has sent and been handed, and which end handed them. */
  out: number
  got: number
  from?: number
}
interface Wire { readonly ends: readonly [number, number]; readonly open: [boolean, boolean]; readonly crossing: [Crossing[], Crossing[]] }
interface World { readonly ends: End[]; readonly wires: Wire[]; readonly at: number[]; listener: number; opened: number; quiet: number }
/** What led to a state: the last thing that happened, and what led to that. */
interface Led { readonly what: string; readonly before?: Led }
const told = (led: Led | undefined): string => {
  const all: string[] = []
  for (let at = led; at; at = at.before) all.unshift(at.what)
  return all.join('\n    ')
}

const DEFECTS = ['out of order', 'not a frame', 'version', 'too narrow']

/** Runs a script from every state it can reach. Throws for the first state that does not hold, with what led to it. */
export function space(script: Script): { readonly states: number; readonly rests: number } {
  const steps = new Map<string, ReturnType<typeof core>>()
  const sets = new Map<string, ReturnType<typeof setup>>()
  const setOf = (end: End): ReturnType<typeof setup> => {
    let set = sets.get(end.session)
    if (!set) {
      set = setup({ kind: end.kind, session: end.session, ...(script.window === undefined ? {} : { window: script.window }), ...(script.kept === undefined ? {} : { bound: { kept: { frames: script.kept } } }) })
      sets.set(end.session, set)
      steps.set(end.session, core(set))
    }
    return set
  }
  const make = (world: World, kind: End['kind'], session: string): number => {
    world.ends.push({ kind, session, state: start(), turns: [], timers: [], byes: [], out: 0, got: 0 })
    setOf(world.ends.at(-1)!)
    return world.ends.length - 1
  }
  const fail = (what: string): never => { throw new Error(what) }

  /** A frame is handed over: it is the next one the end it is from sent, and each of the two talks to the other alone. */
  const handed = (world: World, to: number, frame: Frame): void => {
    const end = world.ends[to]!
    const [session, count] = String((frame as { event: unknown }).event).split(':')
    const by = world.ends.findIndex((other) => other.session === session)
    const sender = world.ends[by]
    if (end.ended) fail(`${end.session} was handed a frame after it ended`)
    if (!sender || by === to) fail(`${end.session} was handed a frame nobody else sent`)
    if ((end.from ?? by) !== by) fail(`${end.session} was handed frames by two ends`)
    if (sender!.from !== undefined && sender!.from !== to) fail(`${end.session} was handed a frame by an end that talks to another`)
    if (world.ends.some((other, at) => at !== to && other.from === by)) fail(`two ends were handed what ${session} sent`)
    if (Number(count) !== end.got + 1 || Number(count) > sender!.out) fail(`${end.session} was handed frame ${count} of ${session}'s, after ${end.got} of ${sender!.out} sent`)
    end.from = by
    end.got++
  }
  const ended = (world: World, at: number, ending: Ending): void => {
    const end = world.ends[at]!
    const others = world.ends.filter((other) => other !== end)
    if (end.ended) fail(`${end.session} ended twice`)
    if (DEFECTS.includes(ending.why)) fail(`${end.session} ended ${JSON.stringify(ending)}`)
    if (ending.why === 'lost' && !others.some((other) => other.ended)) fail(`${end.session} ended lost, with every end still there`)
    if (ending.why === 'goodbye' && !others.some((other) => other.byes.includes(ending.bye))) fail(`${end.session} ended with a goodbye nobody said`)
    end.ended = ending
  }

  const tell = (world: World, at: number, event: Event): void => {
    const end = world.ends[at]!
    const asked = steps.get(end.session)!(end.state, event)
    // Whatever is done with a frame handed over comes before anything else: nothing is asked for after it.
    if (asked.findIndex((effect) => effect.do === 'hand') !== asked.findLastIndex((effect) => effect.do === 'hand') || asked.slice(0, -1).some((effect) => effect.do === 'hand')) fail(`${end.session} was to be handed a frame before the last thing a step asked for`)
    for (const effect of script.spoil ? script.spoil(asked, end.session) : asked) perform(world, at, effect)
  }
  /** An end closes its side of a connection: it hears so at once, and the other after what was sent before. */
  const shut = (world: World, at: number, on: number): void => {
    const wire = world.wires[on]!
    const side = wire.ends.indexOf(at) as 0 | 1
    if (!wire.open[side]) return
    wire.open[side] = false
    wire.crossing[side].push(null)
    tell(world, at, { is: 'closed', on })
  }
  const write = (world: World, at: number, on: number, messages: readonly Message[]): void => {
    const wire = world.wires[on]!
    const side = wire.ends.indexOf(at) as 0 | 1
    if (wire.open[side]) wire.crossing[side].push(...messages)
  }
  /** Who a connection opened now reaches: the listener, or a new one where that has ended by itself. */
  const listening = (world: World): number => {
    const now = world.ends[world.listener]!
    return now.ended ? make(world, 'handed', `b${world.ends.length}`) : world.listener
  }
  const open = (world: World, at: number): void => {
    world.opened++
    const on = world.wires.length
    if (world.opened <= (script.unreachable ?? 0)) {
      // Nobody is there: it closes with nothing having crossed.
      world.wires.push({ ends: [at, -1], open: [true, false], crossing: [[], [null]] })
      tell(world, at, { is: 'carry', on })
      return
    }
    const to = listening(world)
    world.wires.push({ ends: [at, to], open: [true, true], crossing: [[], []] })
    tell(world, to, { is: 'carry', on })
    tell(world, at, { is: 'carry', on })
  }
  const perform = (world: World, at: number, effect: Effect): void => {
    const end = world.ends[at]!
    switch (effect.do) {
      case 'write': write(world, at, effect.on, effect.messages); return
      case 'close': shut(world, at, effect.on); return
      case 'away':
        if (effect.message !== undefined) write(world, at, effect.on, [effect.message])
        shut(world, at, effect.on)
        return
      case 'later': end.turns.push(effect.on); return
      case 'after': end.timers.push(effect.timer); return
      case 'off': end.timers = end.timers.filter((timer) => timer !== effect.timer); return
      case 'open': open(world, at); return
      case 'hand': handed(world, at, effect.frame); return
      case 'traffic': return
      case 'ended': ended(world, at, effect.ending)
    }
  }

  /** What an end holds adds up, whatever led to it. */
  const sound = (end: End): void => {
    const { state } = end
    if (state.ending) return
    if (state.kept.some((one, at) => one.seq !== state.released + 1 + at) || state.released + state.kept.length !== state.sent) fail(`${end.session} keeps ${state.kept.map((one) => one.seq).join(',')}, having sent ${state.sent} and let go up to ${state.released}`)
    if (state.keptSize !== state.kept.reduce((sum, one) => sum + one.size, 0)) fail(`${end.session} counts ${state.keptSize} bytes kept, and keeps another number`)
    if (state.waitingSize !== state.waiting.reduce((sum, one) => sum + one.size, 0)) fail(`${end.session} counts ${state.waitingSize} bytes waiting, and has another number wait`)
    if (state.now && state.now.told > state.heard) fail(`${end.session} said it took ${state.now.told}, having taken ${state.heard}`)
    if (state.taking.length) fail(`${end.session} is left taking a message`)
  }

  /** Everything that can happen next, each as what it is called and what it does to a world. */
  const next = (world: World): Array<readonly [string, (world: World) => void]> => {
    const can: Array<readonly [string, (world: World) => void]> = []
    world.wires.forEach((wire, on) => {
      for (const side of [0, 1] as const) {
        if (!wire.crossing[side].length) continue
        const to = wire.ends[1 - side]!
        can.push([`${world.ends[wire.ends[side]!]?.session ?? 'nobody'} to ${world.ends[to]?.session ?? 'nobody'} on ${on}`, (w) => {
          const here = w.wires[on]!
          const crossing = here.crossing[side].shift()!
          if (!here.open[1 - side]) return
          if (crossing === null) {
            here.open[1 - side] = false
            tell(w, to, { is: 'closed', on })
            return
          }
          const end = w.ends[to]!
          tell(w, to, { is: 'data', on, message: crossing, backlog: 0 })
          while (end.state.taking.length) tell(w, to, { is: 'more', backlog: 0 })
        }])
      }
    })
    world.ends.forEach((end, at) => {
      for (const on of new Set(end.turns)) {
        can.push([`${end.session}'s turn ends on ${on}`, (w) => {
          const mine = w.ends[at]!
          mine.turns.splice(mine.turns.indexOf(on), 1)
          tell(w, at, { is: 'turn', on })
        }])
      }
      for (const timer of end.timers) {
        const what = timer === end.state.reopening ? 'opens again' : timer === end.state.holding ? 'has held' : 'has been quiet'
        // A clock that ran out on a quiet connection for ever would be a script with no end.
        if (what === 'has been quiet' && !world.quiet) continue
        can.push([`${end.session} ${what}`, (w) => {
          if (what === 'has been quiet') w.quiet--
          const mine = w.ends[at]!
          mine.timers = mine.timers.filter((one) => one !== timer)
          tell(w, at, { is: 'due', timer })
        }])
      }
    })
    script.lanes.forEach((lane, which) => {
      const act = lane[world.at[which]!]
      if (!act) return
      can.push([`the script: ${JSON.stringify(act)}`, (w) => {
        w.at[which]!++
        if (act.does === 'drop') {
          const wire = w.wires.findLast((one) => one.open[0])
          if (!wire) return
          const on = w.wires.indexOf(wire)
          for (const side of [0, 1] as const) {
            if (!wire.open[side]) continue
            wire.open[side] = false
            tell(w, wire.ends[side]!, { is: 'closed', on })
          }
          return
        }
        if (act.does === 'restart') {
          tell(w, w.listener, { is: 'close' })
          w.listener = make(w, 'handed', `b${w.ends.length}`)
          return
        }
        const at = act.by === 'a' ? 0 : w.listener
        const end = w.ends[at]!
        if (act.does === 'close') {
          if (act.bye && !end.ended) end.byes.push(act.bye)
          tell(w, at, { is: 'close', ...(act.bye ? { bye: act.bye } : {}) })
          return
        }
        if (end.ended) return
        end.out++
        tell(w, at, { is: 'send', one: ready(setOf(end), { kind: 'tell', to: 'x', event: `${end.session}:${end.out}` }, {}), backlog: 0 })
      }])
    })
    return can
  }

  /** At rest, two ends still there and on a connection to each other have each been handed all the other sent. */
  const rest = (world: World): void => {
    const a = world.ends[0]!
    if (a.ended) return
    const on = a.state.now?.id
    const other = on === undefined ? undefined : world.ends[world.wires[on]!.ends[a.kind === 'once' ? 1 : 1]!]
    if (a.kind !== 'once' && on === undefined) fail('at rest, the end that opens its connections is on none')
    if (!other || other.ended) return
    if (a.got !== other.out) fail(`at rest, ${a.session} has been handed ${a.got} of the ${other.out} that ${other.session} sent`)
    if (other.got !== a.out) fail(`at rest, ${other.session} has been handed ${other.got} of the ${a.out} that ${a.session} sent`)
  }

  /** A world as text, the same for any two that go on the same way: a clock's numbers are only names. */
  const key = (world: World): string => JSON.stringify(world, function (this: unknown, name, value: unknown) {
    if (value instanceof Map) return [...value]
    if (value === Infinity) return 'any'
    if (name === 'timers' && typeof value === 'number') return undefined
    return value
  }, 0).replace(/"(reopening|holding|timer)":\d+/g, '"$1":0').replace(/"timers":\[[\d,]*\]/g, (list) => `"timers":${list.split(',').length}`)

  const first: World = { ends: [], wires: [], at: script.lanes.map(() => 0), listener: 1, opened: 0, quiet: script.quiet ?? 0 }
  if (script.kind === 'once') {
    make(first, 'once', 'a')
    make(first, 'once', 'b')
    first.wires.push({ ends: [0, 1], open: [true, true], crossing: [[], []] })
    tell(first, 0, { is: 'carry', on: 0 })
    tell(first, 1, { is: 'carry', on: 0 })
  } else {
    make(first, 'opens', 'a')
    make(first, 'handed', 'b')
    open(first, 0)
  }
  const seen = new Set<string>([key(first)])
  const todo: Array<{ world: World; led?: Led }> = [{ world: first }]
  const limit = script.limit ?? 200_000
  let rests = 0
  while (todo.length) {
    const { world, led } = todo.pop()!
    const can = next(world)
    try {
      for (const end of world.ends) sound(end)
      if (!can.length) { rests++; rest(world) }
    } catch (error) { throw new Error(`${(error as Error).message}\n  after:\n    ${told(led)}`) }
    for (const [what, does] of can) {
      const after = structuredClone(world)
      const now: Led = { what, ...(led ? { before: led } : {}) }
      try { does(after) } catch (error) { throw new Error(`${(error as Error).message}\n  after:\n    ${told(now)}`) }
      const as = key(after)
      if (seen.has(as)) continue
      seen.add(as)
      if (seen.size > limit) throw new Error(`More than ${limit} states: too many to look at them all`)
      todo.push({ world: after, led: now })
    }
  }
  return { states: seen.size, rests }
}
