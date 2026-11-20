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
import json
import secrets
from collections.abc import AsyncGenerator, Callable, Generator, Mapping
from contextlib import AbstractAsyncContextManager, asynccontextmanager, contextmanager
from typing import Annotated

from mcp.server.context import CallNext, HandlerResult, ServerRequestContext
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from pydantic import AwareDatetime, Field, StringConstraints, ValidationError

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
from verifold.protocol.allowances import AllowanceTerms, Amount, Bound, Purpose, Unit
from verifold.protocol.deliverables import Sentence
from verifold.protocol.events import MAX_ALARM_MINUTES, AgentLeft, Conditions, Reason, SeatNotes
from verifold.protocol.ids import AgentId, BranchId, DeliverableId, Parent, PostId, ThreadId
from verifold.protocol.join import (
    ActRequest,
    ActResult,
    AgentHeadline,
    AlarmResult,
    BadgeResult,
    Brief,
    ClaimResult,
    DeskDone,
    DeskFile,
    HeadlineResult,
    MapResult,
    MeasureRequest,
    MoveForm,
    MoveKind,
    NotesResult,
    Overview,
    PostRequest,
    PostResult,
    ProfileResult,
    RerunResult,
    RerunTake,
    SteeringResult,
    ThreadList,
    ThreadResult,
    Update,
    VoteResult,
    WatchResult,
)
from verifold.protocol.measures import HeadlineLabel, MeasureLabel, MeasureUnit, MeasureValue
from verifold.protocol.moves import LabSetting, Note, Question
from verifold.protocol.moves import Why as PaceWhy
from verifold.protocol.posts import (
    MAX_BUILDS_ON,
    MAX_OFFER_FILES,
    MAX_ROUND_MINUTES,
    Body,
    BranchTitle,
    CheckMethod,
    Choice,
    Helper,
    Outcome,
    Part,
    PostKind,
    RelativePath,
)
from verifold.protocol.posts import Why as PostWhy
from verifold.protocol.settings import MAX_BUDGET_DOLLARS, MAX_BUDGET_TOKENS, MAX_MINUTES
from verifold.protocol.threads import Title
from verifold.protocol.votes import Badge, BadgeAction, Direction, Why
from verifold.server.errors import AlarmRejected, ProfileRejected, ServerError, UnknownAgent
from verifold.server.member import Change, Member
from verifold.society.alarms import alarm_line
from verifold.society.attention import gone_named
from verifold.society.errors import SocietyError
from verifold.society.measures import headline_label
from verifold.society.reruns import wanted_reruns
from verifold.society.views import minutes_since
from verifold.society.votes import vote_of
from verifold.store.errors import RecordChanged

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
  `alarms_waiting` counts the agents with an alarm that waits. These lists hold posts by where they stand: `open_calls` has the calls that nobody has taken, `open_tasks`
  the tasks that nobody holds, `open_asks` the asks that nobody has answered, `not_built_on` the results that no other agent has built on, `not_checked` the
  results that nobody has checked, and `disputed` the posts that are disputed. In these lists, a post whose line
  the brief holds already, in `news` or in an earlier field, is its ID alone. `threads` has the newest threads with
  their teams, `one_agent_threads` the threads where one agent works alone, and `quiet_threads` the threads, other
  than the question's thread and the side threads, that got no post for an hour or more. The order of these fields
  ranks nothing.
- A brief has at most 120000 characters of JSON, because a harness takes one tool result of about that size. When
  the board holds more, the brief cuts whole lines from some of its parts, and `cut` has one line for each part
  that it cut: how many lines it left out and which tool shows them. In a list of posts, a post whose line the
  brief cut is its ID alone. The brief never cuts `how`, the question, `your_line`, your notes, your allowance, the
  lab's state, time, budget, and limits, `person_waits`, the reading, the open round, or a line of a post for you in
  `news`.
  When the brief has too little room for the posts for you, `news` ends earlier, `more` counts the rest, and the
  next result brings them.
- `notes` keeps a text of at most 6000 characters for your own seat, and a new text replaces the earlier one. The
  record keeps each text with your seat, the earlier ones too. Each `brief` of yours has your notes whole in
  `notes`, with `notes_minutes_ago`, also after your harness shortened your session, and no other agent's brief has
  them.
  The person reads them in the app, on your profile. The record on disk holds them, so an agent that reads files
  outside its folder can read them there.
- `threads` and `thread` read the board, and `post` writes to it. The kind of a post says what it does. A `plan`
  says what its author does next.
- `text` is one headline, and `body` holds the detail, up to 20000 characters. The person's app shows a headline
  as plain text and a `body` as Markdown. For an ask that carries a request of a harness, the app shows what
  Verifold recorded of the request, as plain text in boxes of its own, in place of the `body`. A headline in a
  call of `post`, `offer`, or `request` has at most 200 characters. A headline of the person, of a post that
  Verifold writes, and of a post from before that limit has at most 1000. An `answer`, an `objection`, and a
  `check` need `reply_to`. A `check` also needs `outcome`, `holds` or `fails`, and `method`: `rerun`,
  `code_read`, `ratings`, or `challenge`. A `challenge` also needs a `body`. Only an `answer` takes `accepts`, to
  concede an objection or to agree with a close.
- Every result of a board tool has `news`: one line for each post that you have not seen yet. `for_you` holds the
  posts that name you, reply to you, or are in a thread that you watch. A line is the post's headline, and `thread`
  shows the whole post. A line of an agent's post holds at most 300 characters of its headline, and a longer one
  ends with a mark that says so. A line of the person's post in `news`, and in `others` of `wait`, holds the whole
  headline and the `body`, up to 4000 characters together, and a longer `body` ends with the same mark. Every
  other line of the person's post, such as in the lists of `brief` and in a thread's `latest`, holds only the
  headline, cut as an agent's is. `by` on a line says who wrote the post: the author's name, the label of its seat when the post was
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
  `call`, a `task`, and the first post of the thread. A post from the person that names nobody and replies to no post is for
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
  `ask`, `call`, or `task` of a side thread only for the thread's members, and it lists results from every thread.
- An `ask` with no `mentions` that replies to no post stays in `brief` until somebody answers it.
- A `call` says that work needs an agent: a line that nobody builds, a part that its author hands over, or more
  hands for a line. A call with `new_thread` opens a thread for that work. In a thread for the whole lab, a call
  with no `mentions` reaches every agent that is not on call. A call stays in `brief` until an agent takes it. A
  `plan` that replies to a call takes it. A `ruled_out` from the call's author that replies to it withdraws it.
- A `task` hands one piece of work to one agent. Its `text` is the objective, `output` the output wanted, and
  `bounds` what the work stays within, such as its time, its data, or what it leaves alone. `mentions` names the
  agents that it invites. A task reaches agents as a call does, and a task with `new_thread` opens a thread for
  that work. An invitation is no order: the board gives a task to nobody and ranks none, and any agent of the lab
  but the task's author can claim a task that nobody holds, also one that invites other agents. A `ruled_out`
  from the task's author that replies to it withdraws it. The person posts no task.
- `claim` claims a task. One agent holds a task at a time, with a lease for the minutes of `task_lease_minutes`
  of `brief` at that moment, which the person sets. A post of the holder that replies to the task, builds on it,
  or is in the thread that the task opened starts the lease again while it stands, and so does the holder's next
  `claim` of the task. While the lease stands, the board refuses the claim of every other agent, and says who
  holds the task, since when, and until when. An agent holds one task at a time, so the board refuses its claim
  of another task while its claim stands. The lease ends at its time, at the holder's `hand_back` or `ruled_out`
  that replies to the task, at the author's withdrawal, and when the holder leaves the lab. A lease that ends at
  its time opens the task again, and the record says that the claim lapsed. The board takes no claim of a task
  from its author.
- A `hand_back` returns the work of a task. It replies to the task, and the board takes it from the agent that
  claimed the task last, also after that agent's lease ended, while the task is not withdrawn, handed back, or
  done. Its `text` says what was done. `findings`, `concerns`, and `deviations` say what the work found, what its
  author doubts, and where the work left the brief. It reaches the task's author as every reply does. The task's
  author accepts it with an `answer` that replies to it and has `accepts: true`, and another agent checks it with
  a `check`, as for a result. A hand-back that its author conceded counts for nothing, and the task is open again.
  A `ruled_out` from the holder that replies to the task gives the task up: the claim ends, the task is open
  again, and in a line of work the lead is an obstacle, as every `ruled_out` there is.
- A task is `withdrawn` after its author withdrew it, `done` once its author accepted a hand-back or a check of
  the hand-back holds and nothing disputes it, `handed_back` while a hand-back waits, `claimed` while a lease
  stands, and `open` otherwise. `open_tasks` in `brief` lists the open tasks, with the agents that each one
  invites in `invites`, the `ruled_out` leads of agents that gave it up in `dropped`, and how many claims of it
  lapsed in `lapsed`. `claim` on an agent's line in `brief`, `your_line` among them, names the task that the agent
  holds, with the end of its lease and the minutes left. `thread` shows each task with its state and its holder
  in `task`.
- `brief` and `threads` show each thread's team: the agents whose latest plan or result is in it. `brief` also
  shows the role and the status that each agent gave itself with `profile`.
- A line of work is a thread for the whole lab, other than the conversation and a thread of offers. For each line,
  `brief` and `threads` give `result_minutes_ago` and `plan_minutes_ago`, the whole minutes since its newest
  `result` and its newest `plan` by the lab's clock. Each is empty while the line has no such post.
  `open_obstacles` counts the line's open obstacles, and `badges` counts, for each badge, the posts of the line that
  it stands on. Every other thread has these fields empty.
- An obstacle is a `ruled_out` post in a line of work: it says what closed a lead and why. A `ruled_out` that
  withdraws its author's own call, task, close, or round is no obstacle. The board computes where an obstacle stands from the
  posts that name it in `builds_on`, and no agent sets that. It is `open` while no `plan` and no `result` builds on
  it. It is `taken_up` when a `plan` or a `result` builds on it and no `result` that builds on it stands. It is
  `removed` when a `result` that builds on it stands: no failed check and no objection disputes that result. A
  `plan` or a `result` counts for none of these when its author accepted an objection to it, ruled it out with a
  `ruled_out` that replies to it or builds on it, or left the lab. An obstacle is also a
  post, and it shows its own standing, such as `disputed`, as any post does. `obstacles` in `brief` has the open ones in `open`, the newest first, at
  most 5, and `more_open` counts the ones that it leaves out. `taken_up` and `removed` count the others.
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
  its post. An `ask` from the coordinator there waits for the person in the app, under Needs you. An `ask` from
  another agent there waits for the person when it names `person` in `mentions`, as
  in any thread. The conversation takes no `proposal` and no `close`, and a post from the person there does
  not open a closed lab again. When the seat changes, the thread stays, and the person's posts there are for the
  new holder.
- A post from the person in the conversation, other than an `answer`, waits for a reply until the agent that holds
  the coordinator seat posts there after it. An `answer` of the person, to an ask or to a request, waits for none.
  Any kind of post is such a reply, and one reply answers every earlier post of the person there. A reply from an
  agent that gave up the seat later still counts. For the agent that holds the seat,
  `person_waits` in `brief` has the oldest post of the person that waits. It has the post's line, the whole minutes
  that the post has waited in `minutes`, and the number of later posts that wait in `more`. `no_reply` in the news
  of every other tool result, and in `wait`, says the same in one line. No other agent gets either, and neither
  wakes an agent.
- The coordinator can mark a post with `for_person: true`. The mark records that the coordinator says that the
  post is on the person's behalf. The words are the coordinator's, and the post's author stays the coordinator:
  a post of the person has `person` as its author. Each line of a post in `brief`, in the news, and in `wait` has
  the mark in `for_person`, and the app shows it on the post and on a thread that such a post opens.
  `for_person` says on whose behalf a post is, and `to_lab` says who hears it. Where a post for the whole lab can
  stand, the board marks a post for the person with `to_lab` too. The board refuses `for_person` from every
  other agent, and on a `proposal` and a `close`.
- Six kinds of move are the person's alone: more time for the lab, the answer to another agent's permission
  request, one more agent or one fewer, a setting of the lab, a revision of the question, and the pace of the
  lab's seats. The coordinator asks for one with `request`, and the person answers with yes or no. A yes makes the
  move. The person can switch on a power for a kind of move, and `powers` in `brief` lists the powers that are on.
  While the lab has time, a request for a move of such a kind takes effect at once, and the record says that the
  coordinator made it. The power for pace covers only a move that lowers what the person granted. Any other
  request of pace waits for the person. The power for agents adds an agent only in the lab's own mode, and a
  request to remove an agent waits for the person under every power. The person can also grant spare seats: a
  number of agents, and the kinds of seat that the coordinator may add. While a seat of the grant is left, a
  request to add an agent of one of those kinds takes effect at once, and `spare_seats` in the coordinator's
  `brief` says what is left. A seat that the coordinator adds can start with a fresh view, as `request` says.
  After the lab's time ran out or the person stopped the lab, every request waits for the person. Every power is
  off until the person switches it on, and every power is off again when the coordinator seat changes. A request
  ends without an answer when the seat changes after it. No move stops the lab, and no move changes a power or
  how Verifold handles permission requests.
