# Causal delivery in place of the hold

Status: won't do, 2026-11-23. This records what it is, why a link keeps the hold, and what would have to become
true for that to be looked at again. It is left out of [the plan](../plan.md) on purpose.

## What it is

Today a window hears of a step after its views show what the step kept, and the sending end sees to it: a peer
holds what a step says to a window until that window's views have been sent what the step kept
([the design](../design.md)). That is the hold, and it rests on one ordered stream.

Causal delivery moves the wait to the receiving end. Each view's result and each thing a step says carries the
number of the commit it comes from. A window that is handed something from commit N keeps it until every view it
follows has shown N, and then delivers it. Nothing needs to arrive in one order, so a view's results and a step's
answers could travel apart.

## Why a link keeps the hold

- **It does not remove the wait, or the work of knowing when it is over.** A view that commit N did not write
  into has nothing new to send, so a window waiting for it to show N would wait for ever. The backend has to say
  that a window's views are at N, and it can say so only when each view the commit did write into has run again.
  That is what the hold waits for now. The wait is the same length, on the other end.
- **The wait is short.** Waiting on the views a step wrote into, with the store asked to run them soon, measured
  about 2 ms where it had been 17 (elmdb's `caughtUp({ soon: true })`, 2026-11-22, forty writes against twelve
  views over ten rows).
- **What one ordered stream costs is small on one machine.** A large result ahead of an unrelated answer delays
  the answer by the time it takes to cross, between two processes of one app.
- **It adds a way to wait for ever.** A window keeping an answer until it is told its views are at N has nothing
  to deliver if that word is lost or never sent. The hold cannot fail that way: what is held is on the end that
  knows.
- **It is a change in three repositories**: the store stamping what a view delivers and saying where each view
  stands, the state kernel stamping what a step says, and a link carrying both and keeping what waits.

## What would change this

- **A window that should see all of its views move together**, each at the same commit, so that two views never
  disagree for a moment. Then the commit a result comes from has to cross anyway, and delivering by it follows.
  It is not wanted now: views that are due run in one pass over the same data, only a costly one lags, and what
  has to agree is read by one view. It would also have the slowest view hold back the rest.
- **More than one stream to a window**, where there is no one order to rest the hold on.
