import { createHash } from 'node:crypto';
import { posix } from 'node:path';

/**
 * Pure checks of an agent skill's files: its frontmatter, the rules that
 * keep a skill out of the Skills step, and what it can run. Each check reads
 * the files themselves, never what the skill says about itself.
 */

/** One file of a skill, as the commit's tree lists it. `path` is relative to the skill's folder. */
export interface SkillFile {
  readonly path: string;
  /** The git mode: `100644`, `100755`, `120000` (a link), or `160000` (a submodule). */
  readonly mode: string;
  readonly size: number;
  /** The git blob SHA. */
  readonly sha: string;
}

/** The most files and bytes of one skill. */
const skillLimits = { files: 200, bytes: 5 * 1024 * 1024 } as const;

/** The git blob SHA of a file's content: `sha1("blob " + length + "\0" + content)`. */
export function blobSha(content: Buffer): string {
  return createHash('sha1')
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest('hex');
}

/** A skill's name: lowercase letters, digits, and hyphens, at most 64. */
export function validSkillName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

/**
 * A relative path from a commit's tree, safe to join under a folder: no
 * empty, `.`, or `..` part, no backslash or control character, no leading
 * slash, and a bounded length.
 */
export function safeRelativePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 400 &&
    ![...value].some((char) => char === '\\' || char.charCodeAt(0) < 0x20) &&
    value
      .split('/')
      .every(
        (part) => part && part !== '.' && part !== '..' && part.length <= 255,
      )
  );
}

export interface Frontmatter {
  /** Each top-level key, as written. */
  readonly keys: ReadonlySet<string>;
  /** The top-level keys with a text value: plain, quoted, or a block. */
  readonly values: Readonly<Record<string, string>>;
}

const keyLine = /^([A-Za-z0-9_-]+):(.*)$/;

/**
 * The YAML frontmatter at the start of a SKILL.md, read for its top-level
 * keys only. Nested maps and lists count as keys without a text value.
 * Null: the file has no frontmatter.
 */
export function frontmatter(text: string): Frontmatter | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex(
    (line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line),
  );
  if (end < 0) return null;
  const keys = new Set<string>();
  /** Each text value's lines, and whether a literal block (`|`) keeps its line breaks. */
  const parts = new Map<string, { lines: string[]; literal: boolean }>();
  let current: string | null = null;
  for (const line of lines.slice(1, end)) {
    const match = keyLine.exec(line);
    if (match?.[1] !== undefined) {
      const key = match[1];
      const rest = (match[2] ?? '').trim();
      keys.add(key);
      current = key;
      if (/^[|>][+-]?\d*$/.test(rest))
        parts.set(key, { lines: [], literal: rest.startsWith('|') });
      else if (rest) parts.set(key, { lines: [unquote(rest)], literal: false });
      // A nested map or list: the key counts, without a text value.
      else current = null;
      continue;
    }
    // An indented line continues the value of the key before it.
    if (current && (/^\s/.test(line) || !line.trim()))
      parts.get(current)?.lines.push(line.trim());
  }
  const values: Record<string, string> = {};
  for (const [key, part] of parts)
    values[key] = part.literal
      ? part.lines.join('\n').trim()
      : part.lines.join(' ').replace(/\s+/g, ' ').trim();
  return { keys, values };
}

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted?.[2] !== undefined
    ? quoted[1] === '"'
      ? quoted[2].replace(/\\"/g, '"')
      : quoted[2].replace(/''/g, "'")
    : value;
}

/**
 * The SKILL.md text without its `allowed-tools` key, so that Verifold's copy
 * never lets a skill widen what an agent may run without asking. The rest of
 * the file stays as it is.
 */
