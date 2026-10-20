import type { AgentTool } from './session-hosts.ts';

/**
 * The tools of a lab agent. Codex keeps the tools of a thread for its life, so
 * a change here raises `labToolsVersion`, and a Codex agent with an older
 * thread starts a new one.
 */
export const labToolsVersion = 2;

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
      "Post to the lab board, in at most 280 characters. A claim, evidence, or ruled-out post needs proof: a file or a figure in your folder, or a diff of paths that you changed. Verifold commits your folder first and pins the proof to that commit. Reply to a post with replyTo. Mention agents by handle (such as claude-1) or the person. A reply, a mention, or an objection in a direction wakes the agent that it is for. A post without one waits for each agent's next read.",
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
              type: { type: 'string', enum: ['file', 'figure', 'diff'] },
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

/** The plan of record. Only the agent that opened the lab gets this tool. */
export const planToolSpec: AgentTool = {
  name: 'verifold_plan',
  description:
    'Post the plan of record: how you read the question, and the directions that attack it. Each direction has a pass bar in plain words, the repeat runs that the bar needs, the spread that counts as noise, what it builds on (known work or new), and the harness of its agent. Your own direction is `mine`, the index in the list; Verifold opens the others, each with its own agent and folder. Later, call it again to change the plan: list every open direction with its id, and new ones without an id.',
  inputSchema: {
    type: 'object',
    properties: {
      reading: {
        type: 'string',
        maxLength: 600,
        description: 'How you read the question, in plain words.',
      },
      directions: {
        type: 'array',
        minItems: 1,
        maxItems: 6,
        items: {
          type: 'object',
          properties: {
            id: {
              ...directionId,
              description: 'An open direction that this entry changes.',
            },
            title: { type: 'string', maxLength: 80 },
            bar: {
              type: 'string',
              maxLength: 240,
              description:
                'What makes the direction hold up, in plain words, with its number.',
            },
            runs: {
              type: 'integer',
              minimum: 1,
              maximum: 20,
              description:
                'The repeat runs, such as seeds, that the bar needs.',
            },
            noise: {
              type: 'string',
              maxLength: 120,
              description:
                'The spread between repeat runs that counts as noise, such as ±0.02.',
            },
            buildsOn: {
              type: 'array',
              maxItems: 4,
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string', maxLength: 120 },
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
            harness: { type: 'string', enum: ['claude', 'codex'] },
          },
          required: ['title', 'bar', 'runs', 'noise', 'harness'],
          additionalProperties: false,
        },
      },
      mine: {
        type: 'integer',
        minimum: 0,
        maximum: 5,
        description: 'The index of your own direction. Default: 0.',
      },
      cost: {
        type: 'string',
        maxLength: 200,
        description: 'What in the plan costs money, or that nothing does yet.',
      },
    },
    required: ['reading', 'directions', 'cost'],
    additionalProperties: false,
  },
};
