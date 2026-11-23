# The wire

Everything one end of a link sends the other, written down once, so that a test client, a tool or an agent that
reaches a backend need not work it out again from the source. `tests/wire.spec.ts` holds the package to the
recording at the end: a change to any text an end sends fails it until this file says the same.

What follows is in JSON, the codec built in. A link handed another codec sends the same values encoded in it; a
part's `data` is then bytes of that encoding instead of text.

## Messages

Each message on the transport is a **batch**: a list, never empty, of things one end says, in the order it said
them. An end says what it has to say in a turn as one batch, and sends one sooner once it is as long as a part.
Where that batch would be longer than what carries it takes, or than the `most` the other end's hello named, it
crosses as more than one message: the fewest that fit, cut between the things said, in the order they were
said, each a batch of its own. A hello is still first in the first of them and a goodbye last in the last, and
whoever reads the wire takes them one after another as if they were one. Each thing in a batch is one of these:

| Said | What it is |
|---|---|
| `{"link":1,"session":S,"taken":N}` | **Hello**, first on every connection, from each end. `link` is which link this is (1); `session` names this end for as long as it lives; `taken` is the last number it took from the other end. |
| `"resumes":R` on a hello | The other end's session, from an end that has met it: it is going on with that session. Absent, this end has met nobody, and its `taken` is 0. |
| `"most":M` on a hello | The longest message, in bytes, this end takes on this connection. Absent, any. The other end cuts its batches to fit. |
| `{"seq":N,"frame":F}` | **A frame**, numbered: `seq` is one more than the last number this end sent, from 1. `F` is one of the nine frames below. |
| `{"seq":N,"part":I,"of":K,"data":D}` | **A part** of a frame too long for one: the frame's encoded text cut into `K` pieces (2 or more), sent in turn, each with a number of its own. `D` is piece `I`, from 0. Nothing else is numbered between the parts of one frame. |
| `"cause":C` on a frame or a first part | What caused it: a short text the kernel makes, passed on and never read. |
| `"private":true` on a frame or a first part | A tap at either end is told only that it crossed, its number and its size. |
| `{"taken":N}` | The last number this end took. What the other end kept for it up to there it may let go. |
| `{"there":N}` | Whether the other end is there: asked on a connection quiet for half its window while this end is owed something. |
| `{"here":N}` | That it is, with the number asked. |
| `{"bye":"ended"}` or `{"bye":"restarting"}` | **Goodbye**, last: this end is going, for good or to be reached again. |
| `{"lost":true}` | The session cannot be picked up again. Said after a hello: by a backend handed a hello that resumes a session it does not know, and by an end met with a hello that does not fit (below). |

None but a frame or a part takes a number.

## Frames

What states say to each other, and nothing else. An `id` is a number the end that made the ask or the view
chose; each end numbers its own asks and its own views from 1, and uses each once in a link's life.

| Frame | Sent by | |
|---|---|---|
| `{"kind":"tell","to":T,"event":E}` | either | Something happened. Nobody waits. |
| `{"kind":"ask","id":I,"to":T,"name":N,"args":A}` | the asker | A question, answered once. |
| `{"kind":"progress","id":I,"update":U}` | the one answering | What it says before it answers. |
| `{"kind":"answer","id":I,"outcome":O}` | the one answering | How the ask ended. `O` is `{"ok":true,"value":V}` or `{"ok":false,"failure":{"kind":K,"message":M}}`. Nothing with its id follows. |
| `{"kind":"left","id":I}` | the asker | Whoever asked has gone: what is being done for them can stop. |
| `{"kind":"follow","id":I,"feature":F,"view":V,"args":A}` | the follower | Follow a view: its result, and each changed result after it. |
| `{"kind":"shown","id":I,"update":U}` | the one running it | What the view shows now. |
| `{"kind":"unfollow","id":I}` | the follower | Let the view go. |
| `{"kind":"over","id":I,"failure":{"kind":K,"message":M}}` | the one running it | The view has ended, and why. Nothing more is shown for its id. |

## What an end holds the other to

- The first thing on a connection is a hello. Until it has come nothing else is taken, and an end that can come
  back numbers nothing.
- A hello naming another `link` ends the link `version`. A hello does not fit, and the session is `lost`, when it
  names another session than the one this link talks to, resumes a session that is not this end's, says it took
  something without having met anybody, or says a `taken` past what was sent or before what it said last. One
  whose `most` is shorter than a frame this end may send, with what goes around it, is `too narrow`.
