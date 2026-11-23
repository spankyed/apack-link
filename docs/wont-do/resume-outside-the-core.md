# Resume outside the core

Status: won't do, 2026-11-23. This records what it is, why resume stays in a link's core, and what would have to
become true for that to be looked at again. It is left out of [the plan](../plan.md) on purpose.

## What it is

A link numbers each frame, keeps what the other end has not said it took, and on a new connection sends that
again in order. That is resume, and it is part of the core every link runs.

The proposal splits it off. The core becomes ordered frames on a channel that works or ends, and a drop ends the
link. Resume becomes a wrapper around that: it keeps whole messages, numbers them itself, and puts a new core
under itself when a connection drops. A link over a message port, which cannot drop while both processes live,
would then be the small core alone.

## Why resume stays in the core

- **It costs nothing to keep.** Resume as it is adds a kept buffer and the acknowledgements. Moving it saves
  neither time nor bytes worth measuring on one machine.
- **The hard part would be run the least.** Every spec and every explored ordering goes through resume now. As
  a wrapper it is skipped by every link that does not drop, so the code that faces an unreliable network becomes
  the code least exercised. A window on another machine ([deferred](../deferred/remote-windows.md)) is the case
  resume is for, and it is likely enough to keep resume where it is best held.
- **The seam is where a resume goes wrong.** Resume has to agree with the order, the acknowledgements and the
  bound on exactly what the other end took. In one core that is one count. Across two layers a disagreement is a
  message sent twice or not at all after a reconnect.
- **Two numberings.** A wrapper that numbers whole messages over a core that numbers frames keeps two counts of
  one stream.
- **The acknowledgements are not only resume's.** They are also how a link knows the other end is behind, which
  bounds what it numbers, and what a quiet connection is watched by. Those stay whatever is done with resume, so
  the core that is left is not as small as it looks.
- **It is the most proven part.** Most of the specs and nearly every defect fixed are about resume. Moving it
  proves all of that again against a new boundary, with a change to the wire and a new pin in what installs it.
- **If every link resumes, only code has moved.** A window that dials a socket and a backend that listens is the
  resuming path. The wrapper would always be on.

## What is done instead

Nothing now. If a link that never resumes is wanted, it is an option of the one core and not a second layer: no
kept buffer and nothing to go on with, so a drop ends the link. That keeps one numbering and changes nothing on
the wire.

## What would change this

- **Every link in the app on a channel that cannot drop**, and no window on another machine wanted. Then resume
  is code nothing runs, and the smaller core is worth having for itself.
- **A second kind of resume** that the first cannot be bent to: one kept on disk, or one across more than one
  backend. Then resume is a choice among several, and a choice belongs outside the core.
