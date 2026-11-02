/**
 * The lab's brief, its notices, and the person's questions, in
 * `.verifold/lab/brief.json`. The store keeps them in memory, read once at
 * load. The lab's queue runs every change, so the store has no lock of its
 * own. Plain words stay in this record and on the wire: no prompt, digest, or
 * board read takes them, and a lab agent's harness denies the file. A harness
 * can write in the project, so the file is parsed with care and a bad entry is
 * skipped.
 */
import { join } from 'node:path';
import { agentId, number, object, postId, type Post } from '../board.ts';
import type { HarnessName } from '../harness.ts';
import { briefKinds, briefLimits, noticeKinds } from '../lab-tools.ts';
import { usdValue, type SessionRecord } from '../session.ts';
import { readObject, RecordFile } from './record-file.ts';
import type {
  BriefLine,
  BriefRecord,
  BriefView,
  LineCheck,
  LineState,
  Notice,
  Question,
  SessionMark,
  Spend,
} from './schema.ts';
import { addSpend } from './words.ts';

const empty: BriefView = {
  brief: null,
  notices: [],
  questions: [],
  sessions: [],
};

const isTime = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));

const isHarness = (value: unknown): value is HarnessName =>
  value === 'claude' || value === 'codex';

const strings = (value: unknown, limit: number): readonly string[] =>
  (Array.isArray(value) ? value : [])
    .filter((item): item is string => typeof item === 'string')
    .slice(0, limit);

function parseCheck(value: unknown): LineCheck {
  const entry = object(value);
  const states: readonly LineState[] = [
    'pending',
    'passed',
    'failed',
    'numbers',
    'withheld',
  ];
  const state = states.find((item) => item === entry?.state);
  // A check that the file does not show never counts as passed.
  return state && entry
    ? {
        state,
        by: isHarness(entry.by) ? entry.by : null,
        sameHarness: entry.sameHarness === true,
        problems: strings(entry.problems, briefLimits.claims),
      }
    : { state: 'pending', by: null, sameHarness: false, problems: [] };
}

function parseLine(value: unknown): BriefLine | null {
  const entry = object(value);
  const kind = [...briefKinds, 'answer' as const].find(
    (item) => item === entry?.kind,
  );
  const posts = strings(entry?.posts, briefLimits.linePosts).filter((id) =>
    postId.test(id),
  );
  return entry &&
    kind &&
    typeof entry.id === 'string' &&
    /^l-[1-9]\d{0,6}$/.test(entry.id) &&
    isTime(entry.at) &&
    typeof entry.plain === 'string' &&
    entry.plain.length <= briefLimits.answer &&
    posts.length &&
    isHarness(entry.writer)
    ? {
        id: entry.id,
        kind,
        at: entry.at,
        plain: entry.plain,
        posts,
        writer: entry.writer,
        check: parseCheck(entry.check),
      }
    : null;
}

function parseBrief(value: unknown): BriefRecord | null {
  const entry = object(value);
  return entry &&
    isTime(entry.at) &&
    typeof entry.key === 'string' &&
    Number.isSafeInteger(entry.through) &&
    Array.isArray(entry.lines)
    ? {
        at: entry.at,
        key: entry.key,
        through: entry.through as number,
        lines: entry.lines
          .slice(0, briefLimits.lines)
          .flatMap((line) => parseLine(line) ?? []),
      }
    : null;
}

function parseNotice(value: unknown): Notice | null {
  const entry = object(value);
  const kind = noticeKinds.find((item) => item === entry?.kind);
  return entry &&
    kind &&
    typeof entry.id === 'string' &&
    /^n-[1-9]\d{0,6}$/.test(entry.id) &&
    isTime(entry.at)
    ? {
        id: entry.id,
        at: entry.at,
        kind,
        posts: strings(entry.posts, briefLimits.linePosts).filter((id) =>
          postId.test(id),
        ),
        to: strings(entry.to, briefLimits.linePosts).filter((id) =>
          agentId.test(id),
        ),
      }
    : null;
}

function parseQuestion(value: unknown): Question | null {
  const entry = object(value);
  const states = ['waiting', 'answered', 'unanswered'] as const;
  const state = states.find((item) => item === entry?.state);
  return entry &&
    state &&
    typeof entry.id === 'string' &&
    /^q-[1-9]\d{0,6}$/.test(entry.id) &&
    isTime(entry.at) &&
    typeof entry.text === 'string' &&
    entry.text &&
    entry.text.length <= briefLimits.question
    ? {
        id: entry.id,
        at: entry.at,
        text: entry.text,
        state,
        answer: parseLine(entry.answer),
      }
    : null;
}

function parseMark(value: unknown): SessionMark | null {
  const entry = object(value);
  return entry &&
    isTime(entry.at) &&
    (entry.kind === 'update' || entry.kind === 'check')
    ? { at: entry.at, kind: entry.kind }
    : null;
}

function parseSpend(value: unknown): Spend | null {
  const entry = object(value);
  return entry &&
    usdValue(entry.usd) &&
    usdValue(entry.seen) &&
    typeof entry.session === 'string'
    ? { usd: entry.usd, session: entry.session, seen: entry.seen }
    : null;
}

/** Where plain words are on disk: this record, the threads with their titles for the person, and the transcripts of the sessions that wrote them. */
export function plainPaths(roots: readonly string[]): readonly string[] {
  return [...new Set(roots)].flatMap((root) => [
    join(root, '.verifold', 'lab', 'brief.json'),
    join(root, '.verifold', 'lab', 'threads.json'),
    join(root, '.verifold', 'sessions'),
  ]);
}

export class BriefStore {
  private record: BriefView = empty;
  /** The highest number of a line, a notice, and a question. */
  private last = 0;
  private touched = false;
  private readonly path: string;
  private readonly file: RecordFile;