export function withoutAllowedTools(text: string): string {
  const lines = text.split('\n');
  if (lines[0]?.replace(/^\uFEFF/, '').trim() !== '---') return text;
  const end = lines.findIndex(
    (line, index) => index > 0 && /^(---|\.\.\.)\s*\r?$/.test(line),
  );
  if (end < 0) return text;
  const kept: string[] = [];
  let dropping = false;
  for (const [index, line] of lines.entries()) {
    if (index > 0 && index < end) {
      if (/^allowed-tools:/.test(line)) {
        dropping = true;
        continue;
      }
      // An indented line or a list item continues the dropped key.
      if (dropping && (/^\s/.test(line) || /^-\s/.test(line))) continue;
      dropping = false;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

const archives =
  /\.(zip|tar|gz|tgz|bz2|xz|zst|7z|rar|jar|war|whl|egg|so|dylib|dll|exe|bin|pyc|pyo|class|o|a|node|wasm|mcpb|dxt|dmg|pkg|deb|rpm|apk|msi|iso|pdf)$/i;

/** Image files that a skill may carry as assets, with the bytes that each type starts with. */
const images: readonly (readonly [RegExp, readonly number[]])[] = [
  [/\.png$/i, [0x89, 0x50, 0x4e, 0x47]],
  [/\.jpe?g$/i, [0xff, 0xd8, 0xff]],
  [/\.gif$/i, [0x47, 0x49, 0x46, 0x38]],
  [/\.webp$/i, [0x52, 0x49, 0x46, 0x46]],
];

/**
 * Why a skill is never offered, from its folder name and its tree alone, or
 * null. The rules: hooks, MCP or LSP configuration, archives and other
 * binaries by name, links and submodules, too many files or bytes, and a
 * name outside the skill name rules.
 */
export function treeRefusal(
  name: string,
  files: readonly SkillFile[],
): string | null {
  if (!validSkillName(name))
    return 'Its name is not lowercase letters, digits, and hyphens.';
  if (!files.some((file) => file.path === 'SKILL.md'))
    return 'It has no SKILL.md.';
  if (files.length > skillLimits.files)
    return `It has more than ${skillLimits.files} files.`;
  if (files.reduce((sum, file) => sum + file.size, 0) > skillLimits.bytes)
    return 'It is larger than 5 MB.';
  for (const file of files) {
    const base = posix.basename(file.path);
    if (file.mode === '120000') return 'It has a symbolic link.';
    if (file.mode === '160000') return 'It has a submodule.';
    if (
      base === 'hooks.json' ||
      file.path.split('/').slice(0, -1).includes('hooks')
    )
      return 'It has hooks.';
    if (base === '.mcp.json' || base === '.lsp.json')
      return 'It has MCP or LSP server settings.';
    if (archives.test(base)) return 'It has an archive or a binary file.';
  }
  return null;
}

/**
 * Why a skill is never offered, from its file contents, or null: hooks in
 * its frontmatter, shell commands that a skill's Markdown runs when it
 * loads, MCP server settings, MCP dependencies for Codex, and binary files.
 * `contents` has every file of the skill.
 */
export function contentRefusal(
  files: readonly SkillFile[],
  contents: ReadonlyMap<string, Buffer>,
): string | null {
  const skill = contents.get('SKILL.md');
  if (!skill) return 'It has no SKILL.md.';
  const front = frontmatter(skill.toString('utf8'));
  if (!front?.values.description) return 'Its SKILL.md has no description.';
  if (front.keys.has('hooks')) return 'It has hooks.';
  const name = front.values.name;
  if (name !== undefined && !validSkillName(name))
    return 'Its name is not lowercase letters, digits, and hyphens.';
  for (const file of files) {
    const content = contents.get(file.path);
    if (!content) return 'A file of it could not be read.';
    const image = images.find(([pattern]) => pattern.test(file.path));
    if (image) {
      // An image must start as its type does, so no program hides behind its name.
      if (!image[1].every((byte, index) => content[index] === byte))
        return 'It has a binary file.';
      continue;
    }
    if (content.subarray(0, 1024).includes(0)) return 'It has a binary file.';
    const text = content.toString('utf8');
    // Codex reads skills from nested folders too, so a nested SKILL.md is checked the same way.
    if (
      posix.basename(file.path) === 'SKILL.md' &&
      frontmatter(text)?.keys.has('hooks')
    )
      return 'It has hooks.';
    if (
      /\.(md|markdown)$/i.test(file.path) &&
      (/!`[^`\n]+`/.test(text) || /^\s*```!/m.test(text))
    )
      return 'Its Markdown runs shell commands when it loads.';
    if (
      /\b(mcpServers|mcp_servers)\b/.test(text) &&
      !/\.(md|markdown)$/i.test(file.path)
    )
      return 'It has MCP server settings.';
    if (file.path === 'agents/openai.yaml' && /type:\s*["']?mcp\b/i.test(text))
      return 'It asks Codex to install MCP servers.';
  }
  return null;
}

/** What a skill can run, from its files. */
export interface SkillRuns {
  /** Script languages, with how many files of each. */
  readonly scripts: readonly {
    readonly language: string;
    readonly files: number;
  }[];
  /** Files with the executable mode. */
  readonly executables: number;
  /** Install and download commands that its files name: `pip install`, `uv`, `npm install`, `curl`, `wget`. */
  readonly installs: readonly string[];
  /** Up to 5 web hosts that its files name, the most named first. */
  readonly hosts: readonly string[];
}

const languages: readonly (readonly [RegExp, string])[] = [
  [/\.py$/i, 'Python'],
  [/\.(sh|bash|zsh)$/i, 'shell'],
  [/\.(js|mjs|cjs)$/i, 'JavaScript'],
  [/\.(ts|mts|cts)$/i, 'TypeScript'],
  [/\.rb$/i, 'Ruby'],
  [/\.pl$/i, 'Perl'],
  [/\.r$/i, 'R'],
  [/\.jl$/i, 'Julia'],
  [/\.ps1$/i, 'PowerShell'],
];

const shebangs: readonly (readonly [RegExp, string])[] = [
  [/python/, 'Python'],
  [/\b(ba|z)?sh\b/, 'shell'],
  [/\b(node|deno|bun)\b/, 'JavaScript'],
  [/\bruby\b/, 'Ruby'],
  [/\bperl\b/, 'Perl'],
  [/\bRscript\b/, 'R'],
  [/\bjulia\b/, 'Julia'],
];

const installs: readonly (readonly [RegExp, string])[] = [
  [/\bpip3?\s+install\b/, 'pip install'],
  [/\buv\s+(pip\s+install|add|tool\s+install|run)\b/, 'uv'],
  [/\bnpm\s+(install|i)\b|\bnpx\s/, 'npm install'],
  [/\bcurl\s/, 'curl'],
  [/\bwget\s/, 'wget'],
];

const quietHosts = new Set(['localhost', 'example.com', 'example.org']);

export function whatItRuns(
  files: readonly SkillFile[],
  contents: ReadonlyMap<string, Buffer>,
): SkillRuns {
  const counts = new Map<string, number>();
  const found = new Set<string>();
  const hosts = new Map<string, number>();
  for (const file of files) {
    const text = contents.get(file.path)?.toString('utf8') ?? '';
    const first = text.slice(0, 200).split('\n')[0] ?? '';
    const language =
      languages.find(([pattern]) => pattern.test(file.path))?.[1] ??
      (first.startsWith('#!')
        ? shebangs.find(([pattern]) => pattern.test(first))?.[1]
        : undefined);
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
    for (const [pattern, label] of installs)
      if (pattern.test(text)) found.add(label);
    for (const match of text.matchAll(
      /https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?![a-z0-9-])/gi,
    )) {
      const host = (match[1] ?? '').toLowerCase().replace(/^www\./, '');
      if (host && !quietHosts.has(host))
        hosts.set(host, (hosts.get(host) ?? 0) + 1);
    }
  }
  return {
    scripts: [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([language, count]) => ({ language, files: count })),
    executables: files.filter((file) => file.mode === '100755').length,
    installs: installs
      .map(([, label]) => label)
      .filter((label) => found.has(label)),
    hosts: [...hosts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([host]) => host),
  };
}

/** A short license name from a license file's text, or null. */
export function licenseName(text: string): string | null {
  if (
    /\bMIT License\b|Permission is hereby granted, free of charge/i.test(text)
  )
    return 'MIT';
  if (/Apache License,?\s+Version 2\.0/i.test(text)) return 'Apache-2.0';
  if (/\bBSD\b.*\bLicense\b/i.test(text)) return 'BSD';
  if (/GNU GENERAL PUBLIC LICENSE/i.test(text)) return 'GPL';
  return null;
}