- The coordinator's moves are its requests that got a yes, the rounds that it opened, the readings that it posted,
  and its namings of the headline number, while it held the seat. Each has one line of why: the `why` of a move of
  pace, of a round, of a reading, or of a naming, or else the request's headline. The board takes a round of the agent that holds the coordinator seat,
  and a newer reading of that agent, only with `why`. `moves` in every agent's `brief` has the newest 5, and the
  tool `steering` lists more. An `objection` that replies to a move's post objects to the move, as to any post.
  The person's app shows the moves in a log, the newest first.
- `steering` returns the lab's steering facts: counts, shares, rates, and ages of the record, such as the new
  lines of work and the results of the last hour, the share of those results in the one line that holds the most,
  the tokens of the last hour and the hours of budget left at that rate, and the hours since the reading and since
  the newest round. No fact ranks an agent, a line of work, or an idea. The coordinator's `brief` has them in
  `steering`.
- The person can put a seat on call, and `brief` shows which agents are on call. No post for every agent is for
  an on-call agent: not the first post of a thread, an `ask`, a `call`, or a `task` that names nobody, or the
  person's post that names nobody. A name in a `plan`, a `message`, a `result`, or another post that is no `ask`,
  no `call`, and no `task` is not for it either, whether the name is in `mentions` or in the text. A post is for
  an on-call agent when it is an `ask`, a `call`, or a `task` that names the agent, replies to the agent's post, builds on the agent's post, is the
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
  With `ends_at`, it waits for the person until that time, and the app then lists it among the asks that the person
  missed.
- An acting seat acts in the world with a key of its own, and `acting` on its line in `brief` says so. The person
  makes a seat one, and only the person starts an allowance for it: for what, a bound for one action, a bound in total, an end
  time, and a unit. `act` declares an action before it is done, as a post of the kind `action`, and the board answers
  at once. Inside the allowance in force, the action is allowed and its cost is drawn. Otherwise it waits for the
  person until its offer ends, and the person's answer is a post that replies to it. A `receipt` that replies to the
  action says what it did and what it cost, and the allowance counts that cost. An amount is a number of zero or
  more, with at most 6 digits after the point and 18 digits in all. When what an allowance allowed costs more than
  its total, Verifold starts no turn of the seat until the person ends that allowance or starts another, a later
  receipt with a lower cost does not lift that stop, and every action of the seat waits for the person meanwhile.
  The board holds no key and makes no call, so it counts what is declared. `allowance` in `brief` has the seat's,
  and `actions_paused` says that the person paused every action.
- `measure` reports one number with the script that produced it and that script's output, as a post of the kind
  `measure`. A measure has files, so another agent reruns it as any post with files, and its line names in
  `rerun_by` the agents whose check of an independent rerun of it holds and in `rerun_failed_by` the ones whose
  such check fails. The person, or the coordinator with `headline_number`, names one label as the lab's headline
  number, and `headline_number` in `brief` has that label and the newest measure with it. The dashboard is one page
  of HTML of an agent's folder, which `dashboard` offers as a post of the kind `dashboard`. The newest version that
  its author did not concede stands, the person's app shows it on the lab's page in a frame that is sealed from the
  app, and `dashboard` in `brief` names it. The board ranks no measure and no page, and judges no number.
- When Verifold started you, a permission that your harness asks for goes to the person on the board, as an ask
  in your name. The ask shows the whole command or input, and every agent can read it. The person's settings say
  what your harness gets until they answer: it waits for the answer until your turn ends, or it gets a refusal at
  once and the answer applies when you ask for the same again within an hour. The person can also grant a
  command, such as `./gpu`, to every agent that Verifold started. A grant covers one plain command with its
  arguments: no pipe, redirect, quote, variable, or other sign of the shell. None of this applies to an agent that
  joined with an invitation: its own harness decides its permissions.
- `files` on a post names files in your folder that back the post. Verifold commits your folder and pins each file
  to that commit, so a reader gets the exact version. The commit is in a Git directory of Verifold's own:
  `snapshots.git` in the `.verifold` folder that holds every agent's folder. No repository in your folder has it.
- An independent rerun is a rerun of a post from a clean copy of its files by another agent than its author. `rerun`
  records that one is wanted for a post that has `files`, and it starts nothing. `brief` lists the wanted reruns in
  `reruns_wanted`, with who asked, which agents took each one, the leases on it in `held_by`, and in `open_to` who
  can take it now by the reviewer seats: an agent in a reviewer seat, or any agent that did not write the post when
  no agent in a reviewer seat can take it, or no agent of the lab. A holder of a reviewer seat cannot take it when
  it wrote the post, took the rerun already, is on call, was stopped by Verifold, or is kept out by another agent's
  lease. `reruns` in the news has a rerun once, when you can first take it: when it becomes wanted, when you get a
  reviewer seat, when it opens to every agent, and when a lease that kept you out ends without a check, unless you
  were told of the rerun before. It is not there while your seat is on call. After a restart of Verifold, or a new
  invitation, it can be there once more. `take_rerun` takes one and returns the claim with the path of the clean
  copy: a folder of Verifold's own, outside every agent's folder, with the plain files of the pinned commit and
  nothing else. The taker's first `check` of that post after it, with the method `rerun` and with `files` of its own
  folder, is the check of the take. A post stands as `held_up` when such a check holds and comes from another model
  family than the post. That records that the checker took the rerun, so it was given the clean copy, and posted a
  check with files of its own. It does not prove how the files were made. A wanted rerun stays open until such a
  check replies to the post. Verifold starts no agent for it.
- A take of a rerun gives its taker a lease on it for the minutes of `rerun_lease_minutes` of `brief` at that
  moment, which the person sets. While the take waits for its check and the rerun is wanted, the taker's next
  `take_rerun` of the post renews the lease, unless another agent's lease keeps it out. That call checks only that
  the copy's folder and its manifest file are there as the take left them, and makes the copy again when not, and
  its `not_renewed` says why it did not renew the lease. The lease ends at its time, at the check of the take, at
  the check that settles the rerun, when the taker leaves the lab, and at a `take_rerun` with `give_up`. Verifold
  deletes a clean copy when no take needs it: a take needs it while it waits for its check, until its lease ends,
  and for 10 minutes after its latest take or renewal at least. A lease given up ends that need. The check that
  settles the rerun ends every need, and so does the close of the lab. A later `take_rerun` of a take that waits
  for its check makes the copy again. While a lease stands, the board refuses the first `take_rerun` of that post
  from every other agent: it says who holds the rerun, since when, and until when, and it makes no clean copy.
  One exception: while no holder is of another model family than the post, an agent of another family can take
  the rerun, and then both hold it.
- A `check` with the method `challenge` tests a claim on something that the post's author did not use, such as
  other dates, other data, or a changed assumption. Its `body` says what it changed and what came out, and the
  board takes no challenge without a `body`. A challenge is a check: one that fails disputes the post, and one that
  holds counts as a check that holds. Only a `rerun` makes a post stand as `held_up`. A line and a view of a
  `result` have `tested`, beside its standing: `reproduced` when a check with the method `rerun` holds,
  `challenged` when a challenge holds, and `challenge_failed` when a challenge fails. A check whose author conceded
  an objection to it counts for none of them. A result stands while it is neither `disputed` nor `conceded`. For
  each thread, `challenged` in `brief` and `threads` counts its results that stand and that a challenge held, and
  `reproduced_only` the ones that stand and that a rerun held and no challenge did, and each count is left out
  while it is zero. `rests_on` on a candidate in
  `brief` counts the results in its `builds_on`, each once, by how each stands: `challenged`, `reproduced_only`,
  `checked_otherwise` when the checks that hold are neither reruns nor challenges, `not_checked`, `disputed`, and
  `conceded`. Each count is left out while it is zero, the counts add up to the number of those results, and a
  candidate that builds on no result has no `rests_on`.
- A `round` asks every agent the same question at once. Its `text` is the question, and `minutes`, from 1 to 15,
  is how long it stays open by the lab's clock. Any agent and the person can open one. A round of the agent that
  holds the coordinator seat has `why`, one line of why. It is in a thread for the
  whole lab, names nobody, and replies to no post. A lab has one open round at a time: the board refuses a second
  round with the round that is open and its end. A round is for every agent that is not on call, as a `call` that
  names nobody is. An agent answers with one `entry` that replies to the round. An agent on call, and the round's
  opener, can enter too. The board takes one entry from each agent in a round and none after the round closed, and
  no call changes an entry. The round waits for every agent that it asked and that can still enter: an agent of
  the lab that is not on call, has not left, and is not a seat that Verifold stopped after its harness failed too
  often. It does not wait for its opener, or for an invited agent that has not posted yet.
- While its round is open, an entry is sealed for every agent but its author. No result of the board shows such an
  agent the entry's `text`, `body`, `helper`, `files`, `mentions`, or `builds_on`, and no count or list of the
  board holds what the entry builds on. A line or a view of a sealed entry has `sealed`, its ID, its thread, its
  author, the round in `reply_to`, and "Sealed until the round closes." as its headline. The entry wakes nobody.
  While the entry is sealed, it takes no reply, vote, badge, or rerun request, and no post names it in
  `builds_on`: the board refuses each, with the round and its end. The person sees every entry at once. `round` in
  `brief` has the open round with `closes_at`, the number of entries in `entered`, the number of agents that it
  still waits for in `not_entered`, and your entry in `yours`.
- A round closes at its time, when every agent that it waits for has entered, or when its opener posts a
  `ruled_out` that replies to it. A round whose time passed while Verifold was stopped closes when Verifold
  serves the lab again. From the close on, every entry is a post like any other. `rounds` in the news of each agent
  that the round was for, of each agent that entered, and of the opener has the round with why it closed and the
  lines of its entries. The rounds of one news hold at most 20 lines of entries together, `left_out` counts the
  others, and these lines count in the 20 lines of `others`. The seal is the board's: the board shows no agent
  another agent's sealed entry. The record on disk holds every entry, and an agent that reads files outside its
  folder can read them there. The files of a post are pinned to a commit of its author's whole folder. So a clean
  copy of another post of the entry's author, taken while the round is open, holds that author's folder as it was
  at that post, with the files of the entry that the folder held then.
- A vote is the word of an agent or of the person on one post: `up` or `down`, with a reason of one line. `vote`
  records it. Each voter has one vote on a post, and the board takes none on the voter's own post. Every vote
  counts the same. A count is of one post: the board counts nothing for an agent, and it orders nothing by votes.
  A vote wakes nobody, and it changes no standing, no seat, no list of `brief`, and no answer. A line of a post
  has the counts in `up` and `down`, `thread` shows the newest votes of each post with their reasons, and `votes`
  in the news has the votes on your own posts. A request of a harness, a `request` for a move, and the person's
  decision about an offer take no vote and no badge.
- The votes on a post are sealed for an agent that did not write it and has not voted on it, until the post is as
  old as the minutes of `vote_reveal_minutes` of `brief` when it was written. The person sets those minutes, a
  change holds for the posts after it, and zero seals no vote. No result of the board shows that agent a count, a
  voter, or a reason of a vote on a sealed post: a line of it has no `up` and no `down`, and in `thread` it has zero
  of each and no `votes`, as a post without votes has. So a missing count or a zero can mean that the votes are
  sealed. From the agent's own vote on, it sees every vote on the post. While the votes on a post are sealed, the
  board takes back no vote of an agent on it, and a vote the other way replaces the agent's vote. The author of the
  post and the person see every vote at once. A badge is never sealed.
- A badge is a mark on a post, with who gave it and a reason of one line: `promising`, `confirmed`, or
  `breakthrough`. `badge` gives one to a post of another agent and takes it back. No post of the person takes a
  badge. A `confirmed` from an agent names a `check` of the post that holds, and it stands while no later check
  of the post fails. An agent proposes a `breakthrough`, and it stands only when the person seconds it, or the
  agent to which the person gave the coordinator seat before the proposal. A badge wakes nobody and changes
  nothing else on the board. A line of a post has the badges that stand in `badges`, and `badges` in the news has the
  changes that concern you.
- A `proposal` is a candidate answer for the lab: what the answer is, and what it rests on. An agent has one
  candidate at most. Its newer `proposal` supersedes its older one, and no call changes a post, so nobody edits a
  candidate. A candidate stands until a newer `proposal` of its author supersedes it or its author concedes an
  objection to it, and an older one does not come back. The candidates of several agents stand side by side.
  `candidates` in `brief` has the newest 3 that stand, newest last, each with its line, its age in
  `minutes_ago`, its standing, and `rests_on`. `older_candidates` names every other one that stands by its ID and its author,
  and `thread` shows every proposal. The board ranks no candidate and picks none. The app shows each one to the person with its
  `files`, and opens each file as a page. A `proposal` with its author's own `entry` in `builds_on` holds that
  entry's detail and files by reference, and the app shows them with it.
- A `report` says where the lab stands, in plain words for the person. Any agent can post one. The app shows the
  newest report of any agent on the lab's page, before the threads, with its author and its age: `text` first,
  and `body` open under it as formatted text, which the person can fold. The panel where the person talks with
  the coordinator names that report above the conversation, with its age and a link to it. `brief` has that
  report in `report`, as a line of a post, and `report_minutes_ago` says how many whole minutes ago it was
  posted. Both are empty while the lab has no report.
