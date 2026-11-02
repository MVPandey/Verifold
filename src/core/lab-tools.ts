import { maxPodsAtOnce } from './pod-limits.ts';
import { runLimits } from './runs.ts';
import type { AgentTool } from './session-hosts.ts';

/**
 * The tools of a lab agent. Codex keeps the tools of a thread for its life, so
 * a change of a tool that a thread has raises `labToolsVersion`, and a Codex
 * agent with an older thread starts a new one. A tool that only new threads
 * get needs no new version: `verifold_plan` goes only to the agent that opens
 * a lab, and that agent's thread is new. The run tools, the pod tools,
 * `verifold_direction`, `verifold_ask_person`, and the run proof of
 * `verifold_post` add to the tools. `where` and `lease` of `verifold_run` are optional, so every call of
 * its older schema stays valid. None of them raises a version: a Codex agent
 * whose thread is older keeps its conversation, and gets them with its next
 * new thread. `verifold_direction` now accepts holds-up, which starts a
 * check; its schema did not change, so no version either. `facts` of
 * `verifold_plan` is optional, so the plans of an older thread stay valid: no
 * version. The same holds for `changed` of `verifold_plan`, for `facts` of
 * `verifold_ask_person`, for its fourth option and its `podsAtOnce` effect,
 * and for `job` and `team` of a direction. New words in a description raise
 * no version either: an older thread keeps the older words. A lab with threads
 * gets other board tools (`threadToolSpecs`): a new `verifold_post`, and
 * `verifold_status`, `verifold_agree`, and `verifold_follow`. That raised the
 * version to 3. A lab from before threads keeps its tools, so it compares
 * with `oldLabToolsVersion` and its Codex threads go on. `verifold_source`,
 * `verifold_idea`, the `sources` and `ideas` views of `verifold_board`, and
 * `longShot` add to the tools of a lab with threads, so they raise no version
 * either. `method` and `raters` of a check post are optional too. A lab from
 * before threads keeps its exact schemas.
 */
export const labToolsVersion = 3;

/** The tool version of a lab from before threads. Its tools stay as they were. */
export const oldLabToolsVersion = 2;

/** The handles of a new lab: `agent-3` and `checker-1`. */
export const roleHandlePattern = '(?:agent|checker)-[1-9]\\d{0,3}';

/** The handles of a lab from before role names: `claude-2` and `codex-1`. */
export const harnessHandlePattern = '(?:claude|codex)-[1-9]\\d{0,3}';

/** Every handle that a lab's records can hold. `coordinator` is kept for one session. */
export const handlePattern = `(?:${roleHandlePattern}|${harnessHandlePattern}|coordinator)`;

/** The limits of a plan of record. The tool schema and the lab's checks use the same ones. */
export const planLimits = {
  /** Open directions of a lab, and so entries of a plan. */
  directions: 20,
  reading: 600,
  cost: 200,
  title: 120,
  /** Short labels of a direction: what its agent does, and the group that it works with. */
  job: 40,
  team: 40,
  bar: 280,
  runs: 20,
  noise: 120,
  buildsOn: 4,
  buildsOnText: 120,
  /** The facts that a plan rests on, each with its source and the source's date. */
  facts: 12,
  claim: 160,
  source: 300,
  sourceDate: 40,
  /** What a later plan changed, and why. */
  changed: 200,
};

/** The kinds of post that an agent can write in a lab from before threads. */
export const agentPostKinds = [
  'claim',
  'evidence',
  'objection',
  'question',
  'ruled-out',
] as const;

/** The kinds of post that an agent can write in a lab with threads. A rerun comes from a checker that Verifold starts. */
export const threadPostKinds = [
  'result',
  'check',
  'ask',
  'answer',
  'objection',
  'proposal',
  'ruled-out',
] as const;

/** What a `check` post found in its target. */
export const postOutcomes = ['holds', 'fails'] as const;

/** How the author of a `check` post checked. `ratings`: AI raters scored each answer. */
export const postMethods = ['rerun', 'code-read', 'ratings'] as const;

/** The limits of threads. The tool schemas and the lab's checks use the same ones. */
export const threadLimits = {
  /** Threads of one lab. With the other limits, the threads file stays under the 4 MB that a read takes. */
  threads: 500,
  title: planLimits.title,
  /** Characters of the one line that says why a thread exists. */
  why: 200,
  /** Agents that follow one thread. */
  followers: 30,
  /** Reactions on one thread. */
  agreed: 25,
  /** Characters of each field of `verifold_status`. */
  status: 200,
  /** New threads, and new proposals, that one digest names. */
  index: 10,
  /** Characters of a proposal's text in its digest line. */
  proposalLine: 140,
  /** Minutes that a proposal stays open to objections. Then it becomes the decision of its thread. */
  objectionMinutes: 15,
  /** Posts that moved to another thread. A record applies each move on read. */
  moves: 2000,
  /** AI ratings per answer that a check post can name. */
  raters: 9,
};

/** The limits of the lab's reading. The tool schemas and the store use the same ones. */
export const readingLimits = {
  /** Agents whose lookups and helpers a lab keeps. */
  agents: 200,
  /** Newest calls of an agent, so a call that a harness logs twice counts once. */
  seen: 64,
  /** Characters of a lookup's query or address. */
  lookup: 200,
  /** Papers on the reading map. */
  sources: 300,
  title: 200,
  url: 500,
  date: planLimits.sourceDate,
  /** Ideas on the idea map, and characters of each one. */
  ideas: 1000,
  idea: 160,
  /** Ideas of one paper, and papers of one idea. */
  ideasPerSource: 12,
  sourcesPerIdea: 8,
  /** Helpers that a lab keeps for one agent, and characters of a helper's title. */
  helpers: 12,
  helper: 120,
};

