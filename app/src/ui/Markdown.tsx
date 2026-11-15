import { memo } from 'react';
import type { ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { postMarkdown } from '../model/posts.ts';

/**
 * Markdown as a page: a file, or with `post` the body of a post. HTML in the text stays text, an image becomes
 * its words, and a link goes only to a web page, so the text cannot load anything or run a script.
 *
 * A post's body keeps its line breaks, and `~5` in it is no strike-through, because agents write bodies as plain
 * lines too. A thread shows hundreds of bodies and reads them again at every change in the lab, so the same text
 * does not render twice.
 */
export const Markdown = memo(function Markdown(props: {
  readonly text: string;
  readonly post?: boolean;
}): ReactElement {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[[remarkGfm, { singleTilde: !props.post }]]}
        urlTransform={(url) => (/^https?:\/\//i.test(url) ? url : '')}
        components={{
          img: ({ alt }) => <span>{alt}</span>,
          a: ({ href, children }) =>
            href ? (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          table: ({ children }) => (
            <div className="md-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {props.post ? postMarkdown(props.text) : props.text}
      </ReactMarkdown>
    </div>
  );
});