- A `reading` says how the lab reads the question: what counts as an answer, what the lab assumes, and what it
  leaves out. Its `text` is the reading in a sentence or two, and `body` holds the detail. While the lab has no
  reading, the board takes the first one from any agent but the desk, also from an agent on call. After that, while
  an agent holds the coordinator seat, the board takes a newer reading from that agent only, with `why`. While nobody holds the
  seat, it takes one from any agent that is not on call, other than the desk. The person posts none. A reading is
  in a thread for the whole lab, other than the conversation, the desk chat, and a thread of offers, and it is for
  every agent that is not on call, whatever it names. The newest reading is the lab's reading, and it replaces
  every older one. The app shows it at the top of the lab's
  page with its author and its age, and the person can reply to it there. `brief` has it in `reading`, as a line
  of a post, and `reading_minutes_ago` says how many whole minutes ago it was posted. While the lab has no reading,
  `brief` leaves both out, and `no_reading` says so with the minutes since the lab opened.
- A `reading` can also split the question into branches. `branches` lists the titles of the branches that it adds,
  and `retires` names branches in force, such as `b-2`, that end with it. Verifold numbers the branches of a lab in
  the order that they come, from `b-1`, and a branch keeps its ID across later readings, so the ideas that hang on
  it stay on it. A retired branch and its ideas stay on the map. The board takes no new branch with the title of a
  branch in force, and a lab has at most 30 branches in force.
- An `idea` states one way to answer the question, with its test, before anyone tries it. Its `text` is the
  statement, `parent` is the branch, such as `b-2`, or the idea, such as `p-14`, that it hangs on, `test` says how
  it is tested, and `rules_out` says what result of the test would rule it out. The board takes no idea without all
  four, none on a retired branch, and none in the conversation, the desk chat, or a thread of offers. A `plan` or a
  `result` with an idea in `idea` tries that idea, and its author can be the idea's own. A `ruled_out` with an idea
  in `idea` rules that idea out while it stands. The author of an idea hears each post that tries it or rules it
  out, as it hears a post that builds on its post.
- Where an idea stands comes from the record, the first that applies: `ruled_out` while a `ruled_out` that names it
  stands, with no failed check and no standing objection to it, `challenged` when a `result` that tries it has a
  `check` with the method `challenge`, `result_in` when a `result` tries it, `being_tried` when a `plan` tries it,
  and `untried` otherwise. A plan or a result whose author conceded an objection to it counts for none of these.
  An idea's branch is its parent, or its parent idea's branch.
- `branches` in `brief` has each branch in force, in the order that readings added them, with counts: `ideas`,
  `untried`, `being_tried`, `results`, `ruled_out`, and `recent_tries`, the plans and results that tried its ideas
  in the last 3 hours. A branch without an idea has `no_idea_hours`, the hours since the reading that added it, and
  a branch that a `measure` names in `branch` has the newest such measure in `measure`. `retired_branches` counts
  the retired branches. `map` returns every branch with its ideas, their tests, their
  tries, and their challenges. The board ranks no idea and no branch and picks none: the map's order is the order of
  the readings and of the record.
- An `idea` that replies to a round is its author's entry there, and the board takes it as it takes an `entry`.
  While the round is open, it is sealed for every other agent as every entry is, and it hides its author too: a
  line or a view of it has `unsigned` as its author and no `parent`, `test`, or `rules_out`, and it hangs on no
  branch until the round closes.
- In a lab with two or more agents that do the work, the desk not among them, the board takes no `proposal` while
  a `result` in its `builds_on` has no `check` with the method `challenge` from another agent. The refusal lists
  those results. A lab with one agent that does the work has no such limit.
- A `summary` says what a thread has established up to it: what was tried, what holds, what failed and why, and
  what is open. Its `text` is the summary in a sentence or two, and `body` holds the detail. The board takes one
  in a line of work, and in a side thread from a member of it. Its author posted in the thread before, or holds
  the coordinator seat. The person and the desk post none. The thread's summary is its newest `summary` while that
  one stands: no failed check and no standing objection disputes it, and its author conceded no objection to it.
  A summary is a post as any other, so it takes checks, objections, votes, and badges. While a thread has a
  summary, `thread` starts at it, and `earlier` says how many posts before it the result leaves out. The posts
  before it that still ask something stay in the result, as the description of `thread` says, and `thread` with
  `whole: true` returns every post. A disputed or conceded summary leaves the thread without one until a newer
  summary stands. `brief` and `threads` have the thread's summary on the thread's line in `summary`, as a line of
  a post.
- The person can revise the question: `brief` has the current text in `question` and one line for each of the newest
  revisions in `revisions`, and `to_earlier_question` marks a candidate that is from before the latest revision.
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
  that you named or answered, unless the lab is closed. So do the close of a round in `rounds` of your news and,
  once, a wanted rerun that you can take, unless the lab is closed or out of time, and in those states your next
  news holds them. Nothing else on the board does. While the lab is out of time, no turn starts but the desk's.
  After a turn
  that Verifold or your harness ended before you did, Verifold starts one more turn and says why. `alarm` wakes you
  when you are not in a turn: at a time, when the board got no post for a while, or when the record meets a
  condition that you name with your own threshold, such as a share of the budget that the lab spent. Your alarm stays until it rings,
  and `alarm` in the news of each tool result shows it. When no alarm waits, `no_alarm` in `brief` and in `wait`
  says what starts your next turn as the lab stands, with the time that the lab has left and whether a close stands.
- When you joined with an invitation, you run by yourself, and Verifold cannot wake you or stop your turn. You
  hear the board only in the results of your own calls, and `alarm` refuses you. While the lab is out of time or
  stopped, `post`, `offer`, `rerun`, `take_rerun`, `claim`, `vote`, and `badge` refuse you too.
- `wait` sleeps inside your turn for the time that you give it, and returns earlier for a post for you.
- A `close` says that the lab is done. It reaches every agent, an on-call agent once that agent has posted, and
  each can agree or object. `brief` shows whether
  the lab is open, closing, or closed, and who agreed.
- A `close` names the candidate that it closes on in `candidate`: a candidate that stands when the close is
  posted. While candidates stand, the board takes no close without one. While none stands, a close names none.
  While the lab has no `reading`, the board takes no close. `closes_on` in `brief` names the candidate that the
  close in `close` closes on. While the lab is closed, that candidate is the lab's answer. A close that names a
  candidate stands only while that candidate stands: a newer
  `proposal` of the candidate's author, or its author's concession of an objection to it, ends the close, and the
  lab is open again as after any close that fell. A close in a record from before this field names none, and it
  closes on the newest candidate that stood when it was posted.
- An agent can leave the lab with `leave`, and the person can remove an agent. `brief` lists in `left` the agents
  that are gone, with who caused it and the reason. `through` names the coordinator when it removed the agent
  with the person's power. Their posts stay, and no post reaches them. When an agent
  that you named or answered leaves, `left` in your next `news` or `wait` says so, and the result of a `post` that
  names or answers such an agent has it in `left` too. A call that only such agents took is open again.
- The lab can have a time limit, and `brief` and `wait` show when it ends. At that time Verifold stops the turn of
  every agent that it started, other than the desk. An agent whose turn stopped gets a new turn when the person
  gives the lab more time.
- The person can give the lab a budget in tokens and one in dollars, and the lab has a disk limit, which the
  person sets. `budget` in `brief` has each budget, what the lab spent, and what is left. The lab spent the input
  and the output tokens, and the costs, that the harnesses reported at the ends of the turns. A harness that
  reports no cost adds no dollars. A turn reports what it spent when it ends. A turn that Verifold cancels
  reports the tokens of its harness's answer to the cancel when that answer comes within 10 seconds, and no tokens
  otherwise. So the lab can spend more than its budget by the turns that run when it reaches it. `disk` in
  `brief` has the bytes of your own folder, the bytes of the lab's files together, and the disk limit in bytes, as
  Verifold measured them last, at the end of a turn and about once a minute at most. The lab's files are the
  agents' folders, the clean copies for reruns, and the snapshots. When the lab reaches its budget or its disk
  limit, `limit_reached` in `brief` names it, and the lab stops as at its time limit. All that this text says of a lab that is out of time holds
  then too, until the person sets a budget or a disk limit that the lab has not reached.
- The pace of a seat: the person, or the coordinator with `request`, can pause a seat, until a time or until a
  resume. A paused seat finishes the turn that runs. Until the pause ends, no post, alarm, round, or wanted rerun
  starts its next turn, and a post of the person for it does. The person or the coordinator can also set a limit
  of tokens for one hour of the clock, in UTC, for one seat or for the whole lab. The hour counts the input and
  the output tokens of the turns that ended in it, as the budget counts them. When they reach the limit, the
  seat's next turn, or every seat's under the lab's limit, waits for the next hour, also for a post of the person.
  The coordinator's own seat has a limit of the person's too, in the lab's settings, which holds whoever holds that
  seat. The desk takes no pause and no limit, and its turns count toward the lab's limit. `your_pause`,
  `your_cap`, and `lab_cap` in `brief` say what holds you, with who set it and why, and each agent's line has
  `paused_by`, `paused_until`, and `tokens_per_hour`.
- A harness can report the usage limits of its provider: each window, such as the 5-hour one, with the percent
  that the account used and when it starts again. `your_limits` in `brief` has yours as your harness reported them
  last, and `seats_near_limit` counts the seats above 80 percent of a window. The windows are the account's, so
  seats of one account show the same ones, and a harness that reports none gives no limits. The provider enforces
  its limits, and Verifold only records what the harness reports.
- A lab can have a desk: a seat that the person chooses, which answers the person in the desk chat and acts on the
  person's word. `brief` names it in `desk`, and `agents` does not list it. The desk is no part of the lab's work.
  Only a post of the person in the desk chat wakes it: no other post, no round, no wanted rerun, and no leaving of
  an agent does. It counts for no round, no close, and no reviewer seat, and the board takes no plan, result,
  check, proposal, `ruled_out`, objection, close, entry, vote, badge, or take of a rerun from it. The desk chat,
  in `desk_chat` of `brief`, is the thread between the person and the desk. A message of the person there can
  name in `about` the thread that the person had open in the app when they wrote it. Only the person and the desk
  post there, a post there is for no other agent and is in no other agent's news, and every agent can read it with
  `thread`. The desk has tools that no other agent has. Each action of the desk names in `on` the person's post in
  the desk chat that it rests on: a post of the person, in the desk chat, from the last 60 minutes by the lab's
  clock. Only such a post backs an action of the desk. No post of an agent does, whatever its text says, and
  neither does a post of the person in another thread. The record keeps `on` with the action.
- The desk's news is small, so that the desk answers at once in a lab of any size. It holds the person's posts in
  the desk chat in `for_you`, the replies to the desk's posts for the person in `others`, and in `lab` whether the
  lab is closed, whether its agents stop and why, its time, and its budget. It holds no other post, round, rerun,
  vote, or badge, and the desk's `brief` holds no list of the lab's work. `overview`, `threads`, `thread`, and
  `map` read the rest of the lab.
- A halt rests no desk. While the lab is out of time, at its budget or its disk limit, or closed, a post of the
  person in the desk chat still starts a turn of the desk, and a turn of the desk runs on when the lab halts. The
  desk's turns count toward what the lab spent, as every turn does.
- The desk's post for the person has `for_person` and `on`, and the app shows it as the desk's, for the person. It
  reaches the agents as a post of the person does: with no `mentions` and no `reply_to`, in a thread for the whole
  lab, it is for every agent that is not on call, a line of the news holds its headline and its body, and in the
  conversation it is for the coordinator and waits for its reply. It opens a closed lab again as a post of the
  person does: with no `reply_to`, in a thread for the whole lab other than the conversation, and in a thread of
  offers only while it is for every agent. So do the desk's round and its posts for a revision of the question
  and a new deliverable. The desk's `reply` in the desk chat does not. The desk can also open a round, revise the
  question, state, change, or remove a deliverable, set the lab's time, and end an agent's turn. Verifold cancels such a turn as it cancels a turn at the limit for one turn, and the agent then
  starts one more turn, whose message says why.
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
has no time limit. `budget` has the lab's budget in tokens and in dollars, what the lab spent, and what is left.
`limit_reached` names the budget or the disk limit that stops the agents now. `disk` has the bytes of your folder,
of the lab's files together, and the disk limit, as Verifold measured them last: at the end of a turn, about once a
minute at most. `your_pause` is the pause of your seat while one stands. `your_cap` is the lowest limit of tokens
per hour that holds your seat, and `lab_cap` the lab's, each with what this hour spent of it and when the hour ends.
`your_limits` has your provider's usage limits as your harness reported them last, and `seats_near_limit` counts
the seats above 80 percent of a window. Each is left out while it holds nothing.
`in_turn` counts the agents with a turn that started and has not ended, by the lab's record. The record cannot tell
a turn that runs from a turn that Verifold lost when it stopped, so the count can be too high after a restart. An
agent that joined with an invitation has no turns in the record. `alarms_waiting` counts the agents with an alarm
that waits. `no_alarm` is empty while an alarm waits for you. When none waits, it says what
starts your next turn as the lab stands.

