# Views that never pass through the server's JavaScript

Status: deferred, 2026-11-22. Not designed. This records what it is, why it is worth having, what it would take,
and what would make it worth starting. It is left out of [the plan](../plan.md) on purpose.

## Where it stands

A view is a function a pack writes: it reads the database and returns a result. The backend runs it again after
each commit that wrote into what it read, and sends a window the result when it differs from the last.

On the way a view's result changes form three times. It leaves elmdb as msgpack bytes. The server's JavaScript
decodes those into objects, and the view's function builds its result from them. That result is compared with the
last one, put into text, and written to the socket. The window parses the text.

So each change to a view costs the server's one thread a decode, a run of the function, a deep comparison and an
encode, of the **whole** result, however little of it changed.

## What it would be

A view elmdb keeps current itself, from what each commit changed, and sends as what changed.

- **The view is a query, not a function.** elmdb can keep a query's answer current from a commit's change set. It
  cannot do that for a function it has to run to learn what it reads.
- **What crosses is the difference**: the rows that entered, left or changed place, not the result again.
- **It crosses as elmdb wrote it.** The bytes go from the engine to what carries the link, and the server's
  JavaScript does not hold the result at any point.

A link would carry it as it carries `shown` today, in the same stream and the same order, which is why it is this
repository's to plan for and not only elmdb's. What a step sends a window would still wait for it
([the plan](../plan.md), step 2).

## What it would take

- **elmdb: incremental views.** Designed in elmdb's `docs/roadmap/incremental-views.md`, and held there until a
  view's re-run is measured to cost: every apack view measured runs in well under a millisecond a commit.
- **A way for a pack to write a view as a query**, for the views that can be one, beside the function form for
  those that cannot.
- **A frame for a difference**, beside `shown`, and what a window does with one: apply it to the result it holds.
- **Something that writes a link's bytes without JavaScript in between.** That is the engine, or a process beside
  it, holding the socket, with the frames the backend's JavaScript sends put in order with the engine's. Order
  across the two is the whole difficulty: it is a link's first rule, and here two writers share one stream.
- **A codec both ends share with elmdb** (the plan's step 9 is the first half).

## What the host's carrier and ownership mean for this

- **Subscriptions end with the link, not only with its owner.** An engine-kept view is state held for one session.
  Bind its teardown to `link.onEnd`, never directly to `gone(owner)`: a window reload keeps the same owner while
  `accept()` ends the old link and starts a new one, and `gone(owner)` guarantees `link.onEnd` eventually fires when
  a window closes and stops coming back.
- **Rust can write to a socket, not to a `MessagePort`.** Writing link bytes without JavaScript in between requires
  an OS socket or pipe that the engine (or a sidecar) can hold — a Unix domain socket, named pipe or TCP socket. An
  Electron `MessagePort` (the primary carrier for desktop windows in the app's
  `docs/plans/deferred/what-a-window-reaches-its-backend-over.md`) is a Chromium/V8 object that Rust cannot write to
  directly without crossing Node's JavaScript. Choosing `MessagePort` for windows today does not permanently close
  this off — a link's carrier is a swappable `Transport`, and Electron's preload can open a local socket directly —
  but starting this work later means moving windows onto a local socket and moving admission beside whoever holds
  that socket. Keeping `owner` as a plain local id that never crosses the wire keeps that move cheap.

## What would make it worth starting

- A reading, in apack, of a view whose re-run and re-send costs enough to be felt: a list of thousands of rows
  that changes a row at a time is the case.
- Or a window that is not on this machine, where sending a whole result for each change costs a network what it
  costs nothing here.

Without one, a view's result is small, changes seldom, and crosses a socket on one machine. The plan's step 6
already lets go of a result that was overtaken before it left.

## Who has done it

Convex keeps a query's result current and sends a client what changed. Zero and ElectricSQL sync the rows a query
covers and answer it on the client. Materialize maintains views incrementally from a change stream. Each started
from queries the system could analyse, which is the first item above and the reason this waits.
