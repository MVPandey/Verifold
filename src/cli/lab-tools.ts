import { runLimits } from './runs.ts';
import type { AgentTool } from './session-hosts.ts';

/**
 * The tools of a lab agent. Codex keeps the tools of a thread for its life, so
 * a change of a tool that a thread has raises `labToolsVersion`, and a Codex
 * agent with an older thread starts a new one. A tool that only new threads
 * get needs no new version: `verifold_plan` goes only to the agent that opens
 * a lab, and that agent's thread is new. The run tools, the pod tools, and
 * the run proof of `verifold_post` add to the tools. `where` and `lease` of
 * `verifold_run` are optional, so every call of its older schema stays valid.
 * None of them raises a version: a Codex agent whose thread is older keeps
 * its conversation, and gets them with its next new thread.
 */
export const labToolsVersion = 2;

/** The limits of a plan of record. The tool schema and the lab's checks use the same ones. */
export const planLimits = {
  /** Open directions of a lab, and so entries of a plan. */
  directions: 6,
  reading: 600,
  cost: 200,
  title: 120,
  bar: 280,
  runs: 20,
  noise: 120,
  buildsOn: 4,
  buildsOnText: 120,
};

/** The kinds of post that an agent can write. A rerun comes from a checker that Verifold starts. */
export const agentPostKinds = [
  'claim',
  'evidence',
  'objection',
  'question',
  'ruled-out',
] as const;

const postId = { type: 'string', pattern: '^p-[1-9][0-9]{0,5}$' };
const directionId = { type: 'string', pattern: '^d-[1-9][0-9]{0,3}$' };
const runId = { type: 'string', pattern: '^r-[1-9][0-9]{0,5}$' };

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
      "Post to the lab board, in at most 280 characters. A claim, evidence, or ruled-out post needs proof: a file or a figure in your folder, a diff of paths that you changed, or a run of the lab. Verifold commits your folder first and pins a file, a figure, or a diff to that commit. Reply to a post with replyTo. Mention agents by handle (such as claude-1) or the person. A reply, a mention, or an objection in a direction wakes the agent that it is for. A post without one waits for each agent's next read.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: agentPostKinds },
        direction: {
          ...directionId,
          description: 'The direction that the post is about. Default: yours.',
        },
        text: { type: 'string', maxLength: 280 },
        artifacts: {
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
        },
        replyTo: postId,
        mentions: {
          type: 'array',
          maxItems: 5,
          items: {
            type: 'string',
            pattern: '^(person|(claude|codex)-[1-9][0-9]{0,3})$',
          },
        },
      },
      required: ['kind', 'text'],
      additionalProperties: false,
    },
  },
  {
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
export const podToolSpecs: readonly AgentTool[] = [
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
      "Ask for a GPU pod lease for your direction: one GPU of an allowed type, for a number of hours. Pods cost the person money, so ask only when your next runs need a GPU. Verifold refuses a request that does not fit the person's limits. A request inside the limits starts at once, unless the person approves each pod. The reply says which. Verifold wakes you when the pod is ready.",
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
            'Names of the secrets that the pod needs as environment variables, such as HF_TOKEN for gated Hugging Face models. The person stores them in Compute. You never see the values.',
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

/** The plan of record. Only the agent that opened the lab gets this tool. */
export const planToolSpec: AgentTool = {
  name: 'verifold_plan',
  description:
    'Post the plan of record: how you read the question, and the directions that attack it. A new direction has a title, a pass bar in plain words, the repeat runs that the bar needs, the spread that counts as noise, what it builds on (known work or new), and the harness of its agent. Your own direction is `mine`, the index in the list; Verifold opens the others, each with its own agent and folder. Later, call it again to change the plan: list every open direction with its id, with only the fields that change, and new directions without an id.',
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
    },
    required: ['reading', 'directions', 'cost'],
    additionalProperties: false,
  },
};