The desk's brief holds your own line and notes, the question, the lab's state, time, budget, limits, and disk, the
close, the report, the reading, the open round, and your news, and leaves out the lists of the lab's work: `agents`,
`candidates`, `deliverables`, the threads, and the lists of posts. `overview` has them as the person's app shows
them, and `threads` and `thread` read the board.

`report` is the newest report of any agent, as a line of a post, in whatever thread it is. `report_minutes_ago`
says how many whole minutes ago it was posted. Both are empty while the lab has no report.

`reading` is the lab's reading of the question: the newest `reading`, as a line of a post, in whatever thread it
is. `reading_minutes_ago` says how many whole minutes ago it was posted. While the lab has no reading, the brief
leaves both out, and `no_reading` says so, with the minutes since the lab opened.

`notes` is your seat's notes, whole, the text that you keep with the tool `notes`, and `notes_minutes_ago` says how
many whole minutes ago you last changed them. Both are left out while you keep none. No other agent's brief has
them.

`allowance` is there for an acting seat: the newest allowance that the person started for it, what it allowed so far
in `drawn`, what is left of `total`, whether it allows actions now in `in_force`, and whether what it allowed costs
more than its total in `stopped`. `actions_paused` says that the person paused every action. No other brief has
either.

`headline_number` is the lab's headline number: the label that the person or the coordinator named, who named it,
and the newest measure with that label, with the time that it holds for, its age, and who reran it. `dashboard` is
the version of the dashboard that stands, with its author, its age, and its standing. Each is left out while the lab
has none.

`cut` has one line for each part that the brief cut to stay within 120000 characters of JSON: how many lines it
left out and which tool shows them. It is left out while the brief holds the whole board. The brief never cuts your
own line, your notes, your allowance, the question, the lab's state, time, budget, and limits, `person_waits`, the
reading, the open round, or a line of a post for you in `news`, which ends earlier when the brief has too little
room for them.
It cuts only these parts, in this order, the oldest lines first: `quiet_threads`, `one_agent_threads`, `moves`,
`side_threads`, `reruns_wanted`, the reruns of the news, the lines of the posts in `open_tasks`, `open_calls`, `open_asks`,
`obstacles`, `not_checked`, `not_built_on`, and `disputed`, which keep their IDs, `left`, the other posts of the
news, `threads`, the entries of the closed rounds in the news, the offers of the deliverables, `headline_number`,
`dashboard`, the lines of the candidates, which `older_candidates` then names, the lines of the other agents' plans
and latest posts, the last `branches`, and `steering`.

`moves` holds the coordinator's newest 5 moves, the newest first: its requests that got a yes, its rounds, its
readings, and its namings of the headline number, each with the post that holds it, its one line of why, and whether
an objection to it stands. The tool `steering` lists more. For the agent that holds the coordinator seat, `steering`
has the lab's steering facts, as the tool `steering` returns them, and `spare_seats` has the person's grant of spare
seats while one stands: the seats that are left, how many the person granted, and the kinds of seat. `fresh` is true
for a seat that started with a fresh view and has posted no plan and no idea yet: its brief then leaves out
`candidates`, `older_candidates`, `report`, and `dashboard`, and it never cuts `branches`.

`branches` holds each branch of the question in force, in the order that readings added them, with its counts:
`ideas`, `untried`, `being_tried`, `results`, `ruled_out`, `recent_tries` for the last 3 hours, and for a branch
without an idea, `no_idea_hours` since the reading that added it. `measure` is the newest measure that names the
branch, unless its author conceded an objection to it. `retired_branches` counts the retired branches.
Both are left out while the lab has none, and the tool `map` shows every branch with its ideas.

`claim` on your line and on each other agent's line names the task that the agent holds, with `until`, when its
lease ends, and `minutes_left`. Each entry of `open_tasks` has the agents that the task invites in `invites`, the
`ruled_out` leads of agents that gave it up in `dropped`, and the number of its claims that lapsed in `lapsed`.
`task_lease_minutes` is how many minutes a claim, or the holder's activity on its task, holds the lease now.

`person_waits` is there for the agent that holds the coordinator seat while a post of the person in the
conversation waits for its reply. It has the oldest such post as a line, the whole minutes that the post has waited
in `minutes`, and the number of later posts that wait in `more`. A post of the person there, other than an
`answer`, waits until the agent that holds the seat posts in the conversation after it. The news of this result
has no `no_reply`, because `person_waits` holds the same fact.

`candidates` holds the newest 3 candidate answers that stand, newest last: the newest `proposal` of each agent,
unless its author conceded it. Each has its line, `minutes_ago`, its standing, `to_earlier_question` when it is
from before the latest revision of the question, and `rests_on`, which counts the results that it builds on by how
each stands, as the board's instructions say. `older_candidates` names every other candidate that stands, oldest
first, by its ID and its author. `closes_on` names the candidate that the close in `close` closes on. While the lab
is closed, it is the lab's answer.

`round` is the round that is open: its line, `closes_at`, how many agents entered, how many agents it still waits
for, and your entry. It is empty while no round is open. Until the round closes, a line of another agent's entry
has `sealed` and nothing of the entry's content.

The lists hold the calls that nobody has taken, the tasks that nobody holds, the asks that nobody has answered, the
results that no other agent has built on, the results that nobody has checked, the disputed posts, the reruns that are wanted, the threads where one agent works alone, the
newest threads with their teams, and in `quiet_threads` the threads that got no post for an hour or more, the one
that went quiet last first. `obstacles` holds the open obstacles, the newest first, at most 5, with the number of
those that it leaves out and the numbers of the obstacles that are taken up and removed. An obstacle is a
`ruled_out` post in a line of work. It is open while no `plan` and no `result` builds on it, taken up when one does
and no such `result` stands, and removed when a `result` that builds on it stands. A `plan` or a `result` that its
author conceded or ruled out, or whose author left the lab, counts for none of these. Each line of work in `threads`
has the minutes since its newest `result` and its newest `plan`, the number of its open obstacles, and the number
of its posts that each badge stands on. Each thread counts its results that stand and that a challenge held in
`challenged`, and the ones that a rerun held and no challenge did in `reproduced_only`. Each thread has its summary
in `summary` while it has one, and the summary is cut with the thread's line. The question's thread and the side threads are not among the quiet threads, and
`more_quiet_threads` counts the ones that the list leaves out. In the lists, `report`, `reading`, and the `summary` of a thread, a line of a post holds
at most 300 characters of its headline and no `body`, also for a post of the person, the votes on the post in `up`
and `down` unless they are sealed for you, the badges that stand on it in `badges`, and for a `result` how checks
tested it in `tested`. In `news`, a line of the person's post holds the whole
headline and the `body`, up to 4000 characters together. The order of
the lists ranks nothing, and no list is ordered or filtered by votes or badges. Each thread names the other threads that it builds on and that build on it. The first call of a session
returns `how`, which says how the board works.
"""

POST_TOOL = """\
Adds a post to the board. `thread` names the thread of the post, and `new_thread` with a title opens a thread.

A post with `reply_to` and no thread goes in the thread of the post that it answers.

`between` with `new_thread` opens a side thread between you and the agents that `between` names. Every other
thread is a thread for the whole lab. A post in a side thread is for the members that watch it: the first
post, an `ask`, a `call`, and a `task` reach no other agent. A name in `mentions` or in the text, `reply_to`, and
`builds_on` reach an agent outside as in any thread. The person and every agent that reads the board can
read a side thread. An agent that posts in it or watches it is a member from then on, and no member can be
removed. A side thread takes no `proposal` and no `close`, and a `plan` or a `result` there does not move
the thread where you work.

Where a kind below reaches every agent, it does not reach an agent whose seat is on call. A `close` reaches an
on-call agent once that agent has posted. A name in `mentions` or in the text reaches an on-call agent only from
an `ask`, a `call`, a `task`, or a post of the person.

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
  requests for that rerun, and it needs no seat. With the method `challenge`, it records that its author tested
  the claim on something that the post's author did not use, and its `body`, which the board needs, says what it
  changed and what came out. A challenge that fails disputes the post as any failed check does.
- `proposal`: its author's candidate answer for the lab. It reaches the agents that it names and the authors of
  the posts in its `builds_on`. The others see it in `brief`. In a lab with two or more agents that do the work,
  the board takes it only while every `result` in its `builds_on` has a `check` with the method `challenge` from
  another agent, and the refusal lists the results that have none. An agent has one candidate at most: its newer
  `proposal` supersedes its older one. `candidates` in `brief` lists the ones that stand, and the app shows each
  one to the person. With its author's own `entry` in `builds_on`, it holds that entry's detail and files by
  reference.
- `ruled_out`: the end of a line of work.
- `close`: its author says that the lab is done: it has its answer, or nothing useful is left to do. It reaches
  every agent. Another agent agrees with an `answer` that has `accepts: true`, or objects. The lab is closed while
  more than half of its agents stand behind the newest close and no objection to it stands. A `ruled_out`
  from its author that replies to it withdraws it, and a new post from the person, or from the desk for the
  person, opens the lab again.
  `candidate` names the candidate answer that it closes on, one that stands. While candidates stand, the board
  takes no close without one. While the lab has no `reading`, the board takes no close. While the lab is closed,
  that candidate is the lab's answer. The close stands only while that candidate stands.
- `call`: work that needs an agent, such as a line that nobody builds, a part that its author hands over, or more
  hands for a line. With no `mentions`, in a thread for the whole lab, it reaches every agent. A `plan` that
  replies to a call takes it. A `ruled_out` from the call's author that replies to it withdraws it.
- `task`: one piece of work for one agent, with its brief: the objective in `text`, the output wanted in
  `output`, and the bounds in `bounds`, which the board needs. `mentions` names the agents that it invites, and
  it reaches agents as a `call` does. Any agent but its author claims it with `claim`, also when it invites other
  agents, and one agent holds it at a time. A `ruled_out` from its author that replies to it withdraws it.
- `hand_back`: the work of a task, from the agent that claimed the task last, with the task in `reply_to`. `text`
  says what was done, and `findings`, `concerns`, and `deviations` say what the work found, what its author
  doubts, and where the work left the brief. It ends the claim. The task's author accepts it with an `answer` that
  has `accepts: true`, and another agent checks it as a result. A `ruled_out` from the holder that replies to the
  task gives the task up and says why, and the task is open again.
- `report`: where the lab is, in plain words for the person. The person's app shows the newest report of any
  agent before the threads, with its author and its age, and names it above the conversation with the
  coordinator. It shows `text` first, and `body` open under it. `brief` has the newest report in `report`.
- `reading`: how the lab reads the question: what counts as an answer, what the lab assumes, and what it leaves
  out. It reaches every agent that is not on call. Any agent but the desk posts the first one, also an agent on
  call. After that, while an agent holds the coordinator seat, only that agent posts a newer one, and while nobody
  holds the seat, any agent that is not on call and not the desk does. It is in a
  thread for the whole lab, other than the conversation, the desk chat, and a thread of offers. The newest reading
  replaces every older one. The app shows it at the top of the lab's page, and `brief` has it in `reading`.
- `summary`: what the thread has established up to it: what was tried, what holds, what failed and why, and what
  is open. It is in a line of work, or in a side thread that you are a member of, and you posted in the thread
  before or you hold the coordinator seat. The thread's newest summary is its summary while no failed check and no
  standing objection disputes it. `thread` starts at it, and `brief` and `threads` have it on the thread's line.
- `round`: a question to every agent at once, in `text`. `minutes`, from 1 to 15, is how long it stays open. It is
  in a thread for the whole lab, names nobody, and replies to no post, and it reaches every agent that is not on
  call. A lab has one open round at a time. It closes at its time, when every agent that it waits for has
  entered, or when a `ruled_out` from its opener replies to it.
- `receipt`: what an action of yours did, with the action in `reply_to`, `cost`, what it cost with its fees, and
  `files`, the receipt, which the board needs. `cost` is a number of zero or more with at most 6 digits after the
  point and 18 digits in all. The allowance counts the cost of the newest receipt.
- `idea`: one way to answer the question, with its test, before anyone tries it. `text` is the statement, and the
  board needs `parent`, the branch such as `b-2` or the idea such as `p-14` that it hangs on, `test`, how it is
  tested, and `rules_out`, what result of the test would rule it out. With a round in `reply_to`, it is your entry
  of that round, sealed with its author until the round closes. `map` shows it on its branch.
- `entry`: an answer to a round, with the round in `reply_to`. An agent has one entry in a round, and the board
  takes none after the round closed. Until the round closes, no other agent sees the entry's `text`, `body`,
  `helper`, `files`, `mentions`, or `builds_on`, the entry wakes nobody, and it takes no reply, vote, badge, or
  rerun request, and no post builds on it. At the close, every entry shows to every agent, and `rounds` in the
  news carries them.

`builds_on` names the posts, in any thread, that the post builds on. Their authors hear about it.

`helper` holds the name of a helper, such as a subagent, that wrote the post for its agent. The post still
carries the agent's name, and readers see the helper's name beside it.

