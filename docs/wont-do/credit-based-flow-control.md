# Credit-based flow control

Status: won't do, 2026-11-23. This records what it is, why a link does not have it, and what would have to become
true for that to be looked at again. It is left out of [the plan](../plan.md) on purpose.

## What it is

The receiving end tells the sending end how many bytes it may send, and the sender stops when that allowance is
spent until the receiver grants more. HTTP/2 and QUIC work this way (a window the receiver updates), and MQTT 5's
Receive Maximum is the same idea counted in messages. It exists so that a fast sender cannot fill the memory of a
slow receiver, between ends that do not trust each other or among many streams sharing one connection.

In a link it would take the place of three things in [the design](../design.md): the mark past which a link stops
numbering (`bound.kept`), a transport saying how much it has not written (`waiting()`), and the ending
`{ why: 'overrun' }`.

## Why a link does not have it

- **What it guards against does not happen between a window and its backend.** They are one app on one machine,
  carrying one stream. Neither end is a stranger, and no stream competes with another for the connection.
- **What can pile up is already bounded by what is sent.** A view's result waiting behind an earlier one for the
  same view takes its place, so a window that has fallen behind is owed one result for each view however many
  times the view changed. Asks, answers and what a step says are few, and are made by a person's actions.
- **A sender already holds itself to what the other end has taken.** How far behind the other end is, is what it
  has not said it took, and past the mark a link stops numbering. That is a bound the sender keeps from what it
  knows. A credit is the same bound set by the receiver, which adds a message, and a state on each end, to learn
  a number both ends could be configured with.
- **The case that is left has an ending that costs little.** A link that passes the bound on what waits ends
  `overrun`. A window whose link ended starts again and follows its views, which send what is the case now. Nothing
  is lost that a view does not show.
- **It is where implementations of it go wrong.** A sender waiting for credit and a receiver waiting for data
  before it grants any is a deadlock, and a grant that is lost is the same one. Each needs its own rule and its
  own orderings checked, for a guard this link has no use for.

## What would change this

- **A backend reached over a real network**, where a connection slower than the sender is ordinary and ending the
  link for it would end it often.
- **Something sent in volume that cannot take another's place**: a terminal's output or a model's stream of
  tokens carried on a link. A view's results can be overtaken; these cannot, and a slow window would be owed all
  of them. A terminal's rows reach a window from the broker today and not over a link.

The second is the likelier. If either becomes true, this is designed then, against that traffic.
