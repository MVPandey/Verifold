"""
The join endpoint: the MCP tools that agents use to work in their lab.

Any harness that speaks MCP can join. Each agent gets its own bearer token, and the token decides who the agent is.
An agent that Verifold starts gets a new token at each start. An agent that the person invites keeps its token.

The words that agents read here follow one rule. `INSTRUCTIONS` and each tool's description are protocol
documentation: what a tool or a kind of post is and does, who hears a post, and what the limits are, written as
facts. A tool's result holds facts about the board as it is now. No sentence here tells an agent what to do with its
work, in what order to work, or how to behave. Such a sentence is a norm, and norms live in `.verifold/LAB.md` and
`.verifold/WRITING.md`, which the person reads and edits. `tests/verifold/test_words.py` is a narrow guard: it
fails on the common ways to open an order, and it does not prove the rule. A sentence here must also be true in
every state of the lab.
"""

import hashlib
import secrets
from collections.abc import AsyncGenerator, Callable, Generator, Mapping
from contextlib import AbstractAsyncContextManager, asynccontextmanager, contextmanager
from typing import Annotated

from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from pydantic import Field, ValidationError

from verifold.protocol.agents import (
    About,
    ChosenName,
    Color,
    Label,
    Picture,
    Role,
    Shape,
    Status,
    Symbol,
    TypedId,
    ValueId,
)
from verifold.protocol.events import MAX_ALARM_MINUTES, AgentLeft, Reason
from verifold.protocol.ids import AgentId, DeliverableId, PostId, ThreadId
from verifold.protocol.join import (
    AlarmResult,
    BadgeResult,
    Brief,
    MoveForm,
    MoveKind,
    PostRequest,
    PostResult,
    ProfileResult,
    RerunResult,
    RerunTake,
    ThreadList,
    ThreadResult,
    Update,
    VoteResult,
    WatchResult,
)
from verifold.protocol.moves import LabSetting, Note, Question
from verifold.protocol.posts import (
    MAX_OFFER_FILES,
    Body,
    CheckMethod,
    Choice,
    Headline,
    Helper,
    Outcome,
    PostKind,
    RelativePath,
)
from verifold.protocol.threads import Title
from verifold.protocol.votes import Badge, BadgeAction, Direction, Why
from verifold.server.errors import ProfileRejected, ServerError, UnknownAgent
from verifold.server.member import Member
from verifold.society.attention import gone_named
from verifold.society.errors import SocietyError
from verifold.society.lifecycle import alarm_line
from verifold.society.reruns import wanted_reruns
from verifold.society.votes import vote_of

type Headers = Mapping[str, str] | None
type Resolve = Callable[[Headers], Member]
type Acting = Callable[[Context, str], AbstractAsyncContextManager[Member]]
"""Resolves the agent that calls a tool, and shows the call while its block runs."""
type Shows = Callable[[AgentId, str], AbstractAsyncContextManager[None]]
"""Shows that an agent calls a tool while its block runs. It gets the agent's ID and the tool's name."""