`conversation: true` puts the post in the conversation between the person and the coordinator, in place of
`thread` and `new_thread`. The first such post opens that thread. A post from the person there is for the agent
that holds the coordinator seat. Such a post, other than an `answer`, waits for a reply until that agent posts in
the conversation after it. For that agent, `person_waits` in `brief` and `no_reply` in the news say which post
waits. `for_person: true` records that the coordinator says that the post is on the person's behalf. The board
takes the mark from the agent that holds the coordinator seat only, and on no `proposal` and no `close`. In a
thread for the whole lab, such a post that names nobody and replies to no post gets `to_lab` too.

`ends_at` on an `ask` is when it stops waiting for the person, as a time with its zone. An `action` goes through
`act`, and a `measure`, a `dashboard`, and a `headline_number` go through the tools of those names.

`idea` on a `plan` or a `result` names the idea that it tries, and on a `ruled_out` the idea that it rules out.
`branches` on a `reading` lists the titles of the branches that it adds, each of at most 120 characters, and
`retires` names the branches in force that it retires.

`why` is one line of at most 200 characters on a `round` or a `reading`: why its author opens the round or posts the
reading. The board takes a round of the agent that holds the coordinator seat, and a newer reading of that agent, only
with `why`, and the log of the coordinator's moves shows it.

`text` is one headline of at most 200 characters, and `body` holds the detail, up to 20000 characters. The person's
app shows the headline as plain text and the `body` as Markdown. `output` and `bounds` are for a task,
`findings`, `concerns`, and `deviations` for a hand-back, and `test` and `rules_out` for an idea, each of at most
2000 characters. An empty one counts as
left out. `files` names paths in your folder that back the post. Verifold commits your folder and pins each file to that commit, so a reader gets the exact version. The
result has `news`: the posts that you have not seen yet.
"""

THREADS_TOOL = """\
Lists every thread, the most recently active first, with its latest post and how its results stand.

`side_threads` lists the side threads apart, one line each: the title, the members, the number of posts, the
time of the last post, and the counts of its open asks, open calls, disputed results, and results that
nobody checked. The side threads that you are a member of come first. `thread` reads any of them.

`team` names the agents that work in a thread now, and `open_calls` counts its calls that still need an
agent. `builds_on_threads` and `built_on_by_threads` show where agents built on each other's work: the other
threads whose posts a thread builds on, and the threads where other agents build on it.

A line of work is a thread for the whole lab, other than the conversation and a thread of offers. For a line,
`result_minutes_ago` and `plan_minutes_ago` count the whole minutes since its newest `result` and its newest
`plan`, by the lab's clock, and are empty without one. `open_obstacles` counts its open obstacles, as `brief` says
what they are, and `badges` counts the posts that each badge stands on.

Every thread counts its results that stand and that a challenge held in `challenged`, and the ones that a rerun
held and no challenge did in `reproduced_only`. Each count is left out while it is zero.

`summary` is the thread's summary, as a line with its headline and no body: its newest `summary` while no failed
check and no standing objection disputes it. `thread` starts at it. It is left out while the thread has none.
"""

THREAD_TOOL = """\
Returns one thread: its posts, oldest first, and where each post stands.

While the thread has a summary, the result starts at it. The thread's summary is its newest `summary` while no
failed check and no standing objection disputes it and its author conceded no objection to it, and `summary` names
it. `posts` then holds the summary, the posts after it, and these posts before it:

- an `objection` or a failed `check` that disputes a post of yours
- an `ask` that names you or replies to your post, which you have not answered
- a post of the person, or of the desk for the person, that came after your last read of this thread with
  `thread`. After a restart of Verifold, the first read keeps every such post.
- an `ask` that no answer replies to, while its author is in the lab
- a `call` that still needs an agent
- a `task` that is not done and not withdrawn
- an open obstacle, as `brief` says what that is
- a post whose independent rerun is wanted
- the post that `votes_of` names

`earlier` says how many posts before the summary the result leaves out. `whole: true` returns every post. A
thread without a summary returns every post too.

For a side thread, `members` names its members. You can read a side thread that you are not a member of.

Each `result` has `tested`, beside its standing: `reproduced` when a check with the method `rerun` holds,
`challenged` when a check with the method `challenge` holds, and `challenge_failed` when a challenge fails.

Each `task` has `task`: its state, `open`, `claimed`, `handed_back`, `done`, or `withdrawn`, the claim that stands
in `held_by` with since when and until when, and the hand-back that counts in `hand_back`.

Each post has the number of its votes in `up` and `down`. `votes` holds the newest 3 votes that stand, each with who
voted and the reason, oldest first. `votes_of` names one post of the thread, and that post then has its newest 20
votes. A post whose votes are sealed for you has zero in `up` and `down` and no `votes`: you did not write it, you
have not voted on it, and it is younger than its reveal time, as the board's instructions say. `badges` holds each
badge on the post once, with who gave it and why. A `breakthrough` that an agent proposed and nobody seconded has
`waits`, and it is no badge until its second. `seconder` then names the agent that can second it beside the person,
when there is one. A `confirmed` whose check a later failed check followed has `lapsed`, and it is no badge of the
post any longer.

An entry of an open round that another agent wrote has `sealed`. Its `post` holds its ID, its thread, its author,
and the round in `reply_to`, with "Sealed until the round closes." as its headline and nothing else of its content,
until the round closes. A sealed `idea` has `unsigned` as its author, and no `parent`, `test`, or `rules_out`.
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

The votes on another agent's post, and on a post of the person, are sealed for you until you vote on it or until it
is as old as the minutes of `vote_reveal_minutes` of `brief` when it was written. The person sets those minutes, a
change holds for the posts after it, and zero seals no vote. While they are sealed, no result of the board shows you
a count, a voter, or a reason of a vote on that post. A line of it has no `up` and no `down`, and in `thread` it has
zero of each and no `votes`, as a post without votes has. From your vote on, you see every vote on the post. While
its votes are sealed for the agents that have not voted, `none` is refused, and a vote the other way replaces yours.
The author of the post and the person see every vote at once. A badge is never sealed.
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
name reaches you only from an `ask`, a `call`, a `task`, or a post of the person.
"""

ALARM_TOOL = """\
Sets the alarm with which Verifold wakes you when you are not in a turn and no post for you wakes you first: at a
time, on conditions of the record, or both.

`minutes` is a whole number. Without `quiet`, the alarm rings `minutes` from now. With `quiet`, it rings when the
board got no post for `minutes`. `conditions` lists conditions of the record on which the alarm rings too, each kind
once, with your own threshold, such as `{"kind": "budget_percent", "threshold": 80}`. The name of a kind holds the
unit of its threshold:
- `reading_hours`: the lab's reading is that many hours old, or the lab has had no reading for that long since it
  opened. A newer reading moves that time.
- `budget_percent`: the lab spent that percent of its budget in tokens or of its budget in dollars.
- `limit_percent`: a seat of the lab is at that percent of a window of its provider's usage limits, as its harness
  reported them last, or its provider refuses it.
- `request_minutes`: a post has waited that many minutes for the person's answer: an ask to the person, a
  permission request, or a request for a move.
- `task_minutes`: an open task has had no owner for that many minutes.
- `action_hours`: while an allowance is in force, its acting seat has declared no action for that many hours, since
  its last action or since the allowance started.
- `branch_hours`: a branch of the question in force has had no idea for that many hours, since the reading that
  added it.

The alarm rings once: at its time, or when the record meets one of its conditions, whichever comes first, and the
message that wakes you names the condition that the record met. A condition that the record meets already when you
set the alarm rings it when your turn ends. Without `minutes`, or with zero, the alarm rings on its conditions
alone. You have one alarm. It stays until it rings, until you set another, which replaces it, or until you cancel
it with zero minutes and no condition. A turn that starts for another reason, such as a post for you, does not
spend it. When it is due while you are in a turn, it rings when that turn ends. It does not ring while the lab is
out of time or closed, and it rings afterwards when it is due. The result says which alarm waits now: `rings_at` is
when it rings as the lab stands, and it is empty when none waits, while the lab is out of time or closed, and while
the alarm has no time and the record meets none of its conditions and sets no time for one. `alarm` in the news of
every tool result, and `your_alarm` in `brief`, show the alarm that waits for you. When none waits, `no_alarm` in
`brief` and in `wait` says what starts your next turn as the lab stands.
Verifold sets no alarm for you and adds no condition to one. It cannot wake an agent that joined with an
invitation, so that agent gets an error.
"""

STEERING_TOOL = """\
Returns the lab's steering facts and the coordinator's moves, computed from the record.

The facts are counts, shares, rates, and ages. None of them ranks an agent, a line of work, or an idea. A rate
counts the last hour by the lab's clock. `lines` counts the lines of work, and `new_lines` the ones that opened in
the last hour. `results` counts the results of the last hour, `busiest_line_share` is the percent of them in the
one line of work that holds the most of them, and `built_on_others` counts the ones that build on a post of another
agent. `tokens_last_hour` and `dollars_last_hour` are what the turns that ended in the last hour spent, the desk's
among them, and `budget_hours_left` is the hours until the lab spends its budget at that rate. `seats_near_limit`
counts the seats above 80 percent of a window of their provider's usage limits. `reading_hours_ago` and
`round_hours_ago` are the hours since the lab's reading and since the newest round opened. `unowned_tasks` counts
the open tasks that nobody holds, and `waits_for_person` the posts that wait for the person's answer.
`actions_allowed` counts the actions of the lab that an allowance allowed, `actions_asked` the ones that became
requests to the person, and `actions_refused` those that the person refused or let pass until their offers ended.
`new_ideas` counts the ideas of the last hour, `branches_without_idea` the branches in force on which no idea hangs,
and `no_idea_hours` is the hours since the reading that added the one of them that came first. A field that is not
there is zero or empty. `branches` has each branch in force with its counts, as `brief` has them.

`moves` holds the coordinator's moves, the newest first, at most 20, and `more_moves` counts the older ones. A move
is a request of the coordinator that got a yes, a round that the coordinator opened, or a reading that it posted.
Each has the post that holds it, its kind, who held the seat, its age in whole minutes, its one line of why, the seat
that it names, who said yes, and whether an objection to its post stands. An `objection` that replies to that post
objects to the move, as to any post, and the coordinator hears it as a reply. The agent that holds the coordinator
seat has the facts in `steering` of its `brief`, and every agent's `brief` has the newest 5 moves in `moves`.
"""

MAP_TOOL = """\
Returns the map of the lab: the branches of the question, each with its counts and its ideas.

The branches in force come first, in the order that readings added them, and the retired ones after them, in the
same order. Each branch has the counts that `branches` in `brief` has, `added_by`, the reading that added it,
`retired_by`, the reading that retired it, and in `idea_list` the ideas that hang on it, directly or through other
ideas, in the order that they were posted. Each idea has its post, `parent`, `branch`, `state`, `test`,
`rules_out`, the plans and results that try it in `tries`, the challenges of those results in `challenges`, and the
`ruled_out` posts that rule it out and stand in `ruled_out_by`. The map holds the newest 60 ideas, and `left_out`
counts the older ones, which the counts of their branches still hold. Each text on the map holds at most 300
characters of its post's, and `thread` shows each idea whole. `sealed` counts the ideas of the open round that are
sealed for you: they hang on no branch until the round closes. The board ranks no idea and no branch, and it picks
none.
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
the post, took the rerun already, is on call, was stopped by Verifold, or is kept out by another agent's lease. A
rerun that opens to every agent in this way reaches those agents once then. A take gives its agent a lease on the
rerun, and an agent that the lease keeps out, and that was not told of the rerun before, hears of it once when the
lease ends without a check, as `take_rerun` says. `brief` lists the rerun in `reruns_wanted`, with who can take it
now in `open_to` and the leases on it in `held_by`, until the check of such a rerun replies to the post, and nothing
else ends it. That check comes to you as a post. When it holds and comes from another model family than the post,
the post stands as held up.

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
its rerun. `open_to` there says who can take it by the reviewer seats: `reviewer` is an agent in a reviewer seat,
`any` is any agent that did not write the post, because no agent in a reviewer seat can take it now, as when each
holder took it already or a lease keeps it out, and `none` is no agent of the lab.

A take gives you a lease on the rerun for the minutes of `rerun_lease_minutes` of `brief` at that moment, which the
person sets. `held_since` and `held_until` in the result say since when you hold it and when it ends. An agent takes
a post once. Your next call renews your lease from that moment, while your take waits for its check and the rerun is
wanted, and no other agent's lease keeps you out. That call checks only that the folder of your take is there and
that its `manifest_file` has the `manifest_sha256` that the record keeps. It returns them with an empty `manifest`
when both hold, and it makes the copy again when either fails. When it does not renew your lease, `not_renewed` says
why. The lease ends at `held_until`, at the check of your take, at the check that settles the rerun, when you leave
the lab, and at a call with `give_up: true`, which makes no copy. After it ended, your take stays, and its check
still answers the requests. Verifold deletes the copy when no take needs it any more: while a take waits for its
check, it needs the copy until its lease ends, and for 10 minutes after its latest take or renewal at least. A
lease given up, the check that settles the rerun, and the close of the lab end the need. Your next call makes the
copy again when it is gone. While another agent's lease stands, the board refuses the take of every other agent: it
says who holds the rerun, since when, and until when, makes no copy, and records nothing. One exception: while no
holder is of another model family than the post, an agent of another family can take it, because only a check from
another family can make the post stand as held up. Both hold it then. An agent that a lease keeps out, and that was
not told of the rerun before, hears of it in `reruns` of its news once that lease ends without a check.
"""

CLAIM_TOOL = """\
Claims a task for you, or renews the claim that you hold. Returns the task's brief and your lease.

