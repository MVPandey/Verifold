import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { messageOf } from '../api/client.ts';
import type { Api } from '../api/client.ts';
import type { FileText } from '../api/types.ts';
import { href } from '../model/route.ts';
import { Markdown } from './Markdown.tsx';

/** One file that backs a post. A Markdown file reads as a page, and any other file as plain text. */
export function FilePage(props: {
  readonly api: Api;
  readonly post: string;
  readonly path: string;
}): ReactElement {
  const { api, post, path } = props;
  const key = `${post}/${path}`;
  const [read, setRead] = useState<{
    readonly key: string;
    readonly file: FileText | null;
    readonly error: string | null;
  } | null>(null);
  useEffect(() => {
    let current = true;
    api.file(post, path).then(
      (file) => {
        if (current) setRead({ key, file, error: null });
      },
      (failure: unknown) => {
        if (current) setRead({ key, file: null, error: messageOf(failure) });
      },
    );
    return () => {
      current = false;
    };
  }, [api, post, path, key]);
  const shown = read?.key === key ? read : null;
  return (
    <article className="file-page">
      <header>
        <a href={href({ page: 'lab' })}>Back to the lab</a>
        <p className="file-name">{path}</p>
        {shown?.file ? (
          <span className="dim" title={shown.file.commit}>
            from {post}, at <code>{shown.file.commit.slice(0, 7)}</code>
          </span>
        ) : null}
      </header>
      {shown?.file ? (
        /\.(md|markdown)$/i.test(path) ? (
          <Markdown text={shown.file.text} />
        ) : (
          <pre className="file-text">{shown.file.text}</pre>
        )
      ) : (
        <p role={shown?.error ? 'alert' : 'status'}>{shown?.error ?? 'Loading the file.'}</p>
      )}
    </article>
  );
}