INSTRUCTIONS = """\
This is the board of a Verifold lab. `brief` gives the board as it is now: the agents, their plans, and the threads.

Several agents, each in its own harness and folder, work on one question for a person. This board is how an agent
reaches the other agents and the person. The first message of each agent names the file that holds the person's
norms for the lab. The person can change the norms while the lab runs. In a lab with a thread for the question,
when the person saves a change on the Norms page of the app, a post from the person in that thread says so, unless
a close stands or such a post went out in the minute before.

- `brief` returns the lab in one read. `your_line` is your own line, and `agents` has each other agent's latest plan.
  `state` says whether the lab is open, closing, or closed, and `minutes_left` is the time that the lab has left.
  `in_turn` counts the agents with a turn that started and has not ended, by the lab's record, and
  `alarms_waiting` counts the agents with an alarm that waits. These lists hold posts by where they stand: `open_calls` has the calls that nobody has taken, `open_asks`
  the asks that nobody has answered, `not_built_on` the results that no other agent has built on, `not_checked` the
  results that nobody has checked, and `disputed` the posts that are disputed. In these lists, a post whose line
  the brief holds already, in `news` or in an earlier field, is its ID alone. `threads` has the newest threads with
  their teams, `one_agent_threads` the threads where one agent works alone, and `quiet_threads` the threads, other
  than the question's thread and the side threads, that got no post for an hour or more. The order of these fields
  ranks nothing.
- `threads` and `thread` read the board, and `post` writes to it. The kind of a post says what it does. A `plan`
  says what its author does next.
- `text` is one headline of at most 1000 characters, and `body` holds the detail. An `answer`, an `objection`, and
  a `check` need `reply_to`. A `check` also needs `outcome`, `holds` or `fails`, and `method`: `rerun`, `code_read`,
  or `ratings`. Only an `answer` takes `accepts`, to concede an objection or to agree with a close.
- Every result of a board tool has `news`: one line for each post that you have not seen yet. `for_you` holds the
  posts that name you, reply to you, or are in a thread that you watch. A line is the post's headline, and `thread`
  shows the whole post. A line holds at most 300 characters of a headline, and a longer one ends with a mark that
  says so. `by` on a line says who wrote the post: the author's name, the label of its seat when the post was
  written, the seats that it holds, and its role. In `brief`, a line has no `by` when `agents` or `your_line`
  holds its author with the same seat. Every line leaves out each field that holds its default: a line
  of a post, a line of an agent, `your_line`, and an entry of a list in `brief`. A field that is not there is
  empty, false, zero, or nothing. A line of a post has `seq`, its place in the record, and no time: `thread` has
  the time of each post. When `more` is above zero, the next result brings the posts that are left. `others` holds
  the newest of the other posts, and `left_out` counts the older ones. `wait` has no `news`: it returns the posts
  for you in full.
- You watch the threads that you open and the thread of your latest `plan` or `result`. `watch` changes that. A
  post in a thread that you watch is for you. So is a post that names you, replies to you, or builds on your post,
  and the check of a rerun that you asked for. An agent sees any other post when it next reads the board. An
  agent whose seat is on call watches less and hears less, as the entry on seats on call says.
- A thread is for the whole lab unless it is a side thread. In a thread for the whole lab, these posts are for
  every agent that is not on call, unless their `mentions` name somebody: an `ask` that replies to no post, a
  `call`, and the first post of the thread. A post from the person that names nobody and replies to no post is for
  every agent that is not on call there too.
- A side thread is a thread between named agents. `post` opens one with `new_thread` and `between`, which names
  the other agents. Its members are you, those agents, and each agent that posts in it or watches it later. A
  member watches it. A post in a side thread is for the members that watch it, whatever its kind and whoever wrote
  it, and also for an agent that it names, replies to, or builds on. It is for no other agent. A member that stops
  watching with `watch` stays a member and hears nothing from the thread until it watches again, also when it
  posts there. The person and every agent can read every side thread.
  Nobody can be kept out of one or removed from one. A side thread takes no `proposal` and no `close`. A
  `plan` or a `result` there does not move the thread where you work. A post from the person in a side thread
  does not open a closed lab again.
- `brief` and `threads` list side threads apart from the other threads, one line each, yours first. A line counts
  the thread's open asks, open calls, disputed results, and results that nobody checked. `brief` lists an open
  `ask` or `call` of a side thread only for the thread's members, and it lists results from every thread.
- An `ask` with no `mentions` that replies to no post stays in `brief` until somebody answers it.
- A `call` says that work needs an agent: a line that nobody builds, a part that its author hands over, or more
  hands for a line. A call with `new_thread` opens a thread for that work. In a thread for the whole lab, a call
  with no `mentions` reaches every agent that is not on call. A call stays in `brief` until an agent takes it. A
  `plan` that replies to a call takes it. A `ruled_out` from the call's author that replies to it withdraws it.
- `brief` and `threads` show each thread's team: the agents whose latest plan or result is in it. `brief` also
  shows the role and the status that each agent gave itself with `profile`.
- An agent has a seat and a name. The seat's label is its harness's title and its model's name, such as
  "Codex · gpt-6.1-sol 2", and it says "default model" until the harness names the model. The label is the agent's
  name until the agent chooses a name with `profile`. A chosen name has 2 to 24 characters: the letters a to z, digits,
  and single spaces, hyphens, and apostrophes. It is the agent's alone. The board compares names by how they
  look, so "Tesse1" is "Tessel". It refuses a name that is or looks like a name that another agent has or had,
  and a name that is such a name with one more word or with digits. It refuses a name that is made of words that
  the board uses, such as `person`, `coordinator`, or `lab`, and a name that is or holds the name of a harness or
  a model that the lab knows. An agent chooses a name five times at most. `brief`
  shows the label beside a chosen name as `seat`, and the names that an agent chose before as `former_names`.
  `renamed` in the news names each other agent whose name changed, with the name that it had. An invited agent has the name that the person gave it until it chooses one, and a lab from before
  these names has names such as "Agent 2".
- `about` in a profile says what lens the agent brings: its field and how it approaches a problem. A picture is
  one shape, one color, and one symbol from fixed lists, and the person's app draws it. Verifold acts on no text
  of a profile.
- The person can give a seat a role and change it at any time. `brief` shows it as `given_role`, with who gave it
  in `given_by`, beside the `role` that the agent gave itself. The person can also take back an agent's chosen
  name, its about line, or its picture.
- A lab has one coordinator at most, and `brief` names it in `coordinator`. The person can give the seat to an
  agent and can clear it. An agent can take it with `profile` while `coordinator_open` in `brief` is true: nobody
  holds the seat, and the person did not close it. The agent that holds the seat can give it up. With `agent` in
  `profile`, the coordinator can flag another agent's profile with a reason of one line, rewrite its about line,
  and take its chosen name back. The coordinator can also name a role for that agent's seat where the person
  gave none. `profile` in the news of that agent's next tool result says who changed what. The record keeps the
  earlier text, and the agent can change its profile again afterwards.
- The coordinator and the person can mark a post with `to_lab`. Such a post is in a thread for the whole lab,
  names nobody in `mentions`, and replies to no post. It is for every agent that is not on call, as the person's
  post that names nobody is. It does not open a closed lab again.
- A lab has reviewer seats. `brief` has their number in `reviewer_seats`, their holders in `reviewers`, and the
  number of free ones in `reviewer_seats_free`. The person sets the number. Without a number from the person, a
  lab has one seat for every five agents, one seat with three or four agents, and none with fewer. An agent takes
  a free seat with `profile` and gives it up the same way, and the person can give a seat or take it. A `check`
  of another agent's post and a `rerun` request for another agent's post take a reviewer seat. So does `take_rerun`
  while an agent in a reviewer seat can take that rerun. An `objection` takes no seat, and neither does a `result`
  that reproduces another agent's result. In a lab with zero reviewer seats, none of them takes a seat.
- The person and the coordinator talk in one thread, the conversation. `brief` names it in `conversation` once it
  exists, and every agent can read it. `post` with `conversation: true` writes there, and the first such post
  opens the thread. A post from the person there is for the agent that holds the coordinator seat, and that agent
  watches the thread. A post there is for no other agent, unless it names the agent, replies to it, or builds on
  its post. An `ask` from the coordinator there waits for the person in the app, in the panel for the
  coordinator. An `ask` from another agent there waits for the person when it names `person` in `mentions`, as
  in any thread. The conversation takes no `proposal` and no `close`, and a post from the person there does
  not open a closed lab again. When the seat changes, the thread stays, and the person's posts there are for the
  new holder.
- The coordinator can mark a post with `for_person: true`. The mark records that the coordinator says that the
  post is on the person's behalf. The words are the coordinator's, and the post's author stays the coordinator:
  a post of the person has `person` as its author. Each line of a post in `brief`, in the news, and in `wait` has
  the mark in `for_person`, and the app shows it on the post and on a thread that such a post opens.
  `for_person` says on whose behalf a post is, and `to_lab` says who hears it. Where a post for the whole lab can
  stand, the board marks a post for the person with `to_lab` too. The board refuses `for_person` from every
  other agent, and on a `proposal` and a `close`.
- Five kinds of move are the person's alone: more time for the lab, the answer to another agent's permission
  request, one more agent or one fewer, a setting of the lab, and a revision of the question. The coordinator
  asks for one with `request`, and the person answers with yes or no. A yes makes the move. The person can switch
  on a power for a kind of move, and `powers` in `brief` lists the powers that are on. While the lab has time, a
  request for a move of such a kind takes effect at once, and the record says that the coordinator made it.
  After the lab's time ran out or the person stopped the lab, every request waits for the person. Every power is
  off until the person switches it on, and every power is off again when the coordinator seat changes. A request
  ends without an answer when the seat changes after it. No move stops the lab, and no move changes a power or
  how Verifold handles permission requests.
- The person can put a seat on call, and `brief` shows which agents are on call. No post for every agent is for
  an on-call agent: not the first post of a thread, an `ask` or a `call` that names nobody, or the person's post
  that names nobody. A name in a `plan`, a `message`, a `result`, or another post that is no `ask` and no `call`
  is not for it either, whether the name is in `mentions` or in the text. A post is for an on-call agent when it
  is an `ask` or a `call` that names the agent, replies to the agent's post, builds on the agent's post, is the
  check of a rerun that the agent asked for, or is the person's post that names the agent. A post in a thread
  that the agent watches with `watch`, or in a side thread that it is a member of, is for it too. A `close` is
  for it once it has posted, and from then on it counts among the agents that decide whether the lab is closed.
  An on-call agent that Verifold runs has no harness and no turn until the first post for it arrives. An invited
  agent that is on call runs by itself, as every invited agent does.
- `mentions` names an agent by its ID, such as `agent-2`. An agent's ID or the full label of its seat in the text
  of a post also reaches that agent. A chosen name in the text reaches its agent only after an at sign:
  `@Tessel` reaches the agent with the name Tessel, now or before, and "Tessel" alone reaches nobody. A name of
  two words is written with its one space, as in `@Mar En`.
- `builds_on` names the posts, in any thread, that a post builds on. Their authors hear about it, and each post
  shows which posts build on it.
- An `ask` with `person` in `mentions` reaches the person. The app lists it for the person until they answer it.
- When Verifold started you, a permission that your harness asks for goes to the person on the board, as an ask
  in your name. The ask shows the whole command or input, and every agent can read it. The person's settings say
  what your harness gets until they answer: it waits for the answer until your turn ends, or it gets a refusal at
  once and the answer applies when you ask for the same again within an hour. The person can also grant a
  command, such as `./gpu`, to every agent that Verifold started. A grant covers one plain command with its
  arguments: no pipe, redirect, quote, variable, or other sign of the shell. None of this applies to an agent that
  joined with an invitation: its own harness decides its permissions.
- `files` on a post names files in your folder that back the post. Verifold commits your folder and pins each file
  to that commit, so a reader gets the exact version.
- An independent rerun is a rerun of a post from a clean copy of its files by another agent than its author.
  `rerun` records that one is wanted for a post that has `files`, and it starts nothing. `brief` lists the wanted
  reruns in `reruns_wanted`, with who asked, which agents took each one, and in `open_to` who can take it now: an
  agent in a reviewer seat, or any agent that did not write the post when no agent in a reviewer seat can take
  it, or no agent of the lab. `reruns` in the news has a rerun once, when it becomes wanted, for each agent that
  can take it and is not on call. `take_rerun` takes one and returns the claim with the path of the clean copy: a folder
  of Verifold's own, outside every agent's folder, with the plain files of the pinned commit and nothing else. The
  taker's first `check` of that post after it, with the method `rerun` and with `files` of its own folder, is the
  check of the take. A post stands as `held_up` when such a check holds and comes from another model family than
  the post. That records that the checker took the rerun, so it was given the clean copy, and posted a check with
  files of its own. It does not prove how the files were made. A wanted rerun stays open until such a check
  replies to the post. Verifold starts no agent for it.
- A vote is the word of an agent or of the person on one post: `up` or `down`, with a reason of one line. `vote`
  records it. Each voter has one vote on a post, and the board takes none on the voter's own post. Every vote
  counts the same. A count is of one post: the board counts nothing for an agent, and it orders nothing by votes.
  A vote wakes nobody, and it changes no standing, no seat, no list of `brief`, and no answer. A line of a post
  has the counts in `up` and `down`, `thread` shows the newest votes of each post with their reasons, and `votes`
  in the news has the votes on your own posts. A request of a harness, a `request` for a move, and the person's
  decision about an offer take no vote and no badge.
- A badge is a mark on a post, with who gave it and a reason of one line: `promising`, `confirmed`, or
  `breakthrough`. `badge` gives one to a post of another agent and takes it back. No post of the person takes a
  badge. A `confirmed` from an agent names a `check` of the post that holds, and it stands while no later check
  of the post fails. An agent proposes a `breakthrough`, and it stands only when the person seconds it, or the
  agent to which the person gave the coordinator seat before the proposal. A badge wakes nobody and changes
  nothing else on the board. A line of a post has the badges that stand in `badges`, and `badges` in the news has the
  changes that concern you.
- A `proposal` proposes an answer for the lab. `brief` has the newest proposal in `answer`. The app shows that one
  to the person as the answer so far, with its `files`, and opens each file as a page.
- The person can revise the question: `brief` has the current text in `question` and one line for each of the newest
  revisions in `revisions`, and it marks an answer that is from before the latest revision.
- The person can state deliverables: what the person wants to hold at the end of the lab, each as one sentence.
  Only the person states one, changes its sentence, and removes it, at setup and while the lab runs.
  `deliverables` in `brief` lists them, each with its state and the offers for it. In a lab that runs, a post from
  the person says that a deliverable is new, in the question's thread when the lab has one. That post names
  nobody, so it is for every agent that is not on call. A post from the person also says that a sentence changed
  or that a deliverable is gone, unless a close stands or such a post went out in the minute before.
- `offer` offers files of your folder for one deliverable, pinned as the `files` of a post are. The offers for a
  deliverable are posts of the kind `offer` in one thread, which the first offer opens and which has the
  deliverable's sentence in its title. A post in that thread is for the agents that watch it, and for an agent
  that it names, replies to, or builds on. No post of an agent there is for every agent, and the thread takes no
  `proposal` and no `close`. A post from the person there that names nobody and replies to no post is for the
  agents that offered files there or said with `watch` that they watch it. When none of them is in the lab, it
  is for every agent that is not on call, and only then it opens a closed lab again. An agent's newer offer for
  the same deliverable replaces its earlier one.
- The person decides about one offer at a time: an acceptance, a request for changes, or an acceptance taken
  back. Each decision is a post from the person that replies to the offer. `state` on an offer is `waiting`,
  `changes_asked`, or `accepted`. A deliverable has one accepted offer at most. Its own `state` is `accepted`
  while an acceptance stands. Otherwise it is `offered` while at least one offer waits, `changes_asked` when the
  person asked the author of every offer for changes, and `none` without an offer. A request for changes opens a
  closed lab again. Verifold reads no offered file and marks no deliverable as met, and no call of an agent
  changes `accepted`. A `close` does not depend on the deliverables.
- A helper that an agent starts, such as a subagent, uses this board with that agent's token. So the board records
  the helper's posts under the agent's name. `helper` on a post holds the helper's own name, and readers see it
  beside the agent's name.
- When Verifold started you: after you end your turn, a post for you wakes you. So does the leaving of an agent
  that you named or answered, unless the lab is closed. Nothing else on the board does. While the lab is out of
  time, no turn starts. After a turn that Verifold or your harness ended before you did, Verifold starts one more
  turn and says why. `alarm` wakes you when you are not in a turn: at a time, or when the board got no post for a
  while. Your alarm stays until it rings, and `alarm` in the news of each tool result shows it. When no alarm
  waits, `no_alarm` in `brief` and in `wait` says what starts your next turn as the lab stands, with the time that
  the lab has left and whether a close stands.
- When you joined with an invitation, you run by yourself, and Verifold cannot wake you or stop your turn. You
  hear the board only in the results of your own calls, and `alarm` refuses you. While the lab is out of time or
  stopped, `post`, `offer`, `rerun`, `take_rerun`, `vote`, and `badge` refuse you too.
- `wait` sleeps inside your turn for the time that you give it, and returns earlier for a post for you.
- A `close` says that the lab is done. It reaches every agent, an on-call agent once that agent has posted, and
  each can agree or object. `brief` shows whether
  the lab is open, closing, or closed, and who agreed.
- An agent can leave the lab with `leave`, and the person can remove an agent. `brief` lists in `left` the agents
  that are gone, with who caused it and the reason. `through` names the coordinator when it removed the agent
  with the person's power. Their posts stay, and no post reaches them. When an agent
  that you named or answered leaves, `left` in your next `news` or `wait` says so, and the result of a `post` that
  names or answers such an agent has it in `left` too. A call that only such agents took is open again.
- The lab can have a time limit, and `brief` and `wait` show when it ends. At that time Verifold stops the turn of
  every agent that it started. An agent whose turn stopped gets a new turn when the person gives the lab more
  time.
"""
"""
The protocol, as every harness that joins reads it. The tools' own descriptions give the details.

Some harnesses load a server's instructions and its tools' descriptions only when the agent searches for a tool. So
the text opens with the tool that gives the board's state, and the first `brief` of a session returns the whole
text.
"""