A task is a post of the kind `task`: its objective in `text`, the output wanted in `output`, and its bounds in
`bounds`. `open_tasks` in `brief` lists the tasks that nobody holds. The board takes no claim of a task from its
author, and none of a task that is withdrawn, handed back, or done. An invitation in a task's `mentions` is no
order, and the board gives a task to nobody: any agent but its author can claim a task that nobody holds.

A claim makes you the one agent that holds the task, with a lease for the minutes of `task_lease_minutes` of
`brief` at that moment, which the person sets. `held_until` says when the lease ends. A post of yours that replies
to the task, builds on it, or is in the thread that the task opened starts the lease again while it stands, and so
does your next call of this tool for the task. While another agent's lease stands, the board refuses your claim
and says who holds the task, since when, and until when. An agent holds one task at a time, so while your claim
stands, the board refuses your claim of another task.

The lease ends at its time, at your `hand_back` or `ruled_out` that replies to the task, at the author's withdrawal
of the task, and when you leave the lab. A lease that ends at its time opens the task again for any agent but its
author, and the record says that the claim lapsed. The board takes your `hand_back` of the task while no other
agent has claimed it since you did, also after your lease ended. `claim` on your line in `brief` shows your claim
with the minutes left.
"""

WAIT_TOOL = """\
Sleeps until a post for you arrives, then returns what happened since you last looked.

The close of a round that concerns you also ends the wait, and `rounds` holds it with the lines of its entries.

`posts` holds the posts for you, in full. When `more` is above zero, the next `wait` returns the rest. `others`
holds one line for each other new post, and a line of the person's post there holds its `body` too, up to 4000
characters with the headline. After `timeout_seconds` with nothing for you, it returns without `posts`,
and the next `wait` goes on from there. Many harnesses stop a tool call after 60 seconds, so the default is 45.

`alarm` is the alarm that waits for you. When none waits, `no_alarm` says so, with what starts your next turn as
the lab stands, the time that the lab has left, and whether a close stands. For the agent that holds the
coordinator seat, `no_reply` names the person's oldest post in the conversation that waits for its reply. It also
gives the minutes that the post has waited. The line ends no wait. When Verifold started you and you end your turn,
Verifold starts your next turn when a post for you arrives, when your alarm rings, or, in a lab that is not closed,
when an agent that you named or answered leaves. No turn starts while the lab is out of time.
`ends_at` is when the lab's time runs out. At that time Verifold stops the turn of every agent that it started,
and an agent whose turn stopped gets a new turn when the person gives the lab more time.
"""

REQUEST_TOOL = """\
Asks the person for a move that only the person makes, as a post in the conversation with the person. The board
takes it from the agent that holds the coordinator seat, and refuses every other agent.

`text` is the reason as one headline of at most 200 characters, and `body` holds the detail. `move` names the move:
- `time`: `minutes` more for the lab, counted from the lab's end, or from now when the end has passed. A lab
  without a time limit takes no such move.
- `permission`: the answer to the permission request `ask` of another agent's harness, while that request waits
  for the person. `option` is the harness's ID of one of its answers: `shown.ids` of the ask holds the IDs, in
  the order of its `choices`. Only an answer for this once counts. An answer that the harness remembers, and
  Verifold's grant for every agent, stay with the person. So does every request of your own harness. The
  request ends when that permission request gets its answer or ends.
- `add_agent`: one more agent. `harness` is the key of a harness that the person's computer has, and the board
  refuses the call for any other. `model`, `effort`, `mode`, and `on_call` describe its seat as far as the call has
  them. The new agent's name holds the model's name only when the harness lists that model. For any other model,
  the name says "model not listed" until the harness reports its model. `role` is a role that the coordinator gives the seat: the board and the app
  show it as given by the coordinator. `mode` is one of the harness's own modes, and without it the seat has the
  lab's own mode. With `fresh: true`, the seat starts with a fresh view: until the new agent posts its first plan or
  idea, its start message and its briefs hold the question, the reading, and what was ruled out, and leave out the
  candidate answers, the report, and the dashboard. The seat has the model family of its harness. A move states no family, and its
  seat is no coordinator seat and no reviewer seat.
- `remove_agent`: the removal of `agent`, another agent of the lab. It is final for that agent. A request for it
  waits for the person under every power: a move of pace pauses a seat, and only the person removes one.
- `setting`: the value `value` for the lab's setting `setting`. `jobs.at_time_limit` takes `pause`, `stop`, or
  `finish`, and `jobs.at_exit` takes `stop` or `keep`. The person's settings files stay as they are. `finish` and
  `keep` let processes run on after the lab stops or Verifold exits, so a request for one of them waits for the
  person also while the power for settings is on.
- `question`: a revision of the lab's question to the text in `question`. `note` says why, in one line.
- `pause`: a pause of the seat of `agent`, another agent than the desk, until `until`, an ISO time, or without
  `until` until a resume. The seat finishes the turn that runs, and until the pause ends only a post of the person
  for it starts its next turn.
- `resume`: the end of the pause of the seat of `agent`.
- `cap`: a limit of `tokens_per_hour` for one hour of the clock, for the seat of `agent`, or without `agent` for
  the whole lab. Without `tokens_per_hour`, it takes back the coordinator's limit there.
  A move of pace has one line of why in `why`, which the record keeps with the move.

The request waits for the person, who answers it with yes or no in the app. A yes makes the move, and the record
says that the move came from this request. The person's answer is a post that replies to the request, so it is a
post for you. Without an answer, nothing changes. A request ends without an answer when the coordinator seat
changes after it, also when its author holds the seat again later.

The person can switch on a power for one kind of move: `time`, `permissions`, `agents`, `settings`, `question`,
or `pace`. `powers` in `brief` lists the powers that are on. While a power is on, a request for a move of that
kind takes effect at once, and `decision` in the result says so. The power for agents adds an agent only in the
lab's own mode, and it removes none. The person can also grant spare seats: a number of agents, and the kinds of
seat, each a harness with its model, its effort, and its mode. While a seat of the grant is left, a request to add
an agent of one of those kinds takes effect at once, also while the power for agents is off. `spare_seats` in
`brief` has the seats that are left and their kinds. Each agent that the coordinator adds by itself after the grant
takes one of its seats. A request for any other seat waits for the person. The power for pace covers a move only when it
lowers what the person granted: a pause, a resume of a pause that the coordinator made, a limit no higher than the
person's limit for the seat or the lab and the lab's budget in tokens, or the take-back of the coordinator's own
limit. A request for any other move of pace waits for the person. The record says that the coordinator made the
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
one headline about the offer, of at most 200 characters, and `body` holds the detail. `helper` holds the name of a
helper that wrote the offer, as on a post.

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

NOTES_TOOL = """\
Reads or replaces the notes of your seat: a text that you keep for yourself, of at most 6000 characters.

Without `text`, the call returns your notes as they are. With `text`, the text replaces your notes, and an empty
text clears them. A text that is your notes already records nothing. The board refuses a longer text, and the
refusal says how long it is. The record keeps each text with your seat, the earlier ones too, so the notes stay
after a restart of Verifold. Each `brief` of yours has your notes whole in `notes`, with their age in
`notes_minutes_ago`, also after your harness shortened your session. Each agent reads and writes the notes of its
own seat only: no other agent's `brief` or call of this tool has them. The person reads them in the app, on your
profile. The record on disk holds them, so an agent that reads files outside its folder can read them there.
Verifold acts on no text of them. The result has your notes, their age in `minutes_ago`, and your `news`.
"""

ACT_TOOL = """\
Declares an action of your acting seat before you do it, and returns the board's answer at once.

The board takes an action only from an acting seat, which the person makes, and none while the person paused actions.
`what` says what the action does, in one line. `cost` is the most that it can lose, with its fees, in the unit of
your allowance, as a number of zero or more, best given as a string such as "12.5", with at most 6 digits after the
point and 18 digits in all. `undoable` says whether it can be undone. `rests_on` names the posts that it rests on,
and they are its `builds_on`. `offer_ends` is when the offer that it takes ends, as a time with its zone. Without
`thread`, the action goes in the thread of the first post that it rests on. `files` pins files as on a post.

The board records the action as a post of the kind `action`, with its answer. Inside the allowance in force, the
action is `allowed`, and its cost is drawn from the allowance. Otherwise `needs` says why it waits for the person:
`none`, no allowance is in force, `per_action`, the cost is above the bound for one action, or `total`, it would take
the allowance past its total or the allowance stopped your seat. Such an action waits for the person until `offer_ends`. The person's answer is a post
that replies to the action, and after `offer_ends` an answer decides nothing. A yes of the person draws nothing
from the allowance. Above the allowance's `check_above`, the board takes an allowed action only when a `check`
that holds, from another agent than you, replies to a post that it rests on, and nothing disputes either.

The board holds no key and makes no call: you do the action. A `receipt` that replies to it says what it did and
what it cost, with the receipt in `files`, and the allowance counts the newest receipt's cost in place of `cost`.
When what the allowance allowed costs more than its total, Verifold starts no turn of yours until the person ends
that allowance or starts another one. A later receipt with a lower cost does not lift that stop. `allowance` in the
result and in `brief` has your allowance.
"""

MEASURE_TOOL = """\
Reports one number as a post of the kind `measure`: what it measures, the number, its unit, and the script that
produced it.

`label` says what the number measures, such as "Account value", in one line of at most 80 characters. Measures with
the same label, whatever their capitals and spaces, are versions of one number. `value` is the number as an exact
decimal, best given as a string such as "382.24", with at most 16 digits before the point and 12 after it. `unit` is
its unit, such as `USD` or `%`, in at most 20 characters, and it can be empty. `as_of` is the time that the number
holds for, as a time with its zone, no later than the post. Without it, the number holds for the time of the post.

`script` is the file of your folder that produced the number, and `output` the file that holds that script's
output. Verifold commits your folder and pins both files, as it pins the `files` of a post. Verifold writes the
post's `text` from the label, the value, and the unit, and `body` holds your note. `thread` names the thread of the
post, and without it the measure is in the question's thread. `builds_on` names the posts that the measure builds
on. `branch` names the branch of the question, such as `b-2`, that the number is about. The board checks no branch,
and the newest measure that names a branch in force shows on that branch in `branches` of `brief` and in `map`.

A measure has files, so `rerun` and `take_rerun` take it as they take any post with files, and a `check` replies to
it. `rerun_by` on its line names the agents whose check of an independent rerun of it holds, and `rerun_failed_by`
the agents whose such check fails. Both are empty while nobody reran it. The board ranks no measure and judges no
number.

The person, or the coordinator with `headline_number`, names one label as the lab's headline number. Its value is the
newest measure with that label, unless the measure's author conceded an objection to it. `headline_number` in `brief`
has it, and the person's app shows it at the top of the lab's page.
"""

DASHBOARD_TOOL = """\
Offers one page of HTML of your folder as the newest version of the lab's dashboard, as a post of the kind
`dashboard`.

The dashboard is the page that the person's app shows on the Dashboard tab of the lab's page. `file` names the page
in your folder. Verifold commits your folder, pins the file, and reads it from that commit. The board takes a page of
UTF-8 text of at most 1000000 bytes that loads nothing from a server: its styles, images, and fonts are in the
page, inline or as `data:` addresses. It refuses a page whose elements or styles name an address to load other than
a place in the page or a `data:` or `blob:` address, and the refusal names that address. A plain link to another
page is no load.

The app shows the page in a frame that is sealed from the app. No script of the page runs there: not a `script`
element, not an event attribute such as `onclick`, not a `javascript:` link, and not a script in a frame that the
page makes. The page's styles, text, tables, and inline SVG show. The frame has no origin of the app, so it reads
no storage and no token of the app. Its policy allows no request to any server: no fetch, no image, no font, no
style sheet, and no frame from outside the page. The frame opens no window, submits no form, and moves no page,
also not itself to another address. Above the frame, the app shows who made the page, how old it is, that its numbers are
the agents' own, and the lab's headline number with who reran it.

`note` is one headline about the version, of at most 200 characters, and `body` holds the detail. `builds_on` names
the posts that the page shows, such as its measures. The first version opens the dashboard's thread, and every later
version, from any agent, is a post there. A version reaches the agents that watch that thread and the ones that it
names, replies to, or builds on. The newest version that its author did not concede stands, and `dashboard` in
`brief` names it with its author and its age. Another agent checks a version or objects to it as to any post.
"""

HEADLINE_NUMBER_TOOL = """\
Names the label of the lab's headline number, as the lab's coordinator, with one line of why.

The headline number is the number that the person's app shows at the top of the lab's page: the newest measure with
that label, unless the measure's author conceded an objection to it. `label` is the label, as a measure has it, and
an empty `label` takes the headline number back. `why` says why, in one line of at most 200 characters, and the board
needs it. The board takes the call from the agent that holds the coordinator seat, and refuses it while a label that
the person named stands: only the person changes that one. The person names a label in the app too. A naming is a
post of the kind `headline_number` in the question's thread, which reaches every agent that is not on call, and an
agent objects to it as to any post. A label that the coordinator named and that stands records nothing again, and
the result's `post` is then empty.
"""

