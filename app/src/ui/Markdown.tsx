import type { ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * A Markdown file as a page. HTML in the file stays text, an image becomes its words, and a link goes only to a
 * web page, so a file cannot load anything or run a script.
 */
export function Markdown(props: { readonly text: string }): ReactElement {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
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
        {props.text}
      </ReactMarkdown>
    </div>
  );
}
