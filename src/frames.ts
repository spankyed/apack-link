// What crosses a link. One frame is one thing a system says to the other, and these are all there are: a link
// carries what states say to each other and nothing else, which is what lets it keep them in order.

/** A number one end chose, which names an ask or a view for as long as it lasts. Each end numbers its own. */
export type Id = number

export type Frame =
  /** Something happened. Nobody waits. */
  | { readonly kind: 'tell'; readonly to: string; readonly event: unknown }
  /** A question, answered once: by `answer`, however it ends. */
  | { readonly kind: 'ask'; readonly id: Id; readonly to: string; readonly name: string; readonly args: unknown }
  /** Whoever asked has gone: what was being done for them can stop. */
  | { readonly kind: 'left'; readonly id: Id }
  /** What the one answering says before it answers. */
  | { readonly kind: 'progress'; readonly id: Id; readonly update: unknown }
  /** How an ask ended. Nothing with its id follows. */
  | { readonly kind: 'answer'; readonly id: Id; readonly outcome: unknown }
  /** Follow a view: its result, and each changed result after it, until `unfollow`. */
  | { readonly kind: 'follow'; readonly id: Id; readonly feature: string; readonly view: string; readonly args: unknown }
  /** What a followed view shows now. */
  | { readonly kind: 'shown'; readonly id: Id; readonly update: unknown }
  /** The follower lets a view go. */
  | { readonly kind: 'unfollow'; readonly id: Id }
  /** The one running a view says it has ended, and why. Nothing more is shown for its id. */
  | { readonly kind: 'over'; readonly id: Id; readonly failure: Failure }

/** Why an ask failed or a view ended: a kind to act on and a message to read. */
export interface Failure { readonly kind: string; readonly message: string }

/** A frame as it is on the wire: with its place in everything this end has sent. */
export interface Sent {
  /** One more than the frame before it from this end, from 1. */
  readonly seq: number
  readonly frame: Frame
}