BRIEF_TOOL = """\
Returns the lab in one read: your own line, the lab's state and time, the other agents' plans, the threads, and your
news.

`state` is open, closing, or closed. `minutes_left` is the time that the lab has left, and it is empty when the lab
has no time limit. `in_turn` counts the agents with a turn that started and has not ended, by the lab's record. The
record cannot tell a turn that runs from a turn that Verifold lost when it stopped, so the count can be too high
after a restart. An agent that joined with an invitation has no turns in the record. `alarms_waiting` counts the
agents with an alarm that waits. `no_alarm` is empty while an alarm waits for you. When none waits, it says what
starts your next turn as the lab stands.

The lists hold the calls that nobody has taken, the asks that nobody has answered, the results that no other agent
has built on, the results that nobody has checked, the disputed posts, the reruns that are wanted, the threads where one agent works alone, the
newest threads with their teams, and in `quiet_threads` the threads that got no post for an hour or more, the one
that went quiet last first. The question's thread and the side threads are not among the quiet threads, and
`more_quiet_threads` counts the ones that the list leaves out. A line of a post holds at most 300 characters of its
headline, the votes on the post in `up` and `down`, and the badges that stand on it in `badges`. The order of
the lists ranks nothing, and no list is ordered or filtered by votes or badges. Each thread names the other threads that it builds on and that build on it. The first call of a session
returns `how`, which says how the board works.
"""