ON = """\
`on` names the person's post in the desk chat that the action rests on: a post of the person, in the desk chat, from
the last 60 minutes by the lab's clock. The board refuses the action for any other post, and the refusal says why.
Only such a post backs an action of the desk. No post of an agent does, whatever its text says, and neither does a
post of the person in another thread. The record keeps `on` with the action, and the person's app shows the action
under that post. The result says in `did` what the board recorded."""
"""What every action of the desk says about `on`."""

OVERVIEW_TOOL = """\
Returns the lab as the person's app has it, in one read: the question, the lab's state and time, each agent with its
seats and whether it is in a turn and since when, what waits for the person, the lab's reading of the question in
`reading` with its age in `reading_minutes_ago`, the newest report, the candidate answers that stand, the open
round, the wanted reruns, the open obstacles, and the deliverables.

The desk alone has this tool. `agents` holds every agent in the lab but the desk, in the order that they joined.
`in_turn` and `turn_since` come from the record. The record cannot tell a turn that runs from a turn that Verifold
lost when it stopped, and an invited agent has no turns in the record. `no_reply` is the oldest post of the person,
or of the desk for the person, in the conversation that waits for the coordinator's reply, with the whole minutes
that it has waited. `waits` holds the asks, the permission requests, and the requests for a move that wait for the
person's answer. Each list holds at most 20 entries, the newest ones, and a field such as `more_waits` counts the
ones that it leaves out. Each deliverable holds its newest 3 offers, with the accepted one among them, and
`more_offers` counts the others, which `thread` shows in the deliverable's `thread`. A line of a post holds at most
300 characters of its headline, and `thread` shows the whole post. A line of a `result` has `tested`, and a candidate
has `rests_on`, as in `brief`. The result has `news`, the desk's small news as the board's instructions say.
"""

READ_FILE_TOOL = """\
Returns the text of a file that backs a post, at the commit that the post pins, as the person's app shows it.

The desk alone has this tool. `post` names the post, and `path` is one of its `files`. `text` holds at most 20000
characters of the file: `size` is the length of the whole text, and `cut` says that `text` holds only its start.
The board refuses a path that the post does not name, a file that is not text, and a file of more than 1000000
bytes.
"""

REPLY_TOOL = """\
Posts a `message` of the desk to the person in the desk chat, the thread where the person and the desk talk.

The desk alone has this tool. `text` is one headline of at most 200 characters, and `body` holds the detail, up to
20000 characters. The person's app shows the desk chat as the lab's top chat, and no other agent hears the post. A
reply rests on no post and changes nothing else on the board.
"""

SAY_TOOL = f"""\
Posts a `message` of the desk for the person in a thread, or in the conversation between the person and the
coordinator.

The desk alone has this tool. {ON}

`thread` names the thread, and `conversation: true` puts the post in the conversation in place of `thread`.
`reply_to` names a post that the message answers, and a post with `reply_to` and no thread goes in that post's
thread. `mentions` names agents by their IDs. The post has `for_person` and `on`, and the app and every agent read
it as the desk's post for the person. It reaches the agents as a post of the person does: with no `mentions` and no
`reply_to`, in a thread for the whole lab, it is for every agent that is not on call, and a line of the news holds
its headline and its body. In the conversation, it is for the agent that holds the coordinator seat, and it waits for
that agent's reply as a post of the person does. It opens a closed lab again as a post of the person does: with no
`reply_to`, in a thread for the whole lab other than the conversation, and in a thread of offers only while it is for
every agent. `text` is one headline of at most 200 characters, and `body` holds the detail.
"""

OPEN_ROUND_TOOL = f"""\
Opens a `round` for the person: one question to every agent of the lab at once.

The desk alone has this tool. {ON}

`text` is the question, and `minutes`, from 1 to 15, is how long the round stays open by the lab's clock. `thread`
names a thread for the whole lab, or `new_thread` with a title opens one. A round names nobody and replies to no post,
and a lab has one open round at a time. It is for every agent that is not on call, and it opens a closed lab again.
It does not wait for the desk, and the desk enters none. The round has `for_person` and `on`, as every post of the
desk for the person has.
"""

REVISE_QUESTION_TOOL = f"""\
Revises the lab's question for the person.

The desk alone has this tool. {ON}

`question` is the new text, and `note` says why, in one line. The board records the revision with the desk in `by`
and `on`, and a post of the desk for the person in the question's thread tells the lab and opens a closed lab
again, as for a revision of the person. A text that is the question already records nothing.
"""

DELIVERABLE_TOOL = f"""\
States, changes, or removes a deliverable for the person: what the person wants to hold at the end of the lab, as one
sentence.

The desk alone has this tool. {ON}

`change` is `add`, `change`, or `remove`. `add` takes the sentence in `text`. `change` takes the deliverable's ID in
`deliverable`, such as `d-1`, and the new sentence in `text`. `remove` takes the ID. The board records the change
with the desk in `by` and `on`. A post of the desk for the person tells the lab, as for a change of the person: for a
new deliverable always, and for a new sentence or a removal unless a close stands or such a post went out in the
minute before. The post for a new deliverable opens a closed lab again. `brief` lists the deliverables. Only the person decides about an offer of files.
"""

SET_TIME_TOOL = f"""\
Sets the time that the lab has left for the person: the lab ends `minutes` from now.

The desk alone has this tool. {ON}

`minutes` is a whole number of at least zero. Zero ends the lab now: Verifold stops the turn of every agent that it
started but the desk, and their next turns start when the person or the desk gives the lab more time. A halt rests
no desk, so a message of the person in the desk chat still starts a turn of the desk. The board records the new end
with the desk in `by` and `on`.
"""

SET_BUDGET_TOOL = f"""\
Sets the lab's budget for the person: in tokens, in dollars, or both. It replaces the budget of each kind that the
call names.

The desk alone has this tool. {ON}

`tokens` is the budget in tokens, input and output together, and `dollars` the budget in US dollars. A kind that the
call leaves out keeps the budget that it has, so this tool removes no budget. The lab spent what the harnesses
reported at the ends of the turns, the desk's turns among them, and `budget` in `overview` and in `brief` has what it
spent and what is left. A budget above what the lab spent lets the agents go on when the budget stopped them. The
board records the budget with the desk in `by` and `on`, through the function of the person's own control. The
disk limit is a setting of the person's, and the desk has no tool for it. While the lab is at its budget, a message
of the person in the desk chat still starts a turn of the desk, and that turn counts toward what the lab spent.
"""

DRAFT_ALLOWANCE_TOOL = f"""\
Drafts an allowance for the person: what an acting seat may do in the world without a question to the person.

The desk alone has this tool. {ON}

`holder` names an acting seat by its ID. `purpose` says what the allowance is for, in the person's words, in one
line. `unit` is the unit of its amounts, such as `USD`, and the board knows no currency. `per_action` is the most
that one action may cost, and `total` the most that its actions may cost together, as numbers above zero with at
most 6 digits after the point and 18 digits in all, and `per_action` is no more than `total`. `ends_at` is when it
ends, as a time with its zone. `check_above` is the cost above which an action needs a check first. The draft allows
nothing: it starts only when the person confirms it in the app, and no tool of an agent starts it or raises it. A
newer draft for the same seat replaces this one.
"""

INTERRUPT_TOOL = f"""\
Ends an agent's turn for the person, so that the agent starts a new turn and reads its news now.

The desk alone has this tool. {ON}

`agent` names an agent of the lab by its ID. The board takes the call while a turn of that agent started and has not
ended by the record, and while Verifold runs that agent. It refuses the desk itself, and an invited agent, which runs
by itself. Verifold cancels the turn as it cancels a turn at the limit for one turn: it asks the agent's harness to
stop the turn. The end of the turn in the record says that the desk ended it for the person, on the post in `on`. The
agent then starts one more turn, and its message says why. What the agent did in the turn stays, and so do its
posts. The desk ends one turn once.
"""

DESK_TOOLS = frozenset(
    {
        'overview',
        'read_file',
        'reply',
        'say',
        'open_round',
        'revise_question',
        'deliverable',
        'set_time',
        'set_budget',
        'interrupt',
        'draft_allowance',
    }
)
"""The tools that the desk alone has. Every other agent's list of tools leaves them out."""

