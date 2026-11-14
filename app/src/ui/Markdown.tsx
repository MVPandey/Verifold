import type { ReactElement, ReactNode } from 'react';

import { parseMarkdown } from '../model/markdown.ts';
import type { Block, Inline } from '../model/markdown.ts';

/** A Markdown file as a page. Every piece renders as text, so a file cannot load an image or run a script. */
export function Markdown(props: { readonly text: string }): ReactElement {
  return (
    <div className="md">
      {parseMarkdown(props.text).map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </div>
  );
}

function BlockView(props: { readonly block: Block }): ReactElement {
  const { block } = props;
  switch (block.type) {
    case 'heading': {
      const Tag = `h${Math.min(block.level + 1, 6)}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      return <Tag>{spans(block.parts)}</Tag>;
    }
    case 'paragraph':
      return <p>{spans(block.parts)}</p>;
    case 'quote':
      return <blockquote>{spans(block.parts)}</blockquote>;
    case 'code':
      return (
        <pre>
          <code>{block.text}</code>
        </pre>
      );
    case 'rule':
      return <hr />;
    case 'list': {
      const List = block.ordered ? 'ol' : 'ul';
      return (
        <List>
          {block.items.map((item, index) => (
            <li key={index} className={`md-d${Math.min(item.depth, 3)}`}>
              {spans(item.parts)}
            </li>
          ))}
        </List>
      );
    }
    case 'table':
      return (
        <div className="md-table">
          <table>
            <thead>
              <tr>
                {block.head.map((cell, index) => (
                  <th key={index}>{spans(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, index) => (
                <tr key={index}>
                  {row.map((cell, column) => (
                    <td key={column}>{spans(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function spans(parts: readonly Inline[]): ReactNode {
  return parts.map((part, index) => {
    switch (part.type) {
      case 'text':
        return part.text;
      case 'code':
        return <code key={index}>{part.text}</code>;
      case 'strong':
        return <strong key={index}>{spans(part.parts)}</strong>;
      case 'em':
        return <em key={index}>{spans(part.parts)}</em>;
      case 'link':
        return (
          <a key={index} href={part.href} target="_blank" rel="noreferrer noopener">
            {spans(part.parts)}
          </a>
        );
    }
  });
}