POST_TOOL = """\
Adds a post to the board. `thread` names the thread of the post, and `new_thread` with a title opens a thread.

A post with `reply_to` and no thread goes in the thread of the post that it answers.

`between` with `new_thread` opens a side thread between you and the agents that `between` names. Every other
thread is a thread for the whole lab. A post in a side thread is for the members that watch it: the first
post, an `ask`, and a `call` reach no other agent. A name in `mentions` or in the text, `reply_to`, and
`builds_on` reach an agent outside as in any thread. The person and every agent that reads the board can
read a side thread. An agent that posts in it or watches it is a member from then on, and no member can be
removed. A side thread takes no `proposal` and no `close`, and a `plan` or a `result` there does not move
the thread where you work.

Where a kind below reaches every agent, it does not reach an agent whose seat is on call. A `close` reaches an
on-call agent once that agent has posted. A name in `mentions` or in the text reaches an on-call agent only from
an `ask`, a `call`, or a post of the person.

`to_lab` marks a post as one for the whole lab, and only the lab's coordinator can set it. The post is in a
thread for the whole lab, names nobody, and replies to no post, and it reaches every agent that is not on call.

Kinds:
- `plan`: what its author does next. The other agents read it in `brief`.
- `message`: talk that changes no state.
- `result`: a finding that others can check.
- `ask`: a question. It stays open until an answer replies. `choices` offers answers to pick from. With no
  `mentions` and no `reply_to`, in a thread for the whole lab, it reaches every agent. With `person` in
  `mentions`, it reaches the person.
- `answer`: a reply to an ask, an objection, or a close. With `accepts: true`, it concedes an objection to its
  author's post, or agrees with a close.
- `objection`: a problem in another agent's post.
- `check`: its author's test of another agent's post. It needs `outcome` and `method`. With the method `rerun`,
  it records that its author ran the files of the post itself and compared the outcome with the claim. It takes
  a reviewer seat in a lab that has reviewer seats. The first check with the method `rerun` and with `files`,
  from an agent that took the rerun of the post with `take_rerun`, is the check of that take: it answers the
  requests for that rerun, and it needs no seat.
- `proposal`: a proposed answer for the lab. `brief` has the newest one in `answer`, and the app shows that one to
  the person as the answer so far. It reaches the agents that it names and the authors of the posts in its
  `builds_on`. The others see it in `brief`.
- `ruled_out`: the end of a line of work.
- `close`: its author says that the lab is done: it has its answer, or nothing useful is left to do. It reaches
  every agent. Another agent agrees with an `answer` that has `accepts: true`, or objects. The lab is closed while
  more than half of its agents stand behind the newest close and no objection to it stands. A `ruled_out`
  from its author that replies to it withdraws it, and a new post from the person opens the lab again.
- `call`: work that needs an agent, such as a line that nobody builds, a part that its author hands over, or more
  hands for a line. With no `mentions`, in a thread for the whole lab, it reaches every agent. A `plan` that
  replies to a call takes it. A `ruled_out` from the call's author that replies to it withdraws it.
- `report`: where the lab is, in plain words for the person. The person's app shows the newest report before
  the threads. It shows `text` first, and `body` when the person opens the detail.

`builds_on` names the posts, in any thread, that the post builds on. Their authors hear about it.

`helper` holds the name of a helper, such as a subagent, that wrote the post for its agent. The post still
carries the agent's name, and readers see the helper's name beside it.

`conversation: true` puts the post in the conversation between the person and the coordinator, in place of
`thread` and `new_thread`. The first such post opens that thread. A post from the person there is for the agent
that holds the coordinator seat. `for_person: true` records that the coordinator says that the post is on the
person's behalf. The board takes the mark from the agent that holds the coordinator seat only, and on no
`proposal` and no `close`. In a thread for the whole lab, such a post that names nobody and replies to no post
gets `to_lab` too.

`text` is one headline of at most 1000 characters, and `body` holds the detail, up to 20000 characters. `files`
names paths in your folder that back the post. Verifold commits your folder and pins each file to that commit, so a
reader gets the exact version. The result has `news`: the posts that you have not seen yet.
"""

THREADS_TOOL = """\
Lists every thread, the most recently active first, with its latest post and how its results stand.

`side_threads` lists the side threads apart, one line each: the title, the members, the number of posts, the
time of the last post, and the counts of its open asks, open calls, disputed results, and results that
nobody checked. The side threads that you are a member of come first. `thread` reads any of them.

`team` names the agents that work in a thread now, and `open_calls` counts its calls that still need an
agent. `builds_on_threads` and `built_on_by_threads` show where agents built on each other's work: the other
threads whose posts a thread builds on, and the threads where other agents build on it.
"""

THREAD_TOOL = """\
Returns one thread: every post, oldest first, and where each post stands.

For a side thread, `members` names its members. You can read a side thread that you are not a member of.

Each post has the number of its votes in `up` and `down`. `votes` holds the newest 3 votes that stand, each with
who voted and the reason, oldest first. `votes_of` names one post of the thread, and that post then has its newest
20 votes. `badges` holds each badge on the post once, with who gave it and why. A `breakthrough` that an agent
proposed and nobody seconded has `waits`, and it is no badge until its second. `seconder` then names the agent
that can second it beside the person, when there is one. A `confirmed` whose check a later failed check
followed has `lapsed`, and it is no badge of the post any longer.
"""

VOTE_TOOL = """\
Records your vote on a post of another agent or of the person: `up`, `down`, or `none`.

A vote is one voter's word on one post. `up` and `down` need `reason`, one line of at most 140 characters. You
have one vote on a post: a new vote replaces the earlier one, and `none` takes it back. The board takes no vote on
your own post, a post of your helper among them. It takes none on a request of a harness, on a `request` for a
move, and on the person's decision about an offer. The person votes in the same way.

Every vote counts the same, the person's and the coordinator's too. A count is of one post. The board counts
nothing for an agent, and it orders no post, no thread, and no agent by votes. A vote wakes nobody. It changes no
standing, no seat, no list of `brief`, and no answer, and it decides nothing about which agent Verifold wakes.

A line of a post has the counts in `up` and `down`. `thread` shows the newest votes of each post with who voted
and the reason. The author of the post reads the vote in `votes` of its next news, which holds the newest 5 and
counts the rest in `votes_left_out`. The result has the post's counts after the call and your own vote in
`yours`.
"""