/** The limits of a long-shot draw: one fresh session judges a batch of drawn candidates. */
export const longShotLimits = {
  /** Ideas in one candidate. */
  size: 3,
  /** Candidates that one session judges. */
  batch: 6,
  /** The best candidates that go on the board. */
  top: 3,
  /** Draws in one hour of the lab's clock. */
  perHour: 3,
  /** Draws that a lab keeps on record. */
  draws: 40,
  /** The lowest score that a candidate needs to go on the board. */
  sense: 3,
  /** Turns and minutes of the session. */
  turns: 2,
  minutes: 20,
  /** Characters of the session's answers. */
  question: planLimits.title,
  test: 200,
  cost: 80,
  closest: 160,
  /** The most papers that an answer counts as combining the ideas. */
  prior: 99,
};

/**
 * The limits of the Coordinator and its line check. They run outside "Agents
 * at once", in one place of their own, so these bounds hold at any lab size.
 */
export const briefLimits = {
  /**
   * Sessions in one hour of the lab's clock: at most 20, with the questions.
   * Stories have their own budget, so they never use an update of the brief.
   */
  updatesPerHour: 4,
  checksPerHour: 6,
  storiesPerHour: 4,
  /** Questions of the person, which can each start a session. */
  questionsPerHour: 6,
  /** Turns and minutes of one session. */
  turns: 3,
  minutes: 10,
  /** Sessions that the record keeps for those counts. */
  sessions: 40,
  /** Changes of threads and notices that one session can make. */
  actions: 40,
  /** Newest posts in a session's first prompt, and characters of each. */
  promptPosts: 120,
  promptPost: 1000,
  /** Lines of one brief or story, and posts that one line cites. */
  lines: 12,
  linePosts: 6,
  /** Stories that a lab keeps, threads that one session tells, and posts of each that its prompt holds. */
  stories: 500,
  storiesPerSession: 2,
  storyPosts: 40,
  /** Characters of a plain line, of the person's question, and of an answer. */
  plain: 400,
  question: 500,
  answer: 1000,
  /** Notices in one hour, and the notices and questions that a lab keeps. */
  noticesPerHour: 6,
  notices: 100,
  questions: 50,
  /** Characters of a claim or a caveat in a line check. */
  claim: 300,
  /** Claims and caveats of one line in a line check. */
  claims: 20,
};

/** What a line of a brief is about. */
export const briefKinds = ['decided', 'failed', 'held', 'open', 'new'] as const;

/** What a line of a thread's story is: a step of how it got there, its outcome, or a later fact. */
export const storyKinds = ['step', 'outcome', 'later'] as const;

/** What the Coordinator can tell agents, and nothing more. */
export const noticeKinds = ['overlap', 'missing-answer', 'no-search'] as const;

/** What a line check says of one claim of a plain line. */
export const claimVerdicts = [
  'supported',
  'added-fact',
  'raised-certainty',
  'number-out-of-scope',
] as const;

const postId = { type: 'string', pattern: '^p-[1-9][0-9]{0,5}$' };
const directionId = { type: 'string', pattern: '^d-[1-9][0-9]{0,3}$' };
const runId = { type: 'string', pattern: '^r-[1-9][0-9]{0,5}$' };
const threadIdSchema = { type: 'string', pattern: '^t-[1-9][0-9]{0,5}$' };

/** The proof of a post. */
const proofSchema = {
  type: 'array',
  maxItems: 4,
  items: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['file', 'figure', 'diff', 'run'],
      },
      path: {
        type: 'string',
        maxLength: 300,
        description: 'A file or a figure: its path in your folder.',
      },
      paths: {
        type: 'array',
        items: { type: 'string', maxLength: 300 },
        maxItems: 10,
        description:
          'A diff: the paths that you changed since your direction started.',
      },
      run: {
        ...runId,
        description: 'A run: its ID, such as r-7. Any run of the lab.',
      },
    },
    required: ['type'],
    additionalProperties: false,
  },
};

const mentionsSchema = {
  type: 'array',
  maxItems: 5,
  items: {
    type: 'string',
    pattern: `^(person|${handlePattern})$`,
  },
};

/** Read a file of a direction. Every lab has this tool. */
const readToolSpec: AgentTool = {
  name: 'verifold_read',
  description:
    "Read a file in a direction's folder, yours or another agent's. Without a commit, Verifold reads the file as it is now, also when the project ignores it. With a commit, such as the one that a post's proof names, it reads the file at that commit. A binary file gives its size only.",
  inputSchema: {
    type: 'object',
    properties: {
      direction: directionId,
      commit: { type: 'string', pattern: '^[0-9a-f]{7,64}$' },
      path: { type: 'string', maxLength: 300 },
    },
    required: ['direction', 'path'],
    additionalProperties: false,
  },
};

export const labToolSpecs: readonly AgentTool[] = [
  {
    name: 'verifold_board',
    description:
      'Read the lab board. unread: the posts that you have not read yet; this marks them read. summary: each direction with its agent and its latest posts. thread: a post and its replies. direction: the latest posts of one direction. search: the posts that contain the query.',
    inputSchema: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: ['unread', 'summary', 'thread', 'direction', 'search'],
        },
        post: postId,
        direction: directionId,
        query: { type: 'string', maxLength: 100 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['view'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_post',
    description:
      "Post to the lab board, in at most 280 characters. A claim, evidence, or ruled-out post needs proof: a file or a figure in your folder, a diff of paths that you changed, or a run of the lab. Verifold commits your folder first and pins a file, a figure, or a diff to that commit. Reply to a post with replyTo. Mention agents by handle (such as agent-2) or the person. A reply, a mention, or an objection in a direction wakes the agent that it is for. A post without one waits for each agent's next read.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: agentPostKinds },
        direction: {
          ...directionId,
          description: 'The direction that the post is about. Default: yours.',
        },
        text: { type: 'string', maxLength: 280 },
        artifacts: proofSchema,
        replyTo: postId,
        mentions: mentionsSchema,
      },
      required: ['kind', 'text'],
      additionalProperties: false,
    },
  },
  readToolSpec,
];

/**
 * The board tools of a lab with threads. They replace `labToolSpecs`: a post
 * has a thread and a kind that says what it does, and an agent's progress and
 * agreement are no posts.
 */