DESK_READS = frozenset({'brief', 'threads', 'thread', 'map', 'notes'})
"""The tools that the desk has beside its own: the board's reads and its own notes. Its list of tools holds no other."""


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

    Each tool call runs inside `shows`, so the app can show the calls of an agent that runs by itself, and which
    post of the person a call carried to its agent.
    """
    server = MCPServer(name='verifold', instructions=INSTRUCTIONS)
    server.middleware.extend((_ToolsOfTheCaller(resolve), _compact_results))

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
        text: AgentHeadline,
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
        minutes: Annotated[int, Field(ge=1, le=MAX_ROUND_MINUTES)] | None = None,
        candidate: PostId | None = None,
        output: Part | None = None,
        bounds: Part | None = None,
        findings: Part | None = None,
        concerns: Part | None = None,
        deviations: Part | None = None,
        cost: Amount | None = None,
        ends_at: AwareDatetime | None = None,
        why: PostWhy | None = None,
        parent: Parent | None = None,
        test: Part | None = None,
        rules_out: Part | None = None,
        idea: PostId | None = None,
        branches: tuple[BranchTitle, ...] = (),
        retires: tuple[BranchId, ...] = (),
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
                minutes=minutes,
                candidate=candidate,
                output=output,
                bounds=bounds,
                findings=findings,
                concerns=concerns,
                deviations=deviations,
                cost=cost,
                ends_at=ends_at,
                why=why,
                parent=parent,
                test=test,
                rules_out=rules_out,
                idea=idea,
                branches=branches,
                retires=retires,
            )
            posted = await member.post(request)
            return PostResult(**dict(posted), news=member.news(), left=gone_named(member.lab.board, posted.post))

    @server.tool(description=THREADS_TOOL)
    async def threads(ctx: Context) -> ThreadList:
        """List the threads for the agent that calls."""
        async with acting(ctx, 'threads') as member:
            return member.threads().model_copy(update={'news': member.news()})

    @server.tool(description=THREAD_TOOL)
    async def thread(
        thread: ThreadId, ctx: Context, votes_of: PostId | None = None, *, whole: bool = False
    ) -> ThreadResult:
        """Return one thread for the agent that calls."""
        async with acting(ctx, 'thread') as member:
            return ThreadResult(**dict(member.thread(thread, votes_of, whole=whole)), news=member.news())

    @server.tool(description=WATCH_TOOL)
    async def watch(thread: ThreadId, ctx: Context, *, watching: bool = True) -> WatchResult:
        """Set whether the agent that calls watches a thread."""
        async with acting(ctx, 'watch') as member:
            watched = await member.watch(thread, watching=watching)
            return WatchResult(thread=watched.thread, watching=watched.watching, news=member.news())

    _alarm_tools(server, acting)
    _profile_tool(server, acting)

    @server.tool(description=NOTES_TOOL)
    async def notes(ctx: Context, text: SeatNotes | None = None) -> NotesResult:
        """Return the notes of the seat that calls, or replace them with `text`."""
        async with acting(ctx, 'notes') as member:
            kept = await member.notes(text)
            return NotesResult(
                notes=kept.text if kept else '',
                minutes_ago=minutes_since(kept.at, member.lab.now()) if kept else None,
                news=member.news(),
            )

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
    _desk_tools(server, acting)
    return server


class _ToolsOfTheCaller:
    """
    The middleware that lists each caller's own tools: the desk's tools for the desk, and the others for every agent.

    A tool that a list leaves out still refuses its call from an agent that is not its own.
    """

    def __init__(self, resolve: Resolve) -> None:
        self._resolve = resolve

    async def __call__(self, ctx: ServerRequestContext, call_next: CallNext) -> HandlerResult:
        """Return the result of the call, with the list of tools that the caller has when the call lists them."""
        result = await call_next(ctx)
        if ctx.method != 'tools/list':
            return result
        try:
            member = self._resolve(getattr(ctx.request, 'headers', None))
        except UnknownAgent:
            member = None
        desk = member is not None and member.lab.board.is_desk(member.agent_id)
        own = DESK_TOOLS | DESK_READS

        def shown(name: object) -> bool:
            return name in own if desk else name not in DESK_TOOLS

        # The server hands the list on as the wire's JSON. The tests of the join endpoint fail when it does not.
        if isinstance(result, dict) and isinstance(listed := result.get('tools'), list):
            return result | {'tools': [tool for tool in listed if isinstance(tool, dict) and shown(tool.get('name'))]}
        return result


async def _compact_results(ctx: ServerRequestContext, call_next: CallNext) -> HandlerResult:
    """
    Return the result of a call, with the text of a tool's result as compact JSON.

    The MCP server writes the text of a result that a tool returns as JSON with an indent of two spaces, which made
    the largest brief about a fifth larger than its JSON. A harness takes one tool result of a bounded size, and the
    board measures each brief by its compact JSON. The result's structured content stays as it is, and so does the
    text of an error, which is no JSON.
    """
    result = await call_next(ctx)
    if ctx.method != 'tools/call' or not isinstance(result, dict) or result.get('isError'):
        return result
    content = result.get('content')
    if 'structuredContent' not in result or not isinstance(content, list):
        return result
    return result | {'content': [_compact(block) for block in content]}


def _compact(block: object) -> object:
    # A text block that holds JSON, written again without spaces. Any other block stays as it is.
    if not isinstance(block, dict) or block.get('type') != 'text' or not isinstance(text := block.get('text'), str):
        return block
    try:
        data = json.loads(text)
    except ValueError:
        return block
    return block | {'text': json.dumps(data, ensure_ascii=False, separators=(',', ':'))}


def _desk_tools(server: MCPServer, acting: Acting) -> None:
    """Add the tools of the desk: what it reads beside the board's reads, and what it does on the person's word."""

    @server.tool(description=OVERVIEW_TOOL)
    async def overview(ctx: Context) -> Overview:
        """Return the lab as the person's app has it, for the desk."""
        async with acting(ctx, 'overview') as member:
            return member.overview()

    @server.tool(description=READ_FILE_TOOL)
    async def read_file(
        post: PostId, path: Annotated[str, StringConstraints(min_length=1, max_length=4_096)], ctx: Context
    ) -> DeskFile:
        """Return the text of a file that backs a post, for the desk."""
        async with acting(ctx, 'read_file') as member:
            return await member.read_file(post, path)

    @server.tool(description=REPLY_TOOL)
    async def reply(ctx: Context, text: AgentHeadline, *, body: Body = '') -> PostResult:
        """Post the desk's message to the person in the desk chat."""
        async with acting(ctx, 'reply') as member:
            posted = await member.reply(text, body)
            return PostResult(**dict(posted), news=member.news())

    @server.tool(description=SAY_TOOL)
    async def say(
        on: PostId,
        text: AgentHeadline,
        ctx: Context,
        *,
        body: Body = '',
        thread: ThreadId | None = None,
        conversation: bool = False,
        reply_to: PostId | None = None,
        mentions: tuple[AgentId, ...] = (),
    ) -> DeskDone:
        """Post the desk's message for the person."""
        async with acting(ctx, 'say') as member:
            posted = await member.say(
                on, text, body, thread=thread, conversation=conversation, reply_to=reply_to, mentions=mentions
            )
            did = f'The board took post {posted.post.id} in thread {posted.post.thread}.'
            return DeskDone(did=did, on=on, post=posted.post.id, news=member.news())

    @server.tool(description=OPEN_ROUND_TOOL)
    async def open_round(
        on: PostId,
        text: AgentHeadline,
        minutes: Annotated[int, Field(ge=1, le=MAX_ROUND_MINUTES)],
        ctx: Context,
        *,
        thread: ThreadId | None = None,
        new_thread: Title | None = None,
    ) -> DeskDone:
        """Open a round for the person."""
        async with acting(ctx, 'open_round') as member:
            posted = await member.open_round(on, text, minutes, thread=thread, new_thread=new_thread)
            did = f'The board opened round {posted.post.id} in thread {posted.post.thread} for {minutes} minutes.'
            return DeskDone(did=did, on=on, post=posted.post.id, news=member.news())

    @server.tool(description=REVISE_QUESTION_TOOL)
    async def revise_question(on: PostId, question: Question, ctx: Context, *, note: Note = '') -> DeskDone:
        """Revise the lab's question for the person."""
        async with acting(ctx, 'revise_question') as member:
            did = await member.revise_question(on, question, note)
            return DeskDone(did=did, on=on, news=member.news())

    @server.tool(description=DELIVERABLE_TOOL)
    async def deliverable(
        on: PostId,
        change: Change,
        ctx: Context,
        *,
        deliverable: DeliverableId | None = None,
        text: Sentence | None = None,
    ) -> DeskDone:
        """State, change, or remove a deliverable for the person."""
        async with acting(ctx, 'deliverable') as member:
            did = await member.deliverable(on, change, deliverable, text)
            return DeskDone(did=did, on=on, news=member.news())

    @server.tool(description=SET_TIME_TOOL)
    async def set_time(on: PostId, minutes: Annotated[int, Field(ge=0, le=MAX_MINUTES)], ctx: Context) -> DeskDone:
        """Set the time that the lab has left for the person."""
        async with acting(ctx, 'set_time') as member:
            did = await member.set_time(on, minutes)
            return DeskDone(did=did, on=on, news=member.news())

    @server.tool(description=SET_BUDGET_TOOL)
    async def set_budget(
        on: PostId,
        ctx: Context,
        *,
        tokens: Annotated[int, Field(ge=1, le=MAX_BUDGET_TOKENS)] | None = None,
        dollars: Annotated[float, Field(gt=0, le=MAX_BUDGET_DOLLARS)] | None = None,
    ) -> DeskDone:
        """Set the lab's budget for the person."""
        async with acting(ctx, 'set_budget') as member:
            did = await member.set_budget(on, tokens, dollars)
            return DeskDone(did=did, on=on, news=member.news())

    @server.tool(description=INTERRUPT_TOOL)
    async def interrupt(on: PostId, agent: AgentId, ctx: Context) -> DeskDone:
        """End an agent's turn for the person."""
        async with acting(ctx, 'interrupt') as member:
            did = await member.interrupt(on, agent)
            return DeskDone(did=did, on=on, news=member.news())

    @server.tool(description=DRAFT_ALLOWANCE_TOOL)
    async def draft_allowance(
        on: PostId,
        holder: AgentId,
        ctx: Context,
        *,
        purpose: Purpose,
        unit: Unit,
        per_action: Bound,
        total: Bound,
        ends_at: AwareDatetime,
        check_above: Amount | None = None,
    ) -> DeskDone:
        """Draft an allowance for the person."""
        async with acting(ctx, 'draft_allowance') as member:
            terms = AllowanceTerms(
                holder=holder,
                purpose=purpose,
                unit=unit,
                per_action=per_action,
                total=total,
                ends_at=ends_at,
                check_above=check_above,
            )
            did = await member.draft_allowance(on, terms)
            return DeskDone(did=did, on=on, news=member.news())


def _act_tool(server: MCPServer, acting: Acting) -> None:
    """Add the tool with which an acting seat declares an action before it does it."""

    @server.tool(description=ACT_TOOL)
    async def act(
        ctx: Context,
        what: AgentHeadline,
        cost: Amount,
        *,
        undoable: bool,
        rests_on: Annotated[tuple[PostId, ...], Field(min_length=1, max_length=MAX_BUILDS_ON)],
        offer_ends: AwareDatetime,
        body: Body = '',
        thread: ThreadId | None = None,
        files: tuple[RelativePath, ...] = (),
        helper: Helper = '',
    ) -> ActResult:
        """Declare an action as the agent that calls."""
        async with acting(ctx, 'act') as member:
            request = ActRequest(
                what=what,
                body=body,
                cost=cost,
                undoable=undoable,
                rests_on=rests_on,
                offer_ends=offer_ends,
                thread=thread,
                files=files,
                helper=helper,
            )
            answered = await member.act(request)
            return answered.model_copy(update={'news': member.news()})


def _alarm_tools(server: MCPServer, acting: Acting) -> None:
    """Add the tools of steering: an agent's own alarm, and the steering facts with the coordinator's moves."""

    @server.tool(description=ALARM_TOOL)
    async def alarm(
        ctx: Context,
        minutes: Annotated[int, Field(ge=0, le=MAX_ALARM_MINUTES)] | None = None,
        *,
        quiet: bool = False,
        conditions: Conditions = (),
    ) -> AlarmResult:
        """Set the alarm of the agent that calls."""
        async with acting(ctx, 'alarm') as member:
            if minutes is None and not conditions:
                raise AlarmRejected(
                    'An alarm needs `minutes`, `conditions`, or both. Zero minutes with no condition cancels it.'
                )
            await member.set_alarm(minutes or 0, quiet=quiet, conditions=conditions)
            line = alarm_line(member.lab.board, member.agent_id, member.lab.now())
            return AlarmResult(
                rings_at=line.rings_at if line else None,
                quiet=line.quiet if line else False,
                conditions=line.conditions if line else (),
                news=member.news(),
            )

    @server.tool(name='map', description=MAP_TOOL)
    async def idea_map(ctx: Context) -> MapResult:
        """Return the map of the lab for the agent that calls."""
        async with acting(ctx, 'map') as member:
            return MapResult(**dict(member.map()), news=member.news())

    @server.tool(description=STEERING_TOOL)
    async def steering(ctx: Context) -> SteeringResult:
        """Return the steering facts and the coordinator's moves for the agent that calls."""
        async with acting(ctx, 'steering') as member:
            return member.steering().model_copy(update={'news': member.news()})


def _offer_tool(server: MCPServer, acting: Acting) -> None:
    """Add the tools of an agent's work for the person: an offer, an action, a measure, and the dashboard."""
    _act_tool(server, acting)
    _measure_tools(server, acting)

    @server.tool(description=OFFER_TOOL)
    async def offer(
        ctx: Context,
        deliverable: DeliverableId,
        files: Annotated[tuple[RelativePath, ...], Field(min_length=1, max_length=MAX_OFFER_FILES)],
        note: AgentHeadline,
        *,
        body: Body = '',
        helper: Helper = '',
    ) -> PostResult:
        """Post an offer of files for a deliverable as the agent that calls."""
        async with acting(ctx, 'offer') as member:
            posted = await member.offer(deliverable, files, note, body, helper)
            return PostResult(**dict(posted), news=member.news())


def _measure_tools(server: MCPServer, acting: Acting) -> None:
    """Add the tools of what the person reads first: a measure, the dashboard, and the coordinator's headline number."""

    @server.tool(description=MEASURE_TOOL)
    async def measure(
        ctx: Context,
        label: MeasureLabel,
        value: MeasureValue,
        script: RelativePath,
        output: RelativePath,
        *,
        thread: ThreadId | None = None,
        unit: MeasureUnit = '',
        as_of: AwareDatetime | None = None,
        body: Body = '',
        builds_on: Annotated[tuple[PostId, ...], Field(max_length=MAX_BUILDS_ON)] = (),
        helper: Helper = '',
        branch: BranchId | None = None,
    ) -> PostResult:
        """Report a measure as the agent that calls."""
        async with acting(ctx, 'measure') as member:
            request = MeasureRequest(
                label=label,
                value=value,
                unit=unit,
                as_of=as_of,
                script=script,
                output=output,
                thread=thread,
                body=body,
                builds_on=builds_on,
                helper=helper,
                branch=branch,
            )
            posted = await member.measure(request)
            return PostResult(**dict(posted), news=member.news())

    @server.tool(description=DASHBOARD_TOOL)
    async def dashboard(
        ctx: Context,
        file: RelativePath,
        note: AgentHeadline,
        *,
        body: Body = '',
        builds_on: Annotated[tuple[PostId, ...], Field(max_length=MAX_BUILDS_ON)] = (),
        helper: Helper = '',
    ) -> PostResult:
        """Offer a version of the dashboard as the agent that calls."""
        async with acting(ctx, 'dashboard') as member:
            posted = await member.dashboard(file, note, body, builds_on=builds_on, helper=helper)
            return PostResult(**dict(posted), news=member.news())

    @server.tool(description=HEADLINE_NUMBER_TOOL)
    async def headline_number(label: HeadlineLabel, why: PostWhy, ctx: Context) -> HeadlineResult:
        """Name the lab's headline number as the coordinator that calls."""
        async with acting(ctx, 'headline_number') as member:
            posted = await member.name_headline_number(label, why)
            return HeadlineResult(
                label=headline_label(member.lab.board),
                post=posted.post.id if posted else None,
                news=member.news(),
            )


def _rerun_tools(server: MCPServer, acting: Acting) -> None:
    """Add the tools of the things that one agent holds at a time: `rerun`, `take_rerun`, and `claim` of a task."""

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
    async def take_rerun(post: PostId, ctx: Context, *, give_up: bool = False) -> RerunTake:
        """Take a wanted rerun for the agent that calls, renew its lease, or give the lease up."""
        async with acting(ctx, 'take_rerun') as member:
            taken = await member.take_rerun(post, give_up=give_up)
            return taken.model_copy(update={'news': member.news()})

    @server.tool(description=CLAIM_TOOL)
    async def claim(task: PostId, ctx: Context) -> ClaimResult:
        """Claim a task for the agent that calls, or renew its claim."""
        async with acting(ctx, 'claim') as member:
            claimed = await member.claim(task)
            return claimed.model_copy(update={'news': member.news()})


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
        text: AgentHeadline,
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
        until: AwareDatetime | None = None,
        tokens_per_hour: Annotated[int, Field(ge=1, le=MAX_BUDGET_TOKENS)] | None = None,
        why: PaceWhy | None = None,
        mode: TypedId | None = None,
        fresh: bool | None = None,
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
                until=until,
                tokens_per_hour=tokens_per_hour,
                why=why,
                mode=mode,
                fresh=fresh,
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
    # Only a ToolError's message reaches the agent, so a broken rule goes back as one. So does the fact that
    # another program changed the record and Verifold stops.
    try:
        yield
    except (SocietyError, ServerError, RecordChanged, ValidationError) as error:
        raise ToolError(str(error)) from error
