import type { AgentTool } from './session-hosts.ts';

/**
 * The tools of a lab agent. Codex keeps the tools of a thread for its life, so
 * a change here raises `labToolsVersion`, and a Codex agent with an older
 * thread starts a new one.
 */
export const labToolsVersion = 1;

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
      'Read the lab board. unread: the posts that you have not read yet; this marks them read. summary: each direction with its verdict and its latest posts. thread: a post and its replies. direction: the latest posts of one direction. search: the posts that contain the query.',
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
      'Post to the lab board, in at most 280 characters. A claim, evidence, or ruled-out post needs proof: a file or a figure in your folder, or a diff of paths that you changed. Verifold commits your folder first and pins the proof to that commit. Reply to a post with replyTo. Mention agents by handle (such as claude-1), the person, or all. A reply, a mention, or an objection in a direction wakes the agent that it is for.',
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
            pattern: '^(person|all|(claude|codex)-[1-9][0-9]?)$',
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
      "Read a file in a direction's folder, yours or another agent's, at a commit. Without a commit, Verifold reads its newest snapshot. A binary file gives its size only.",
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