export const threadToolSpecs: readonly AgentTool[] = [
  {
    name: 'verifold_board',
    description:
      'Read the lab board. You can read any thread, also one that you do not follow. unread: the posts for you that you have not read yet. This marks them read. threads: each thread with its state. thread: the posts of a thread, or a post and its replies. summary: each direction with its agent and its latest posts. direction: the latest posts of one direction. search: the posts that contain the query. sources: the reading map, the papers that the lab read. ideas: the idea map.',
    inputSchema: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: [
            'unread',
            'threads',
            'thread',
            'summary',
            'direction',
            'search',
            'sources',
            'ideas',
          ],
        },
        thread: threadIdSchema,
        post: postId,
        direction: directionId,
        query: { type: 'string', maxLength: 100 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['view'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_post',
    description: `Post to the lab board, in at most 280 characters. A post is for what another agent or the person must read. Each post needs a thread: give thread, or open a thread with title and why. A reply with replyTo stays in the thread of its target. An objection, an answer, or a check to a post in a closed thread opens that thread again. Choose a kind:
- result: what you found. It needs proof. A check can test it.
- check: a recount or an audit of another post. It needs replyTo, outcome (holds or fails), and proof. method says how you checked: rerun (you ran it again, with the run as proof), code-read (you read the code), or ratings (AI raters scored each answer, and raters says how many per answer).
- ask: a question for one agent or the person. Name them in mentions. The wait ends when an answer comes.
- answer: a reply to an ask, to an objection, or to the person. It needs replyTo and no proof. In an answer to an objection, accepts: true says that the objection is right.
- objection: a problem in a post. It needs replyTo. The post shows Disputed until an answer accepts the objection, a check of a third agent holds the post, or a check of Verifold ends. A check that fails leaves it Disputed.
- proposal: a choice for the lab. With no objection in ${threadLimits.objectionMinutes} minutes it becomes the decision of its thread. A later objection to it opens the thread again.
- ruled-out: the end of a line of work: what passed, what failed, and what others can reuse. It needs proof.
Proof is a file or a figure in your folder, a diff of paths that you changed, or a run of the lab. Verifold commits your folder first and pins a file, a figure, or a diff to that commit. An objection, an ask, or an answer wakes the agent that it names. Other posts wait for each agent's next turn. Use verifold_status for progress, and verifold_agree for agreement.`,
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: threadPostKinds },
        thread: {
          ...threadIdSchema,
          description: 'The thread of the post, such as t-3.',
        },
        title: {
          type: 'string',
          maxLength: threadLimits.title,
          description:
            'To open a thread: a specific plain question or subject, such as "Does the control beat chance on seed 2?".',
        },
        why: {
          type: 'string',
          maxLength: threadLimits.why,
          description: 'To open a thread: one line on why it matters.',
        },
        direction: {
          ...directionId,
          description: 'The direction that the post is about. Default: yours.',
        },
        text: { type: 'string', maxLength: 280 },
        artifacts: proofSchema,
        replyTo: postId,
        outcome: { type: 'string', enum: postOutcomes },
        method: { type: 'string', enum: postMethods },
        raters: { type: 'integer', minimum: 1, maximum: threadLimits.raters },
        accepts: { type: 'boolean' },
        mentions: mentionsSchema,
      },
      required: ['kind', 'text'],
      additionalProperties: false,
    },
  },
  readToolSpec,
  {
    name: 'verifold_status',
    description:
      'Set your line on the home page: what you do now, why, and what comes next. The person reads this line, so write each field in one plain sentence, with no internal IDs. This is not a post. It replaces your last line and wakes no one. Use it for progress.',
    inputSchema: {
      type: 'object',
      properties: {
        doing: { type: 'string', maxLength: threadLimits.status },
        why: { type: 'string', maxLength: threadLimits.status },
        next: { type: 'string', maxLength: threadLimits.status },
      },
      required: ['doing', 'why', 'next'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_agree',
    description:
      "Agree with another agent's post. This is a reaction on its thread, not a post. It wakes no one, and it is not proof.",
    inputSchema: {
      type: 'object',
      properties: { post: postId },
      required: ['post'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_follow',
    description:
      'Follow a thread, so that its posts come with your turns. You follow a thread already when you posted in it or when an ask in it names you.',
    inputSchema: {
      type: 'object',
      properties: { thread: threadIdSchema },
      required: ['thread'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_source',
    description:
      'Add a paper to the lab\'s reading map, which every agent reads with verifold_board view sources. Give its title, its address, its date as the source gives it, and its ideas: short phrases that make sense alone, such as "Category residuals". Its ideas join the idea map. The same address adds its new ideas to the paper that the map has.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: readingLimits.title },
        url: { type: 'string', maxLength: readingLimits.url },
        date: { type: 'string', maxLength: readingLimits.date },
        ideas: {
          type: 'array',
          maxItems: readingLimits.ideasPerSource,
          items: { type: 'string', maxLength: readingLimits.idea },
        },
      },
      required: ['title', 'url', 'date', 'ideas'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_idea',
    description:
      'Add an idea from your work to the idea map, in a short phrase that makes sense alone. tried: true when the lab tried it. The same text again marks that idea as tried. Verifold draws long shots from this map.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', maxLength: readingLimits.idea },
        tried: { type: 'boolean' },
      },
      required: ['text', 'tried'],
      additionalProperties: false,
    },
  },
];

const leaseId = { type: 'string', pattern: '^lease-[0-9]{1,6}$' };

/** The run tools. A lab offers them on a computer with a sandbox for runs, or with pods. */
export const runToolSpecs: readonly AgentTool[] = [
  {
    name: 'verifold_run',
    description:
      'Run a command on your folder. Verifold commits your folder first. The run works on its own copy of that commit, so your later edits do not change it. where: local (the default) runs on this computer in a sandbox: the run writes only in its copy and its temporary folder, has no network and no GPU, and cannot read credential files. It can read the project folder. where: pod runs on the GPU pod of a lease of your direction, as root, with network, and with the secrets of the lease as environment variables. It has only the copy, not the rest of the project. The copy is no Git repository: VERIFOLD_COMMIT holds the commit. Verifold records the commit, the command, the log, the exit code, the time, and the metrics: `METRIC name=value` lines in the output, and a metrics.json of numbers that the run writes in the top folder of its copy. `outputs` names the files or folders of the copy that Verifold keeps. Verifold wakes you when the run ends. Once it ends, cite the run as proof with the artifact {type: run, run: r-N}.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          maxLength: runLimits.command,
          description: 'A shell command, run with sh in the copy.',
        },
        where: {
          type: 'string',
          enum: ['local', 'pod'],
          description: 'local (the default) or pod.',
        },
        lease: {
          ...leaseId,
          description:
            'On a pod: the lease to use. Default: the newest ready lease of your direction.',
        },
        why: {
          type: 'string',
          maxLength: runLimits.why,
          description: 'What the run tests, such as "seed 1 of 3 for the bar".',
        },
        minutes: {
          type: 'integer',
          minimum: 1,
          maximum: runLimits.podMinutes,
          description: `The time limit: up to ${runLimits.minutes} minutes locally, ${runLimits.podMinutes} on a pod. Default: ${runLimits.defaultMinutes}.`,
        },
        outputs: {
          type: 'array',
          maxItems: runLimits.outputPaths,
          items: { type: 'string', maxLength: 300 },
          description: 'Files or folders of the copy to keep after the run.',
        },
      },
      required: ['command', 'why'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_run_status',
    description: `Read a run of the lab: its state, exit code, metrics, kept outputs, and up to ${runLimits.statusLog / 1024} KB of its log. log: tail (the default), head, or none.`,
    inputSchema: {
      type: 'object',
      properties: {
        run: runId,
        log: { type: 'string', enum: ['tail', 'head', 'none'] },
      },
      required: ['run'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_cancel_run',
    description:
      'Cancel one of your runs that runs now. Its log and its outputs so far stay.',
    inputSchema: {
      type: 'object',
      properties: {
        run: runId,
        why: { type: 'string', maxLength: 280 },
      },
      required: ['run', 'why'],
      additionalProperties: false,
    },
  },
];

/** The pod tools of a lab agent. A lease that an agent asks for is for its own direction. */
export const labPodToolSpecs: readonly AgentTool[] = [
  {
    name: 'verifold_compute',
    description:
      'Read the GPU pod limits that the person set, what is spent and held, each lease with its state and cost, and the allowed GPU types with their price and stock now.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_request_pod',
    description:
      "Ask for a GPU pod lease for your direction: one GPU of an allowed type, for a number of hours. Pods cost the person money, so ask only when your next runs need a GPU. Verifold refuses a request that does not fit the person's limits. The lab's first pod is a call to the person: Verifold asks them and wakes you with the answer. After they approve one, a request inside the limits starts at once, unless the person approves each pod. The reply says which. Verifold wakes you when the pod is ready.",
    inputSchema: {
      type: 'object',
      properties: {
        gpuType: {
          type: 'string',
          description: 'An allowed GPU type ID from verifold_compute',
        },
        hours: { type: 'integer', minimum: 1, maximum: 24 },
        secrets: {
          type: 'array',
          items: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,63}$' },
          maxItems: 8,
          description:
            'Names of the secrets that the pod needs as environment variables, such as HF_TOKEN for gated Hugging Face models. The person stores them on their computer. You never see the values.',
        },
        why: {
          type: 'string',
          maxLength: 1000,
          description: 'Why your direction needs the pod. The person reads it.',
        },
      },
      required: ['gpuType', 'hours', 'why'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_end_lease',
    description:
      "End a lease of your direction now: its runs end and copy back their outputs, Verifold deletes its pod, and billing ends. A request that waits for the person is withdrawn. End a lease when your direction's runs no longer need it.",
    inputSchema: {
      type: 'object',
      properties: {
        lease: leaseId,
        why: { type: 'string', maxLength: 1000 },
      },
      required: ['lease', 'why'],
      additionalProperties: false,
    },
  },
];

/** The limits of a check: a fresh session of the other harness that reruns a claim. */
export const checkLimits = {
  /** Turns of one start of a check. */
  turns: 3,
  /** Minutes of one start of a check. */
  minutes: 60,
  /** Checks of one claim. */
  perClaim: 2,
  /** From this many of "Agents at once", checks run side by side: one for each this many, and at least two. */
  agentsPerCheck: 5,
  /** A check whose checker process stopped by itself, whose start or folder failed, or whose owner ended without closing the lab starts again once, then fails. */
  restarts: 1,
  /**
   * Check numbers after the newest that a checker's harness denies before
   * their folders exist. A check beyond them waits for that checker to end.
   */
  reserved: 16,
};

/** The checks that run at once: one in a small lab, then two, then one for each `checkLimits.agentsPerCheck` of "Agents at once". */
export function checksAtOnce(slots: number | undefined): number {
  const room = Math.floor((slots ?? 0) / checkLimits.agentsPerCheck);
  return room === 0 ? 1 : Math.max(2, room);
}

/** The kinds of post that a check tests, when they cite a run. A lab from before threads has claims and evidence. */
export const checkableKinds = [
  'result',
  'check',
  'claim',
  'evidence',
  'rerun',
] as const;

/** The outcome of a check, and how the checker got it. */
export const checkOutcomes = ['holds', 'fails', 'differs'] as const;
export const checkMethods = ['rerun', 'code-read'] as const;

/**
 * The tools of a checker. It gets no board read, no plan, and no direction
 * tool: it sees only what its prompt gives. It runs commands on its own
 * folder, reads the claim's files at the claim's commit, and posts its
 * rerun once. A checker's thread is always new, so these need no version.
 */
export const checkToolSpecs: readonly AgentTool[] = [
  {
    name: 'verifold_run',
    description:
      'Run a command on your folder, on this computer, in a sandbox. Verifold commits your folder first, and the run works on its own copy of that commit. The run writes only in its copy and its temporary folder, and has no network and no GPU. Verifold records the command, the log, the exit code, the time, and the metrics: `METRIC name=value` lines in the output, and a metrics.json of numbers that the run writes in the top folder of its copy. Verifold tells you when the run ends. Cite it in your rerun post as {type: run, run: r-N}.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          maxLength: runLimits.command,
          description: 'A shell command, run with sh in the copy.',
        },
        why: {
          type: 'string',
          maxLength: runLimits.why,
          description: 'What the run tests.',
        },
        minutes: {
          type: 'integer',
          minimum: 1,
          maximum: checkLimits.minutes,
          description: `The time limit, up to ${checkLimits.minutes} minutes. Default: ${runLimits.defaultMinutes}.`,
        },
        outputs: {
          type: 'array',
          maxItems: runLimits.outputPaths,
          items: { type: 'string', maxLength: 300 },
          description: 'Files or folders of the copy to keep after the run.',
        },
      },
      required: ['command', 'why'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_run_status',
    description: `Read one of your runs: its state, exit code, metrics, kept outputs, and up to ${runLimits.statusLog / 1024} KB of its log. log: tail (the default), head, or none.`,
    inputSchema: {
      type: 'object',
      properties: {
        run: runId,
        log: { type: 'string', enum: ['tail', 'head', 'none'] },
      },
      required: ['run'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_read',
    description:
      "Read a file of the claim at the claim's commit. Your folder starts with the same files. A binary file gives its size only.",
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', maxLength: 300 } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_post',
    description:
      "Post your rerun once, in at most 280 characters, as a reply to the claim. outcome: holds (you got the claim's result within its noise), fails (you did not), or differs (you got a different result that the claim does not cover). method: rerun (you ran it) or code-read (you only read the code; it never makes a direction hold up). Cite the runs that you made as proof. A code-read cites the claim's run. Your check ends with this post.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['rerun'] },
        text: { type: 'string', maxLength: 280 },
        outcome: { type: 'string', enum: checkOutcomes },
        method: { type: 'string', enum: checkMethods },
        artifacts: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['run'] },
              run: runId,
            },
            required: ['type', 'run'],
            additionalProperties: false,
          },
        },
      },
      required: ['kind', 'text', 'outcome', 'method', 'artifacts'],
      additionalProperties: false,
    },
  },
];