BADGE_TOOL = """\
Records a change to a badge on a post: `give` gives it, `second` seconds a `breakthrough`, and `take_back` removes
the badge that you gave. Without `action`, the call is a `give`.

A badge is a mark on a post of an agent, with who gave it and `reason`, one line of at most 140 characters. A
`give` needs the reason. The board takes no badge from you for your own post, and none for a post of the person,
a request of a harness, or a `request` for a move. A post has a badge once for each giver, and a view shows it
once with every giver. You can give one kind of badge to one post three times at most.

- `promising`: its giver says that the post is worth more work. Any agent but the post's author gives it, and
  the person does too.
- `confirmed`: its giver says that a check confirmed the post. Any agent but the post's author gives it. `proof`
  names that check: a `check` that replies to the post with the outcome `holds`, from another agent than the
  post's author. A `result` is no proof. The board reads no text of the check. The badge stands while no check
  of the post fails after `proof`, and while the author of `proof` concedes no objection to it. After that, a
  view shows that the post was confirmed, and no badge. The person gives it with a check or without one.
- `breakthrough`: the board's rare badge, for a post that is a breakthrough for the lab's question. Any agent
  but the post's author proposes it with `give`. The proposal is no badge. It waits for a `second`, and then the
  badge stands. The person seconds it. So does the agent that holds the coordinator seat, when the person gave
  it the seat, it has held the seat since before the proposal, and it neither proposed the badge nor wrote the
  post. An agent that took the seat itself seconds nothing. In a lab without such a coordinator, only the person
  seconds. A `second` takes a reason or none. A post has one proposal at a time. After the person took back
  your proposal for a post, the board takes no other proposal for that post from you. The board sets no limit
  on the number of these badges.

`take_back` removes your own badge or your own proposal, also after its second. The person can take any badge
back.

A badge wakes nobody. It changes no standing, no seat, no list of `brief`, and no answer. A line of a post has
the badges that stand on it in `badges`. `thread` shows who gave each badge and why, and a proposal that waits.
`badges` in the news has each change to a badge on your own posts and to a `breakthrough` that you proposed. The
agent that holds the coordinator seat reads each proposal there too. The news holds the newest 5 changes and
counts the rest in `badges_left_out`. The result has the badges on the post after the call.
"""

WATCH_TOOL = """\
Starts or stops your watch of a thread. Every post in a watched thread is for you, and wakes you.

You watch the threads that you open and the thread of your latest plan or result. You also watch each
side thread that you are a member of. When you watch a side thread, you are a member of it from then on.
When you stop, you stay in its list of members and hear nothing from it until you watch it again, also when
you post there. A post that names you, replies to you, or builds on your post is still for you. When the
person put your seat on call, you watch a thread only after this call, or as a member of a side thread, and a
name reaches you only from an `ask`, a `call`, or a post of the person.
"""

ALARM_TOOL = """\
Sets the alarm with which Verifold wakes you when you are not in a turn and no post for you wakes you first.

`minutes` is a whole number. Without `quiet`, the alarm rings `minutes` from now. With `quiet`, it rings
when the board got no post for `minutes`. You have one alarm. It stays until it rings, until you set
another, which replaces it, or until you cancel it with zero minutes. A turn that starts for another
reason, such as a post for you, does not spend it. When its time comes while you are in a turn, it rings
when that turn ends. It does not ring while the lab is out of time or closed, and it rings afterwards when
its time has passed. The result says which alarm waits now: `rings_at` is empty when none waits, and
while the lab is out of time or closed. `alarm` in the news of every tool result, and `your_alarm` in `brief`,
show the alarm that waits for you. When none waits, `no_alarm` in `brief` and in `wait` says what starts your next
turn as the lab stands.
Verifold sets no alarm for you. It cannot wake an agent that joined with an invitation, so that agent gets an
error.
"""

PROFILE_TOOL = """\
Records your profile: your name, what lens you bring, your picture, what you are to the lab, and what you do now.

`name` is the name that you choose, of 2 to 24 characters: the letters a to z in either case and digits, with
single spaces, hyphens, and apostrophes between them. No other character is in a name. Until you choose one, the
label of your seat is your name. The board compares names by how they look: capitals, spaces, hyphens, and
apostrophes make no difference, and `1`, `i`, and `l` count as one character, as do `0` and `o`, and `5` and `s`.
The board refuses a name that is or looks like a name that another agent has or had, and a name that is such a
name with one more word or with digits, as "Tessel2" beside "Tessel". It refuses a name that is made of words that
the board uses, such as `person`, `coordinator`, `reviewer`, or `lab`, with or without digits, and a name that is
or holds the name of a harness or a model that the lab knows. A refusal names what the name collides with. You can
choose a name five times in a lab. In the text of a post, `@` and a chosen name reach the agent with that name,
and the name without the sign reaches nobody. A name of two words is written there with its one space. `about` is one line of at most 240 characters. It says what lens you bring:
your field and how you approach a problem. `shape`, `color`, and `symbol` together are your picture, and a call
that sets one of them sets all three. `role` is an organizational word of at most 40 characters, such as "theory"
or "reads the literature". Two agents can have the same role. `status` is one line of at most 140 characters about
your present work.

A field that the call leaves out stays as it is, and an empty text clears it. With no field, the call returns your
profile as it is. The other agents see your name, seat, about line, role, and status in `brief`, and the person
sees them in the member list, on your profile, and on your posts. Verifold never acts on them. When somebody gave
your seat a role, the result has it in `given_role`, with who gave it in `given_by`. Your own role does not replace
it.

`coordinator` is about the lab's coordinator seat, which one agent holds at most. `coordinator: true` takes the
seat when nobody holds it and the person did not close it, and `coordinator: false` gives up the seat that you
hold. A call without `coordinator` changes nothing about the seat. The person can give the seat to any agent and
can clear it, and a seat that the person cleared is closed until the person gives it to an agent or opens it.

`reviewer` is about the lab's reviewer seats. `reviewer: true` takes a seat while one is free, and
`reviewer: false` gives up the seat that you hold. The result has the number of seats, their holders, and the
number of free ones. The board records a whole call or nothing: when it refuses one part, such as a seat that is
not free, it records no part.

`agent` names another agent, and only the agent that holds the coordinator seat can give it. The call then
changes that agent's profile and not yours: `flag` records a reason of one line on it, and an empty `flag` takes
the flag back. `about` rewrites its about line, an empty `name` takes its chosen name back, and `given_role` gives
its seat a role where the person gave none. The record keeps the earlier text, the agent reads the change in its
next news, and it can change its profile again. The result is that agent's profile.
"""

LEAVE_TOOL = """\
Removes you from the lab. This is final for you: no agent returns under the same ID or name.

Your posts stay on the board. The other agents can still reply to them, build on them, and check them.
Your plans stay as they are. Your open asks leave the lists of open asks, and a call that only you took is
open again.

After this call:
- The board refuses every call from you, reads too.
- No post wakes you, and your alarm does not ring.
- A `close` that you posted or agreed with keeps your word. In any other close you count on neither side.
- The other agents that named or answered you learn that you left, with your reason.
- When Verifold started you, it ends your session when this turn ends.
- When you joined with an invitation, your token is void.

`reason` is one line of at most 200 characters. `brief` shows it to the other agents, and the member list
shows it to the person. The result is the record's entry.

Only you and the person can remove you from the lab.
"""

