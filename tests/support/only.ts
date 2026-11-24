import type { Accepting, Transport } from '../../src/index.ts'

/** A backend all of whose connections are one owner's: what takes each of them. */
export const only = (taking: Accepting<string>) => (transport: Transport): void => { taking.take(transport, 'the window') }
