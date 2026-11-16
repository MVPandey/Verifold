import { Component, memo, useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import type { FileEvidence } from '../api/types.ts';
import { linkHost, plainOnly } from '../model/markdown.ts';
import { Body, Files } from './parts.tsx';

/**
 * Shows `fallback` in place of its children when one of them fails to render. Without it, React takes the whole
 * page away after any error in a render.
 */
export class Boundary extends Component<
  { readonly fallback: ReactNode; readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** A part of a parsed Markdown text, as far as the link's text needs it. */
interface TextNode {
  readonly type: string;
  readonly value?: string;
  readonly children?: readonly TextNode[];
}

function textOf(node: TextNode): string {
  return node.value ?? (node.children ?? []).map(textOf).join('');
}

/**
 * The parsed text. HTML in it stays text, an image becomes its words, and a link goes only to a web page, so the
 * text cannot load anything or run a script. A link has its whole target as its title, and when its text is not
 * the target, the target's host follows it in plain characters.
 *
 * A thread shows hundreds of bodies and reads them again at every change in the lab, so the same text does not
 * parse twice.
 */
const Parsed = memo(function Parsed(props: {
  readonly text: string;
  readonly post: boolean;
}): ReactElement {
  return (
    <ReactMarkdown
      remarkPlugins={props.post ? [[remarkGfm, { singleTilde: false }], remarkBreaks] : [remarkGfm]}
      urlTransform={(url) => (/^https?:\/\//i.test(url) ? url : '')}
      components={{
        img: ({ alt }) => <span>{alt}</span>,
        a: ({ href, children, node }) => {
          if (!href) return <span>{children}</span>;
          const host = node ? linkHost(textOf(node), href) : null;
          return (
            <>
              <a href={href} title={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
              {host ? <span className="md-host"> ({host})</span> : null}
            </>
          );
        },
        table: ({ children }) => (
          <div className="md-table">
            <table>{children}</table>
          </div>
        ),
      }}
    >
      {props.text}
    </ReactMarkdown>
  );
});

/**
 * Markdown as a page: a file, or with `post` the body of a post.
 *
 * A post's body keeps its line ends as line breaks, and `~5` in it is no strike-through, because agents write
 * bodies as plain lines too. Everything else has its standard Markdown meaning.
 *
 * A text never takes the page down. One that the parser cannot take shows as plain text without a try, and so
 * does one that fails in the parser or in the render all the same.
 */
export function Markdown(props: { readonly text: string; readonly post?: boolean }): ReactElement {
  const text = props.text.replace(/\r\n?/g, '\n');
  const plain = props.post ? <Body text={text} /> : <pre className="file-text">{text}</pre>;
  if (plainOnly(text)) return plain;
  return (
    // The key gives a new text a new try after a text that failed.
    <Boundary key={text} fallback={plain}>
      <div className="md">
        <Parsed text={text} post={props.post ?? false} />
      </div>
    </Boundary>
  );
}

/**
 * A post's body. It shows as Markdown, and one control switches this post to the exact text that its author
 * wrote, as plain text, and back. Markdown changes some plain text, such as `*` in a file pattern or `__` in a
 * name, so the exact text is always one press away, to read and to copy.
 *
 * Without `parsed`, the body shows as plain paragraphs and nothing parses it: that is a body inside a fold that
 * the person has not opened.
 */
export function Words(props: {
  readonly text: string;
  readonly parsed?: boolean;
  /** Whether the body shows as written at first. */
  readonly written?: boolean;
}): ReactElement {
  const [written, setWritten] = useState(props.written ?? false);
  return (
    <div className="words">
      {written ? (
        <pre className="as-written">{props.text}</pre>
      ) : (props.parsed ?? true) ? (
        <Markdown text={props.text} post />
      ) : (
        <Body text={props.text} />
      )}
      <button
        type="button"
        className="linkbtn as-toggle"
        onClick={() => {
          setWritten(!written);
        }}
      >
        {written ? 'Show formatted' : 'Show as written'}
      </button>
    </div>
  );
}

/**
 * The detail of a post behind a fold: its body and its files. The body parses as Markdown when the person first
 * opens the fold, so a thread of hundreds of posts parses only what somebody reads. Until then the body is in the
 * page as plain text, where the browser's search finds it.
 *
 * With `open`, the fold is open at first, as on the report card, and the person can close it. With `label`, the box
 * is a region of the page with that name, for a box that scrolls, as on the report card. While its content is taller
 * than the box, the box takes the keyboard's focus, so that the keys scroll it.
 */
export function Detail(props: {
  readonly post: string;
  readonly body: string;
  readonly files: readonly FileEvidence[];
  readonly open?: boolean;
  readonly label?: string;
}): ReactElement | null {
  const [open, setOpen] = useState(props.open ?? false);
  const [opened, setOpened] = useState(open);
  const [scrolls, setScrolls] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current;
    if (props.label === undefined || !element) return;
    // The observer reports the box's size when it starts and at each change, such as in a narrower window.
    const watch = new ResizeObserver(() => {
      setScrolls(element.scrollHeight > element.clientHeight);
    });
    watch.observe(element);
    return () => {
      watch.disconnect();
    };
  }, [props.label]);
  if (!props.body && props.files.length === 0) return null;
  return (
    <details
      className="f-detail"
      open={open}
      onToggle={(event) => {
        const now = event.currentTarget.open;
        setOpen(now);
        if (now) setOpened(true);
      }}
    >
      <summary className="f-open">
        <span className="closed">Read the detail</span>
        <span className="opened">Hide the detail</span>
      </summary>
      <div
        ref={box}
        className="f-words"
        role={props.label ? 'region' : undefined}
        aria-label={props.label}
        tabIndex={scrolls ? 0 : undefined}
      >
        {props.body ? <Words text={props.body} parsed={opened} /> : null}
        <Files post={props.post} files={props.files} />
      </div>
    </details>
  );
}