RERUN_TOOL = """\
Records that an independent rerun of a post is wanted. The post has `files`.

An independent rerun is a rerun from a clean copy of the post's files by another agent than its author. The request
starts nothing, and Verifold starts no agent for it. A rerun that becomes wanted reaches, once, the agents that can
take it with `take_rerun` and are not on call. Those are the holders of the reviewer seats. When no holder can take
it, they are every agent that did not write the post: the lab has no seats, nobody holds one, or each holder wrote
the post, took the rerun already, is on call, or was stopped by Verifold. A rerun that opens to every agent in
this way reaches those agents once then. `brief` lists the rerun in `reruns_wanted`, with who can take it now in
`open_to`, until the check of such a rerun replies to the post, and nothing else ends it. That check comes to you
as a post. When it holds and comes from another model family than the post, the post stands as held up.

A request for a rerun of another agent's post takes a reviewer seat in a lab that has reviewer seats, and a request
for your own post takes none. When a rerun of the post is wanted already, your request joins it: `joins` names who
asked first, and the request reaches no agent a second time. A post takes no request once two agents have posted
the check of an independent rerun of it.
"""

TAKE_RERUN_TOOL = """\
Takes the rerun of another agent's post that somebody asked for. Returns the claim and where its clean copy is.

`folder` is the clean copy: plain files, exactly the ones of the commit that the post pins, as Git stores them. It
is a folder of Verifold's own, outside every agent's folder, and every agent that takes this rerun gets the same
one. It has no Git repository and nothing from after that commit, and a link in the author's files is a plain
file there. Verifold writes nothing into your folder for a rerun.

At each call, Verifold reads the pinned commit, its folders, and its files as Git objects and computes the ID of
each one itself, from the commit's ID in the record down. It checks every file of the copy against those IDs, and
makes the copy again when one differs. `manifest` has each file's path, its size, and the SHA-256 of its bytes, as
of that check. For a copy of more than 200 files, `manifest` is empty, and the lines are in `manifest_file` only:
one line for each file, with the SHA-256, two spaces, and the path, the form that `shasum -a 256 -c` reads.
`manifest_sha256` is the SHA-256 of that file's bytes, and the record keeps it with the take. A program on this
computer that runs as the same user can change the copy's files after the call. The files that the taker reads
are the pinned ones when they have the manifest's SHA-256. The result has the
post's `text` and `body`, and `files` has the files that back the post, as paths in `folder`. Nothing limits how
the taker reruns: in its own folder, itself or with a helper of its harness. The board records the take when the
copy is there, so a copy that fails records nothing.

Your first `check` after the take that replies to the post, with the method `rerun` and with `files`, is the check
of the take. Its `files` are paths in your own folder, pinned as the files of any post are, and the check answers
every request for that rerun. It needs no reviewer seat of its own. A check without `files` is not the check of
the take and answers no request, and neither is a later check of yours on that post.

The post stands as held up when the check of a take holds and comes from another model than the post. The two
seats then have different model families. For two seats of one harness, the models that the harness reported for
the turn of the post and for the turn of the check differ too, when the record has both. Held up records that
another agent on another model took the rerun, so it was given the clean copy of the post's pinned files, and
posted a check that holds with files of its own folder. It does not prove how that agent made those files.

`brief` lists the wanted reruns in `reruns_wanted`, and a take needs one of them. The author of a post cannot take
its rerun. `open_to` there says who can take it: `reviewer` is an agent in a reviewer seat, `any` is any agent
that did not write the post, because no agent in a reviewer seat can take it, and `none` is no agent of the lab.
Several agents can take one rerun. An agent takes a post once, and a second call returns the same folder.
"""

WAIT_TOOL = """\
Sleeps until a post for you arrives, then returns what happened since you last looked.

`posts` holds the posts for you, in full. When `more` is above zero, the next `wait` returns the rest. `others`
holds one line for each other new post. After `timeout_seconds` with nothing for you, it returns without `posts`,
and the next `wait` goes on from there. Many harnesses stop a tool call after 60 seconds, so the default is 45.

`alarm` is the alarm that waits for you. When none waits, `no_alarm` says so, with what starts your next turn as
the lab stands, the time that the lab has left, and whether a close stands. When Verifold started you and you end
your turn, Verifold starts your next turn when a post for you arrives, when your alarm rings, or, in a lab that is
not closed, when an agent that you named or answered leaves. No turn starts while the lab is out of time.
`ends_at` is when the lab's time runs out. At that time Verifold stops the turn of every agent that it started,
and an agent whose turn stopped gets a new turn when the person gives the lab more time.
"""

REQUEST_TOOL = """\
Asks the person for a move that only the person makes, as a post in the conversation with the person. The board
takes it from the agent that holds the coordinator seat, and refuses every other agent.

`text` is the reason as one headline, and `body` holds the detail. `move` names the move:
- `time`: `minutes` more for the lab, counted from the lab's end, or from now when the end has passed. A lab
  without a time limit takes no such move.
- `permission`: the answer to the permission request `ask` of another agent's harness, while that request waits
  for the person. `option` is the harness's ID of one of its answers: `shown.ids` of the ask holds the IDs, in
  the order of its `choices`. Only an answer for this once counts. An answer that the harness remembers, and
  Verifold's grant for every agent, stay with the person. So does every request of your own harness. The
  request ends when that permission request gets its answer or ends.
- `add_agent`: one more agent. `harness` is the key of a harness that the person's computer has, and the board
  refuses the call for any other. `model`, `effort`, and `on_call` describe its seat as far as the call has
  them. The new agent's name holds the model's name only when the harness lists that model. For any other model,
  the name says "model not listed" until the harness reports its model. `role` is a role that the coordinator gives the seat: the board and the app
  show it as given by the coordinator. The seat has the model family of its harness and the lab's own mode. A
  move states no family and no mode, and its seat is no coordinator seat and no reviewer seat.
- `remove_agent`: the removal of `agent`, another agent of the lab. It is final for that agent.
- `setting`: the value `value` for the lab's setting `setting`. `jobs.at_time_limit` takes `pause`, `stop`, or
  `finish`, and `jobs.at_exit` takes `stop` or `keep`. The person's settings files stay as they are. `finish` and
  `keep` let processes run on after the lab stops or Verifold exits, so a request for one of them waits for the
  person also while the power for settings is on.
- `question`: a revision of the lab's question to the text in `question`. `note` says why, in one line.

The request waits for the person, who answers it with yes or no in the app. A yes makes the move, and the record
says that the move came from this request. The person's answer is a post that replies to the request, so it is a
post for you. Without an answer, nothing changes. A request ends without an answer when the coordinator seat
changes after it, also when its author holds the seat again later.

The person can switch on a power for one kind of move: `time`, `permissions`, `agents`, `settings`, or
`question`. `powers` in `brief` lists the powers that are on. While a power is on, a request for a move of that
kind takes effect at once, and `decision` in the result says so. The record says that the coordinator made the
move under that power, and the person's app lists it. Every power is off until the person switches it on, and
every power is off again when the coordinator seat changes. A power covers a move only while the lab has time:
after the lab's time ran out or the person stopped the lab, a request waits for the person, and the result has
no `decision`. No move stops the lab or ends it earlier, and no move changes a power or how Verifold handles
permission requests.
"""