- An end handed its connections, a backend's, turns away a connection whose first word does not fit, and goes on.
  Only the end that opened a connection ends for what it met there. An end already met on one connection keeps it
  until a hello that fits arrives on a new one.
- The end that opened a connection says its hello first on it. An end that is on a connection where the other
  has been met says nothing on a new one, its own hello included, until a hello that fits has arrived there:
  then it closes the old one and says its hello on the new, with what it had taken by then. On a connection it
  is handed while it is on none, or on one where nobody has been met, an end says its hello at once. So a client
  written to this must not wait for a backend's hello before sending its own.
- Each numbered thing is one more than the one before it from that end; one that is not ends the link
  `out of order`. A resume sends again everything after the `taken` the other end's hello names, and a frame in
  parts picks up at the part it got to.
- Anything else, or a batch that is not a list, ends the link `not a frame`. What it carried is not kept: only its
  length.

## A recorded exchange

A window's end (A) and a backend's (B, behind `accept`), with a part 120 long, and frames of 2 KiB at most. A
is carried on something that takes no message longer than 4 KiB, and says so. A tells something it says a click
caused, asks, and follows a view privately; B says something of the ask, shows the view and answers. A asks and
leaves, follows a view B does not have and lets the first go; B ends the missing one. A sends a frame too long for
one part, which a paste caused. Owed an answer on a quiet connection, A asks whether B is there. The connection
goes in the same turn as A says something: A opens another, each end says where it took the other to and whose
session it resumes, and what A said goes on the new one. A says goodbye. Last, a backend that began after a
session started is handed a hello that resumes it.

Sessions are random; here they are named in the order they appear.

<!-- recording -->
```text
A → B  [{"link":1,"session":"session-1","taken":0,"most":4096}]
B → A  [{"link":1,"session":"session-2","taken":0}]
A → B  [{"seq":1,"frame":{"kind":"tell","to":"threads","event":{"clicked":"new"}},"cause":"click"},{"seq":2,"frame":{"kind":"ask","id":1,"to":"threads","name":"CREATE","args":{"topic":"one"}}}]
A → B  [{"seq":3,"frame":{"kind":"follow","id":1,"feature":"threads","view":"list","args":null},"private":true}]
B → A  [{"taken":3}]
B → A  [{"seq":1,"frame":{"kind":"progress","id":1,"update":"half"}},{"seq":2,"frame":{"kind":"shown","id":1,"update":[]}},{"seq":3,"frame":{"kind":"answer","id":1,"outcome":{"ok":true,"value":{"id":"THR-1"}}}}]
A → B  [{"taken":3}]
A → B  [{"seq":4,"frame":{"kind":"ask","id":2,"to":"threads","name":"WAIT","args":null}},{"seq":5,"frame":{"kind":"left","id":2}}]
A → B  [{"seq":6,"frame":{"kind":"follow","id":2,"feature":"threads","view":"missing","args":null}},{"seq":7,"frame":{"kind":"unfollow","id":1}}]
B → A  [{"taken":7}]
B → A  [{"seq":4,"frame":{"kind":"over","id":2,"failure":{"kind":"gone","message":"No such view"}}}]
A → B  [{"taken":4}]
A → B  [{"seq":8,"part":0,"of":2,"data":"{\"kind\":\"tell\",\"to\":\"threads\",\"event\":\"a long event, longer than the hundred and twenty characters a part may be here, a","cause":"paste"}]
A → B  [{"seq":9,"part":1,"of":2,"data":"nd so cut into two\"}"}]
B → A  [{"taken":8}]
B → A  [{"taken":9}]
A → B  [{"there":1}]
B → A  [{"here":1}]
A → B  [{"link":1,"session":"session-1","taken":4,"resumes":"session-2","most":4096}]
B → A  [{"link":1,"session":"session-2","taken":9,"resumes":"session-1"}]
A → B  [{"seq":10,"frame":{"kind":"tell","to":"threads","event":"said as it closed"}}]
B → A  [{"taken":10}]
A → B  [{"seq":11,"frame":{"kind":"tell","to":"threads","event":"after"}}]
B → A  [{"taken":11}]
A → B  [{"bye":"ended"}]
A → B  [{"link":1,"session":"session-3","taken":0,"resumes":"session-4"}]
B → A  [{"link":1,"session":"session-5","taken":0},{"lost":true}]
```