/** The verdicts of a direction. `holds-up` needs a check that reruns its claim. */
export const verdicts = ['open', 'leading', 'holds-up', 'ruled-out'] as const;

/** The limits of `verifold_direction`. The tool schema and the lab's checks use the same ones. */
export const directionLimits = {
  evidence: 120,
  why: 280,
  /** Agents that agents start in 24 hours, and never more than "Agents at once". */
  starts: planLimits.directions,
};

/** Directions: an agent opens one with its own agent, gives its own direction a verdict, and closes it. */
export const directionToolSpec: AgentTool = {
  name: 'verifold_direction',
  description: `Open a direction, give your direction a verdict, or close your direction. open: a new direction with its title, its bar, the harness of its agent, and a short job and team. Verifold makes its folder and starts its agent when a slot is free. A lab has at most ${planLimits.directions} open directions. Agents start at most ${directionLimits.starts} agents in 24 hours, and never more than the person's setting of agents at once. update: the verdict of your own direction, with one line of evidence. leading needs \`post\`: a claim, evidence, or rerun post about your direction, with proof. ruled-out needs \`post\`: a ruled-out post about your direction, with proof. open takes the verdict back. holds-up needs \`post\`: a claim, evidence, or rerun post about your direction that cites a run. Verifold then starts a check: a fresh agent of the other harness reruns it without your reasoning, and your direction holds up when it holds. close: end your direction after its verdict is ruled-out. Your session ends after this turn, and your folder and branch stay.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['open', 'update', 'close'] },
      title: {
        type: 'string',
        maxLength: planLimits.title,
        description: 'open: a short title.',
      },
      job: {
        type: 'string',
        maxLength: planLimits.job,
        description:
          'open: what its agent does, in one or two words, such as Controls.',
      },
      team: {
        type: 'string',
        maxLength: planLimits.team,
        description: 'open: the team that it joins, in one or two words.',
      },
      bar: {
        type: 'string',
        maxLength: planLimits.bar,
        description:
          'open: what makes the direction hold up, in plain words, with its number.',
      },
      runs: {
        type: 'integer',
        minimum: 1,
        maximum: planLimits.runs,
        description:
          'open: the repeat runs, such as seeds, that the bar needs.',
      },
      noise: {
        type: 'string',
        maxLength: planLimits.noise,
        description:
          'open: the spread between repeat runs that counts as noise, such as ±0.02.',
      },
      buildsOn: {
        type: 'array',
        maxItems: planLimits.buildsOn,
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', maxLength: planLimits.buildsOnText },
            known: { type: 'boolean' },
          },
          required: ['text', 'known'],
          additionalProperties: false,
        },
        description: 'open: known work or new work that it builds on.',
      },
      harness: {
        type: 'string',
        enum: ['claude', 'codex'],
        description: "open: the harness of the direction's agent.",
      },
      verdict: { type: 'string', enum: verdicts },
      evidence: {
        type: 'string',
        maxLength: directionLimits.evidence,
        description:
          'update: one line of evidence, such as "old mix 61.2 vs 57.1, 3 seeds".',
      },
      post: {
        ...postId,
        description: 'update: the post with the proof of the verdict.',
      },
      why: {
        type: 'string',
        maxLength: directionLimits.why,
        description: 'Why. The person and the other agents read it.',
      },
    },
    required: ['action', 'why'],
    additionalProperties: false,
  },
};

/** `verifold_direction` in a lab with threads, where a result or a check holds the proof and a direction can be a long shot. */
export const threadDirectionToolSpec: AgentTool = {
  ...directionToolSpec,
  description: directionToolSpec.description.replaceAll(
    'a claim, evidence, or rerun post',
    'a result, check, or rerun post',
  ),
  inputSchema: {
    ...directionToolSpec.inputSchema,
    properties: {
      ...(directionToolSpec.inputSchema.properties as object),
      longShot: {
        type: 'boolean',
        description:
          'open: its agent works on long shots, far from known work.',
      },
    },
  },
};

/**
 * The one tool of a long-shot session. Its thread is always new, so it needs
 * no version.
 */
export const longShotToolSpecs: readonly AgentTool[] = [
  {
    name: 'verifold_judge',
    description:
      'Give your judgment of the candidates, once. For each candidate: a plain question that it would answer, a score from 1 (makes no sense) to 5 (clearly makes sense), the smallest test that could fail, its cost, how many papers already combine its ideas, and the closest paper with its date.',
    inputSchema: {
      type: 'object',
      properties: {
        candidates: {
          type: 'array',
          minItems: 1,
          maxItems: longShotLimits.batch,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', pattern: '^c-[1-9]$' },
              question: { type: 'string', maxLength: longShotLimits.question },
              sense: { type: 'integer', minimum: 1, maximum: 5 },
              test: { type: 'string', maxLength: longShotLimits.test },
              cost: { type: 'string', maxLength: longShotLimits.cost },
              prior: {
                type: 'integer',
                minimum: 0,
                maximum: longShotLimits.prior,
              },
              closest: { type: 'string', maxLength: longShotLimits.closest },
            },
            required: [
              'id',
              'question',
              'sense',
              'test',
              'cost',
              'prior',
              'closest',
            ],
            additionalProperties: false,
          },
        },
      },
      required: ['candidates'],
      additionalProperties: false,
    },
  },
];

/** The kinds of call for the person. A technical question goes on the board, and a check settles it. */
export const callKinds = ['cost', 'scope', 'access', 'go'] as const;

/** What a call asks for when no option effect says it. `pods`: turn on GPU pods. Calls with the same need join. */
export const callNeeds = ['pods'] as const;

const citedPosts = {
  type: 'array',
  minItems: 1,
  maxItems: briefLimits.linePosts,
  items: postId,
};

/**
 * The tools of the Coordinator: it reads the board, keeps the threads, writes
 * the brief, tells agents about overlap and missing answers, and answers the
 * person. No tool of it opens or stops a direction, starts a run, asks the
 * person, changes a plan, or settles a dispute. Its session is always new, so
 * these need no version.
 */
export const labCoordinatorToolSpecs: readonly AgentTool[] = [
  {
    name: 'verifold_board',
    description:
      'Read the lab board. threads: each thread with its state. thread: the posts of a thread, or a post and its replies. summary: each direction with its agent and its latest posts. direction: the latest posts of one direction. search: the posts that contain the query. sources: the reading map. ideas: the idea map.',
    inputSchema: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: [
            'threads',
            'thread',
            'summary',
            'direction',
            'search',
            'sources',
            'ideas',
          ],
        },
        thread: threadIdSchema,
        post: postId,
        direction: directionId,
        query: { type: 'string', maxLength: 100 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['view'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_thread',
    description:
      "Keep a thread. title: give the person a clearer title. Agents keep reading the thread's own title. A title names a subject or a question, states no result, and ends once the thread has an outcome. move: move a post to another thread. The post keeps its ID, so its links keep working. A plan, a proposal, a post that holds an outcome, and a post with an open objection or ask stay. file: open a thread for one of the person's posts in the plan thread, when no thread fits. Agents read the person's own words as its title. Give title for the person. close: end a thread. Name the post that holds its outcome. A thread with a decision or an answer keeps its outcome, so name no post then. Verifold quotes that post. An open objection, a wait, an open proposal, or a long shot keeps a thread open.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['title', 'move', 'file', 'close'] },
        thread: {
          ...threadIdSchema,
          description:
            'title and close: the thread. move: the thread that gets the post.',
        },
        title: { type: 'string', maxLength: threadLimits.title },
        post: {
          ...postId,
          description:
            'move and file: the post. close: the post with the outcome.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_brief',
    description: `Give the brief for the person, in up to ${briefLimits.lines} plain lines. Each line cites the posts that it rests on. Verifold quotes those posts, writes the evidence label, and has a second session check each line. A new call replaces your last one.`,
    inputSchema: {
      type: 'object',
      properties: {
        lines: {
          type: 'array',
          minItems: 1,
          maxItems: briefLimits.lines,
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: briefKinds },
              plain: {
                type: 'string',
                maxLength: briefLimits.plain,
                description:
                  'Leave it out only when the prompt says that this lab keeps no plain words.',
              },
              posts: citedPosts,
            },
            required: ['kind', 'posts'],
            additionalProperties: false,
          },
        },
      },
      required: ['lines'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_story',
    description: `Tell how one thread went, for the person, in up to ${briefLimits.lines} plain lines, oldest first. step: one step of how it got there. outcome: what the thread ended with, and who disagreed. later: a fact after the outcome that changes it. Each line cites the posts that it rests on. A line can cite a post of another thread. Verifold quotes those posts and has a second session check each line. A new call for a thread replaces its last story.`,
    inputSchema: {
      type: 'object',
      properties: {
        thread: threadIdSchema,
        lines: {
          type: 'array',
          minItems: 1,
          maxItems: briefLimits.lines,
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: storyKinds },
              plain: { type: 'string', maxLength: briefLimits.plain },
              posts: citedPosts,
            },
            required: ['kind', 'plain', 'posts'],
            additionalProperties: false,
          },
        },
      },
      required: ['thread', 'lines'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_notice',
    description: `Tell agents what the record shows, in their next turn. It wakes no one. You give a kind and posts, and Verifold writes the words. overlap: two or more posts of different agents may cover the same work. missing-answer: an ask or an objection has no answer yet. no-search: a post shows "No search yet". A notice states the record and suggests no work. A lab sends at most ${briefLimits.noticesPerHour} notices in an hour.`,
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: noticeKinds },
        posts: citedPosts,
      },
      required: ['kind', 'posts'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_answer',
    description:
      'Answer a question of the person from the record, in plain words. Cite the posts that the answer rests on. This wakes no agent, and no agent reads it. A second session checks the answer, as it checks a line of the brief.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', pattern: '^q-[1-9][0-9]{0,5}$' },
        plain: {
          type: 'string',
          maxLength: briefLimits.answer,
          description:
            'Leave it out only when the prompt says that this lab keeps no plain words.',
        },
        posts: citedPosts,
      },
      required: ['question', 'posts'],
      additionalProperties: false,
    },
  },
];

/** The one tool of a line check. Its session is always new, so it needs no version. */
export const lineCheckToolSpecs: readonly AgentTool[] = [
  {
    name: 'verifold_line_check',
    description:
      'Give your check of each line, once. Split each line into its claims, and judge each claim against the cited posts. supported: the posts say it. added-fact: the posts do not say it. raised-certainty: the line is more certain than the posts. number-out-of-scope: the number is in the posts, but it describes something else. In dropped, list each caveat of the posts that the line leaves out and that changes its meaning.',
    inputSchema: {
      type: 'object',
      properties: {
        lines: {
          type: 'array',
          minItems: 1,
          maxItems: briefLimits.lines + briefLimits.questions,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', pattern: '^l-[1-9][0-9]{0,6}$' },
              claims: {
                type: 'array',
                minItems: 1,
                maxItems: briefLimits.claims,
                items: {
                  type: 'object',
                  properties: {
                    claim: { type: 'string', maxLength: briefLimits.claim },
                    verdict: { type: 'string', enum: claimVerdicts },
                  },
                  required: ['claim', 'verdict'],
                  additionalProperties: false,
                },
              },
              dropped: {
                type: 'array',
                maxItems: briefLimits.claims,
                items: { type: 'string', maxLength: briefLimits.claim },
              },
            },
            required: ['id', 'claims', 'dropped'],
            additionalProperties: false,
          },
        },
      },
      required: ['lines'],
      additionalProperties: false,
    },
  },
];

/** The limits of a call. The tool schema and the lab's checks use the same ones. */
export const callLimits = {
  /** Calls that wait for the person at once. Verifold's own deadline call does not count. */
  open: 6,
  question: 160,
  label: 80,
  /** One line under an option's label. */
  detail: 160,
  why: 280,
  /** The person's answer in their own words. */
  words: 2000,
  options: { min: 2, max: 4 },
  usd: 10_000,
  minutes: 100_000,
  domains: 20,
  /** More lab hours that one option gives. */
  hours: 72,
  /** Pod hours of one option. */
  podHours: 24,
  /** The highest "Pods at once" that one option can set, the most that Settings allows. */
  podsAtOnce: maxPodsAtOnce,
  undoMinutes: 60,
  defaultUndo: 10,
  /** The hours of Verifold's own call at the end of a time budget. */
  deadlineHours: 4,
};

/** Facts that change over time, each with where and when the agent checked it. A plan and a call give them. */
const factsSchema = {
  type: 'array',
  maxItems: planLimits.facts,
  items: {
    type: 'object',
    properties: {
      claim: {
        type: 'string',
        maxLength: planLimits.claim,
        description:
          'The fact, such as "Model: Qwen3.8-8B" or "H100: $3.99 an hour".',
      },
      source: {
        type: 'string',
        maxLength: planLimits.source,
        description:
          'Where you checked it: a URL. Leave it out for a fact that you could not check: it is unverified.',
      },
      sourceDate: {
        type: 'string',
        maxLength: planLimits.sourceDate,
        description:
          "The source's date, such as 2026-08-14, or when you read a price.",
      },
    },
    required: ['claim'],
    additionalProperties: false,
  },
} as const;

/** A call for the person: cost, scope, access, or go, with options, a pick, and an undo window. */
export const askPersonToolSpec: AgentTool = {
  name: 'verifold_ask_person',
  description: `Write the call for the person, in plain words, with no internal IDs: the person decides on your exact words. Ask the person for a call that only they make: cost (money, such as a GPU pod or more lab hours), scope (open or stop a direction, or, before the plan of record, a choice that changes the plan), access (network for your shell, or GPU pods), or go (more time for the lab). Never ask the person to settle a technical question: post an objection on the board, and a check settles it. Give 2 to 4 options, each with its dollars and minutes when you know them, and an effect that Verifold applies when the person picks it. pod goes with cost, podsAtOnce with cost, hours with cost or go, direction with scope, and domains with access. An option without an effect changes no setting: the person's pick only tells you their choice, and Verifold says so to the person. When an option promises a change, give it the effect that makes the change. A scope call before the plan has no effects: the plan opens the directions. pick is the option that you advise, and why says why. facts lists the facts behind the call that change over time, each with its source and the source's date. The person's answer applies at once, and they can undo it within undoMinutes (default 10). The person can also answer in their own words instead of an option: then no option applies, and their words are the decision. When another agent's open call asks for the same thing (the same kind and need, or the same effects), your call joins it, and its answer reaches you too. Verifold wakes you with the answer. At most ${callLimits.open} calls wait for the person at once.`,
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: callKinds },
      need: {
        type: 'string',
        enum: callNeeds,
        description:
          "pods: you ask the person to turn on GPU pods, with a RunPod key and a spend limit in the project's settings. Only with access. One call serves the lab: calls with need pods join.",
      },
      question: { type: 'string', maxLength: callLimits.question },
      options: {
        type: 'array',
        minItems: callLimits.options.min,
        maxItems: callLimits.options.max,
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', maxLength: callLimits.label },
            detail: {
              type: 'string',
              maxLength: callLimits.detail,
              description:
                'One line on what the option means, such as what it gives or what it costs in time.',
            },
            usd: { type: 'number', minimum: 0, maximum: callLimits.usd },
            minutes: {
              type: 'integer',
              minimum: 0,
              maximum: callLimits.minutes,
            },
            effect: {
              type: 'object',
              properties: {
                pod: {
                  type: 'object',
                  properties: {
                    gpuType: {
                      type: 'string',
                      description:
                        'An allowed GPU type ID from verifold_compute',
                    },
                    hours: {
                      type: 'integer',
                      minimum: 1,
                      maximum: callLimits.podHours,
                    },
                    secrets: {
                      type: 'array',
                      maxItems: 8,
                      items: {
                        type: 'string',
                        pattern: '^[A-Z][A-Z0-9_]{0,63}$',
                      },
                    },
                  },
                  required: ['gpuType', 'hours'],
                  additionalProperties: false,
                },
                domains: {
                  type: 'array',
                  minItems: 1,
                  maxItems: callLimits.domains,
                  items: { type: 'string', maxLength: 253 },
                  description:
                    "Domains that your shell's commands may reach, such as pypi.org.",
                },
                hours: {
                  type: 'integer',
                  minimum: 1,
                  maximum: callLimits.hours,
                  description: "More hours for the lab's time budget.",
                },
                podsAtOnce: {
                  type: 'integer',
                  minimum: 1,
                  maximum: callLimits.podsAtOnce,
                  description:
                    "The project's limit of pods that run at once. It stays set until the person changes it. Undo sets it back. verifold_compute shows it.",
                },
                direction: {
                  type: 'object',
                  properties: {
                    open: {
                      type: 'string',
                      maxLength: planLimits.title,
                      description: 'The title of a new direction.',
                    },
                    harness: {
                      type: 'string',
                      enum: ['claude', 'codex'],
                      description: 'open: the harness of its agent.',
                    },
                    bar: {
                      type: 'string',
                      maxLength: planLimits.bar,
                      description: 'open: what makes it hold up.',
                    },
                    stop: {
                      ...directionId,
                      description: 'A direction to stop.',
                    },
                  },
                  additionalProperties: false,
                },
              },
              additionalProperties: false,
            },
          },
          required: ['label'],
          additionalProperties: false,
        },
      },
      pick: {
        type: 'integer',
        minimum: 0,
        maximum: callLimits.options.max - 1,
      },
      why: { type: 'string', maxLength: callLimits.why },
      facts: {
        ...factsSchema,
        description:
          'The facts behind the call that change over time, such as a model or a price.',
      },
      undoMinutes: {
        type: 'integer',
        minimum: 0,
        maximum: callLimits.undoMinutes,
      },
    },
    required: ['kind', 'question', 'options', 'pick', 'why'],
    additionalProperties: false,
  },
};

/** The plan of record, with `entry` as more fields of each direction. */
const planSpec = (entry: Record<string, unknown>): AgentTool => ({
  name: 'verifold_plan',
  description:
    "Post the plan of record: how you read the question, the directions that attack it, and the facts that it rests on. A new direction has a title, a job, a team, a pass bar in plain words, the repeat runs that the bar needs, the spread that counts as noise, what it builds on (known work or new), and the harness of its agent. Your own direction is `mine`, the index in the list; Verifold opens the others, each with its own agent and folder. facts lists what changes over time and what the plan uses, such as a model or a GPU price, each with its source and the source's date. Later, call it again to change the plan: list every open direction with its id, with only the fields that change, and new directions without an id, and say in changed what changed and why. A plan without facts keeps the facts of the plan before it.",
  inputSchema: {
    type: 'object',
    properties: {
      reading: {
        type: 'string',
        maxLength: planLimits.reading,
        description: 'How you read the question, in plain words.',
      },
      directions: {
        type: 'array',
        minItems: 1,
        maxItems: planLimits.directions,
        items: {
          type: 'object',
          properties: {
            id: {
              ...directionId,
              description:
                'An open direction. Leave it out for a new direction.',
            },
            title: { type: 'string', maxLength: planLimits.title },
            job: {
              type: 'string',
              maxLength: planLimits.job,
              description:
                'What its agent does, in one or two words, such as Controls.',
            },
            team: {
              type: 'string',
              maxLength: planLimits.team,
              description:
                'The team of directions that it works with, in one or two words.',
            },
            ...entry,
            bar: {
              type: 'string',
              maxLength: planLimits.bar,
              description:
                'What makes the direction hold up, in plain words, with its number.',
            },
            runs: {
              type: 'integer',
              minimum: 1,
              maximum: planLimits.runs,
              description:
                'The repeat runs, such as seeds, that the bar needs.',
            },
            noise: {
              type: 'string',
              maxLength: planLimits.noise,
              description:
                'The spread between repeat runs that counts as noise, such as ±0.02.',
            },
            buildsOn: {
              type: 'array',
              maxItems: planLimits.buildsOn,
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string', maxLength: planLimits.buildsOnText },
                  known: {
                    type: 'boolean',
                    description:
                      'True: published or known work. False: new in this lab.',
                  },
                },
                required: ['text', 'known'],
                additionalProperties: false,
              },
            },
            harness: {
              type: 'string',
              enum: ['claude', 'codex'],
              description:
                "The harness of a new direction's agent. An open direction keeps its harness.",
            },
          },
          additionalProperties: false,
        },
      },
      mine: {
        type: 'integer',
        minimum: 0,
        maximum: planLimits.directions - 1,
        description:
          'The index of your own direction in the first plan. Default: 0.',
      },
      cost: {
        type: 'string',
        maxLength: planLimits.cost,
        description: 'What in the plan costs money, or that nothing does yet.',
      },
      facts: {
        ...factsSchema,
        description:
          'The facts that change over time and that the plan rests on.',
      },
      changed: {
        type: 'string',
        maxLength: planLimits.changed,
        description:
          'Every plan after the first: one line on what changed from the plan before, and why.',
      },
    },
    required: ['reading', 'directions', 'cost'],
    additionalProperties: false,
  },
});

/** The plan of record. Only the agent that opened the lab gets this tool. */
export const planToolSpec: AgentTool = planSpec({});

/** The plan of record in a lab with threads, where a direction can be a long shot. */
export const threadPlanToolSpec: AgentTool = planSpec({
  longShot: {
    type: 'boolean',
    description: 'Its agent works on long shots, far from known work.',
  },
});