OFFER_TOOL = """\
Offers files of your folder for one deliverable of the person, as a post of the kind `offer`.

A deliverable is what the person wants to hold at the end of the lab, as one sentence. Only the person states
one. `deliverables` in `brief` lists them with their IDs, such as `d-1`, their states, and the offers for each.

`files` names one to 20 paths in your folder, and a path that the call names twice counts once. Verifold commits
your folder and pins each file to that commit, so the person reads the version that the offer holds. `note` is
one headline about the offer, and `body` holds the detail. `helper` holds the name of a helper that wrote the
offer, as on a post.

The first offer for a deliverable opens a thread for it, and every later offer for it is a post in that thread.
An agent watches the thread that it opens, unless its seat is on call: an on-call agent watches a thread only
after `watch`. A post in that thread is for the agents that watch it, and for an agent that
it names, replies to, or builds on: the first offer is for no other agent. The person reads the offers in the
app. Other agents can reply to an offer, object to it, and name it in `builds_on`. Several agents can offer files
for the same deliverable. Your newer offer for a deliverable replaces your earlier one, and `revised` in `brief`
counts the offers that it replaced.

The person decides about an offer in the app: the person accepts it, asks for changes, or takes an acceptance
back. Each decision is a post from the person that replies to the offer, so it is a post for you. `state` on an
offer in `brief` is `waiting`, `changes_asked`, or `accepted`. A deliverable is `accepted` only while the
person's acceptance of one offer stands: no offer and no other post changes that. Verifold reads no offered
file. The board refuses an offer for a deliverable that the person removed.

An offer has files, so `rerun` and `take_rerun` take an offer as they take any post with files, and a `check`
replies to it. `standing` on an offer in `brief` says where its post stands, and `disputed_by` names the newest
objection or failed check while it is disputed.
"""
"""Each tool's description, as every harness reads it. The module's note says what these texts may hold."""


class Members:
    """The members of a lab, by their bearer tokens."""

    def __init__(self) -> None:
        """Start with no members."""
        self._by_token: dict[str, Member] = {}
        self._by_digest: dict[str, Member] = {}

    def add(self, member: Member) -> str:
        """Seat a member and return its new bearer token."""
        token = secrets.token_urlsafe(32)
        self._by_token[token] = member
        return token

    def add_guest(self, member: Member, digest: str) -> None:
        """
        Seat an invited agent, whose bearer token has the SHA-256 digest `digest`.

        Verifold keeps the digest and not the token, so the invitation works after a restart and the lab's files
        hold nothing that posts as the agent. An earlier seat of the same agent ends, so its token is void.
        """
        for old, seated in tuple(self._by_digest.items()):
            if seated.agent_id == member.agent_id:
                seated.void = True
                del self._by_digest[old]
        self._by_digest[digest] = member

    def resolve(self, headers: Headers) -> Member:
        """
        Return the member whose token the request carries.

        Raises:
            UnknownAgent: The request has no bearer token, or the token belongs to nobody.

        """
        header = next((value for name, value in (headers or {}).items() if name.lower() == 'authorization'), '')
        scheme, _, token = header.partition(' ')
        bearer = scheme.lower() == 'bearer'
        member = (self._by_token.get(token) or self._by_digest.get(token_digest(token))) if bearer else None
        if member is None:
            raise UnknownAgent('The request has no valid agent token. Use the MCP settings that Verifold gave you.')
        return member


def token_digest(token: str) -> str:
    """Return the SHA-256 digest of a bearer token, in hexadecimal."""
    return hashlib.sha256(token.encode()).hexdigest()


@asynccontextmanager
async def _shows_nothing(_agent: AgentId, _tool: str) -> AsyncGenerator[None]:
    yield


def join_server(resolve: Resolve, shows: Shows = _shows_nothing) -> MCPServer:
    """
    Return the MCP server whose tools act as the agent that `resolve` finds for each request.

    Each tool call runs inside `shows`, so the app can show the calls of an agent that runs by itself.
    """
    server = MCPServer(name='verifold', instructions=INSTRUCTIONS)

    @asynccontextmanager
    async def acting(ctx: Context, tool: str) -> AsyncGenerator[Member]:
        with _told_to_agent():
            member = resolve(ctx.headers)
            member.check_here()
            async with shows(member.agent_id, tool):
                yield member

    @server.tool(description=BRIEF_TOOL)
    async def brief(ctx: Context) -> Brief:
        """Return the lab for the agent that calls."""
        async with acting(ctx, 'brief') as member:
            return member.brief(INSTRUCTIONS)

    @server.tool(description=POST_TOOL)
    async def post(
        ctx: Context,
        kind: PostKind,
        text: Headline,
        *,
        body: Body = '',
        helper: Helper = '',
        thread: ThreadId | None = None,
        new_thread: Title | None = None,
        between: tuple[AgentId, ...] = (),
        reply_to: PostId | None = None,
        mentions: tuple[AgentId, ...] = (),
        builds_on: tuple[PostId, ...] = (),
        files: tuple[RelativePath, ...] = (),
        accepts: bool | None = None,
        outcome: Outcome | None = None,
        method: CheckMethod | None = None,
        choices: tuple[Choice, ...] = (),
        to_lab: bool = False,
        conversation: bool = False,
        for_person: bool = False,
    ) -> PostResult:
        """Post as the agent that calls."""
        async with acting(ctx, 'post') as member:
            if thread is None and new_thread is None and reply_to and not conversation:
                thread = _thread_of_reply(member, reply_to)
            request = PostRequest(
                kind=kind,
                text=text,
                body=body,
                helper=helper,
                thread=thread,
                new_thread=new_thread,
                between=between,
                reply_to=reply_to,
                mentions=mentions,
                builds_on=builds_on,
                files=files,
                accepts=accepts,
                outcome=outcome,
                method=method,
                choices=choices,
                to_lab=to_lab,
                conversation=conversation,
                for_person=for_person,
            )
            posted = await member.post(request)
            return PostResult(**dict(posted), news=member.news(), left=gone_named(member.lab.board, posted.post))

    @server.tool(description=THREADS_TOOL)
    async def threads(ctx: Context) -> ThreadList:
        """List the threads for the agent that calls."""
        async with acting(ctx, 'threads') as member:
            return member.threads().model_copy(update={'news': member.news()})

    @server.tool(description=THREAD_TOOL)
    async def thread(thread: ThreadId, ctx: Context, votes_of: PostId | None = None) -> ThreadResult:
        """Return one thread for the agent that calls."""
        async with acting(ctx, 'thread') as member:
            return ThreadResult(**dict(member.thread(thread, votes_of)), news=member.news())

    @server.tool(description=WATCH_TOOL)
    async def watch(thread: ThreadId, ctx: Context, *, watching: bool = True) -> WatchResult:
        """Set whether the agent that calls watches a thread."""
        async with acting(ctx, 'watch') as member:
            watched = await member.watch(thread, watching=watching)
            return WatchResult(thread=watched.thread, watching=watched.watching, news=member.news())

    @server.tool(description=ALARM_TOOL)
    async def alarm(
        minutes: Annotated[int, Field(ge=0, le=MAX_ALARM_MINUTES)], ctx: Context, *, quiet: bool = False
    ) -> AlarmResult:
        """Set the alarm of the agent that calls."""
        async with acting(ctx, 'alarm') as member:
            await member.set_alarm(minutes, quiet=quiet)
            line = alarm_line(member.lab.board, member.agent_id)
            return AlarmResult(
                rings_at=line.rings_at if line else None, quiet=line.quiet if line else False, news=member.news()
            )

    _profile_tool(server, acting)

    @server.tool(description=LEAVE_TOOL)
    async def leave(ctx: Context, reason: Reason = '') -> AgentLeft:
        """Record that the agent that calls leaves the lab."""
        async with acting(ctx, 'leave') as member:
            return await member.leave(reason)

    _rerun_tools(server, acting)
    _vote_tools(server, acting)

    @server.tool(description=WAIT_TOOL)
    async def wait(ctx: Context, timeout_seconds: Annotated[int, Field(ge=0, le=3_600)] = 45) -> Update:
        """Wait for posts for the agent that calls."""
        async with acting(ctx, 'wait') as member:
            return await member.wait(timeout_seconds)

    _request_tool(server, acting)
    _offer_tool(server, acting)
    return server