  /** `paused`: the lab's records moved, so nothing writes until the next load. */
  constructor(path: string, paused: () => boolean) {
    this.path = path;
    this.file = new RecordFile(path, () =>
      paused() ? null : { schemaVersion: 1, ...this.record },
    );
  }

  /** Read the records. `on`: a lab with threads. Any other lab holds none. */
  async load(on: boolean): Promise<void> {
    const saved = on ? await readObject(this.path) : null;
    this.touched = false;
    const list = (value: unknown, limit: number): readonly unknown[] =>
      (Array.isArray(value) ? value : []).slice(-limit);
    const spend = parseSpend(saved?.spend);
    this.record = {
      brief: parseBrief(saved?.brief),
      notices: list(saved?.notices, briefLimits.notices).flatMap(
        (item) => parseNotice(item) ?? [],
      ),
      questions: list(saved?.questions, briefLimits.questions).flatMap(
        (item) => parseQuestion(item) ?? [],
      ),
      sessions: list(saved?.sessions, briefLimits.sessions).flatMap(
        (item) => parseMark(item) ?? [],
      ),
      ...(spend ? { spend } : {}),
    };
    const { brief, notices, questions } = this.record;
    this.last = Math.max(
      0,
      ...[...(brief?.lines ?? []), ...notices, ...questions].map(({ id }) =>
        number(id),
      ),
      ...questions.map(({ answer }) => (answer ? number(answer.id) : 0)),
    );
  }

  /** Wait until the newest records are on disk. */
  flush(): Promise<void> {
    return this.file.flush();
  }

  /** Write the file once, so a run that starts before the first brief can deny it. */
  async touch(): Promise<void> {
    if (this.touched) return;
    this.touched = true;
    await this.file.save().catch(() => {});
  }

  /** What the store holds. The same object until something changes. */
  view(): BriefView {
    return this.record;
  }

  private change(next: Partial<BriefView>): void {
    this.record = { ...this.record, ...next };
    void this.file.save().catch(() => {});
  }

  /** A line with a new ID. `stray`: the numbers that its posts do not hold. A line with no plain words is withheld, and gets no check. */
  line(
    fields: Pick<BriefLine, 'kind' | 'plain' | 'writer'>,
    posts: readonly Pick<Post, 'id' | 'at'>[],
    stray: readonly string[],
  ): BriefLine {
    this.last += 1;
    return {
      ...fields,
      id: `l-${this.last}`,
      at:
        posts
          .map((post) => post.at)
          .sort()
          .at(-1) ?? new Date().toISOString(),
      posts: posts.map((post) => post.id),
      check: {
        state: !fields.plain
          ? 'withheld'
          : stray.length
            ? 'numbers'
            : 'pending',
        by: null,
        sameHarness: false,
        problems: stray,
      },
    };
  }

  /** A new brief replaces the last one. */
  setBrief(brief: BriefRecord): void {
    this.change({ brief });
  }

  /** The session's own change of the state: the brief covers it. */
  rekey(before: string, after: string): void {
    const { brief } = this.record;
    if (brief?.key === before) this.change({ brief: { ...brief, key: after } });
  }

  /** The lines that wait for a check: those of the brief, then the answers. */
  pending(): readonly BriefLine[] {
    const { brief, questions } = this.record;
    return [
      ...(brief?.lines ?? []),
      ...questions.flatMap(({ answer }) => answer ?? []),
    ].filter((line) => line.check.state === 'pending');
  }

  /** The result of a line check. A line that a newer brief replaced is gone, so its result changes nothing. */
  settle(checks: ReadonlyMap<string, LineCheck>): void {
    const checked = (line: BriefLine): BriefLine => {
      const check = checks.get(line.id);
      return check ? { ...line, check } : line;
    };
    const { brief, questions } = this.record;
    this.change({
      brief: brief ? { ...brief, lines: brief.lines.map(checked) } : null,
      questions: questions.map((question) =>
        question.answer
          ? { ...question, answer: checked(question.answer) }
          : question,
      ),
    });
  }

  addNotice(fields: Omit<Notice, 'id' | 'at'>): Notice {
    this.last += 1;
    const notice: Notice = {
      ...fields,
      id: `n-${this.last}`,
      at: new Date().toISOString(),
    };
    this.change({
      notices: [...this.record.notices, notice].slice(-briefLimits.notices),
    });
    return notice;
  }

  addQuestion(text: string): Question {
    this.last += 1;
    const question: Question = {
      id: `q-${this.last}`,
      at: new Date().toISOString(),
      text,
      state: 'waiting',
      answer: null,
    };
    this.change({
      questions: [...this.record.questions, question].slice(
        -briefLimits.questions,
      ),
    });
    return question;
  }

  /** The question gets its answer, or none: its session ended without one. */
  answer(id: string, answer: BriefLine | null): void {
    this.change({
      questions: this.record.questions.map((question) =>
        question.id === id
          ? { ...question, state: answer ? 'answered' : 'unanswered', answer }
          : question,
      ),
    });
  }

  /** A session of `kind` started. */
  mark(kind: SessionMark['kind']): void {
    this.change({
      sessions: [
        ...this.record.sessions,
        { at: new Date().toISOString(), kind },
      ].slice(-briefLimits.sessions),
    });
  }

  /** Sessions of `kind` after the time `since`, in milliseconds. */
  count(kind: SessionMark['kind'], since: number): number {
    return this.record.sessions.filter(
      (entry) => entry.kind === kind && Date.parse(entry.at) > since,
    ).length;
  }

  /** Add what a session spent, from Claude Code's estimate. */
  spent(record: SessionRecord): void {
    const spend = addSpend(this.record.spend, record);
    if (spend && spend !== this.record.spend) this.change({ spend });
  }
}