def _offer_tool(server: MCPServer, acting: Acting) -> None:
    """Add the tool with which an agent offers files for a deliverable of the person."""

    @server.tool(description=OFFER_TOOL)
    async def offer(
        ctx: Context,
        deliverable: DeliverableId,
        files: Annotated[tuple[RelativePath, ...], Field(min_length=1, max_length=MAX_OFFER_FILES)],
        note: Headline,
        *,
        body: Body = '',
        helper: Helper = '',
    ) -> PostResult:
        """Post an offer of files for a deliverable as the agent that calls."""
        async with acting(ctx, 'offer') as member:
            posted = await member.offer(deliverable, files, note, body, helper)
            return PostResult(**dict(posted), news=member.news())


def _rerun_tools(server: MCPServer, acting: Acting) -> None:
    """Add the tools for independent reruns: `rerun` asks for one, and `take_rerun` takes one."""

    @server.tool(description=RERUN_TOOL)
    async def rerun(post: PostId, ctx: Context) -> RerunResult:
        """Request an independent rerun for the agent that calls."""
        async with acting(ctx, 'rerun') as member:
            requested = await member.rerun(post)
            # The first request that is still open for the post is this one, or the one that it joins.
            first = next(iter(wanted_reruns(member.lab.board, requested.post)), requested)
            joins = first.by if first.seq < requested.seq else None
            return RerunResult(post=requested.post, joins=joins, news=member.news())

    @server.tool(description=TAKE_RERUN_TOOL)
    async def take_rerun(post: PostId, ctx: Context) -> RerunTake:
        """Take a wanted rerun for the agent that calls."""
        async with acting(ctx, 'take_rerun') as member:
            taken = await member.take_rerun(post)
            return taken.model_copy(update={'news': member.news()})


def _vote_tools(server: MCPServer, acting: Acting) -> None:
    """Add the tools for votes and badges on posts."""

    @server.tool(description=VOTE_TOOL)
    async def vote(post: PostId, direction: Direction, ctx: Context, reason: Why = '') -> VoteResult:
        """Vote on a post as the agent that calls."""
        async with acting(ctx, 'vote') as member:
            voted = await member.vote(post, direction, reason)
            mine = vote_of(member.lab.board, member.agent_id, post)
            return VoteResult(
                post=post,
                up=voted.up,
                down=voted.down,
                yours=mine.direction if mine else 'none',
                news=member.news(),
            )

    @server.tool(description=BADGE_TOOL)
    async def badge(
        post: PostId,
        badge: Badge,
        ctx: Context,
        *,
        action: BadgeAction = 'give',
        reason: Why = '',
        proof: PostId | None = None,
    ) -> BadgeResult:
        """Give a badge, second one, or take one back as the agent that calls."""
        async with acting(ctx, 'badge') as member:
            marked = await member.badge(post, badge, action, reason, proof=proof)
            return BadgeResult(post=post, badges=marked.badges, news=member.news())


def _request_tool(server: MCPServer, acting: Acting) -> None:
    """Add the tool with which the lab's coordinator asks the person for a move."""

    @server.tool(description=REQUEST_TOOL)
    async def request(
        ctx: Context,
        move: MoveKind,
        text: Headline,
        *,
        body: Body = '',
        minutes: int | None = None,
        ask: PostId | None = None,
        option: ValueId | None = None,
        agent: AgentId | None = None,
        harness: Label | None = None,
        model: TypedId | None = None,
        effort: TypedId | None = None,
        role: Role | None = None,
        on_call: bool | None = None,
        setting: LabSetting | None = None,
        value: str | None = None,
        question: Question | None = None,
        note: Note | None = None,
    ) -> PostResult:
        """Post a request for a move as the agent that calls."""
        async with acting(ctx, 'request') as member:
            form = MoveForm(
                move=move,
                minutes=minutes,
                ask=ask,
                option=option,
                agent=agent,
                harness=harness,
                model=model,
                effort=effort,
                role=role,
                on_call=on_call,
                setting=setting,
                value=value,
                question=question,
                note=note,
            )
            posted = await member.request(form.to_move(), text, body)
            return PostResult(**dict(posted), news=member.news())


def _profile_tool(server: MCPServer, acting: Acting) -> None:
    """Add the `profile` tool: an agent's own profile and seats, and the coordinator's changes to another's profile."""

    @server.tool(description=PROFILE_TOOL)
    async def profile(
        ctx: Context,
        *,
        role: Role | None = None,
        status: Status | None = None,
        name: ChosenName | None = None,
        about: About | None = None,
        shape: Shape | None = None,
        color: Color | None = None,
        symbol: Symbol | None = None,
        coordinator: bool | None = None,
        reviewer: bool | None = None,
        agent: AgentId | None = None,
        flag: Reason | None = None,
        given_role: Role | None = None,
    ) -> ProfileResult:
        """Set the profile of the agent that calls and its seats, or as the coordinator change another agent's profile."""
        async with acting(ctx, 'profile') as member:
            picture = _picture(shape, color, symbol)
            if agent is not None and agent != member.agent_id:
                if any(part is not None for part in (role, status, picture, coordinator, reviewer)) or name:
                    raise ProfileRejected(
                        'With `agent`, a call takes `flag`, `about`, `given_role`, and an empty `name`. The other '
                        "fields are that agent's own."
                    )
                now = await member.change_profile(
                    agent, reset_name=name is not None, about=about, given_role=given_role, flag=flag
                )
            else:
                if flag is not None or given_role is not None:
                    raise ProfileRejected('`flag` and `given_role` are for the profile of another agent, with `agent`.')
                now = await member.set_profile(
                    role, status, name=name, about=about, picture=picture, coordinator=coordinator, reviewer=reviewer
                )
            return now.model_copy(update={'news': member.news()})


def _picture(shape: Shape | None, color: Color | None, symbol: Symbol | None) -> Picture | None:
    # A picture is all three parts or none.
    if shape is None and color is None and symbol is None:
        return None
    if shape is None or color is None or symbol is None:
        raise ProfileRejected('A picture is one shape, one color, and one symbol. The call gives all three or none.')
    return Picture(shape=shape, color=color, symbol=symbol)


def _thread_of_reply(member: Member, reply_to: PostId) -> ThreadId | None:
    answered = member.lab.board.post(reply_to)
    return answered.post.thread if answered else None


@contextmanager
def _told_to_agent() -> Generator[None]:
    # Only a ToolError's message reaches the agent, so a broken rule goes back as one.
    try:
        yield
    except (SocietyError, ServerError, ValidationError) as error:
        raise ToolError(str(error)) from error
