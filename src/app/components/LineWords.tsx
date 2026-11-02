import type { ReactNode } from 'react';
import type { BriefLine } from '../../protocol/api.ts';
import { quoteTexts, shownPlain } from '../brief-view.ts';
import { useClip, type Clip } from '../useClip.ts';
import { useView } from '../view-mode.ts';
import { IdText } from './IdText.tsx';

/** Show more or Show less for a clipped text. */
export function ClipToggle({ clip }: { readonly clip: Clip }): ReactNode {
  return (
    <button
      type="button"
      className="see"
      aria-expanded={clip.open}
      onClick={clip.toggle}
    >
      {clip.open ? 'Show less' : 'Show more'}
    </button>
  );
}

/** One cited post as a short quote: two lines, with Show more when it does not fit. */
function Quote({ text }: { readonly text: string }): ReactNode {
  const clip = useClip(text);
  return (
    <blockquote className="quote">
      <div ref={clip.ref} className={clip.open ? undefined : 'later__text'}>
        <IdText text={text} />
      </div>
      {clip.toggles && <ClipToggle clip={clip} />}
    </blockquote>
  );
}

/** What a line shows: its plain words, or each cited post as its own quote, never joined. `original`: the person asked for the quotes. */
export function LineWords({
  line,
  original,
}: {
  readonly line: Pick<BriefLine, 'kind' | 'plain' | 'quotes'>;
  readonly original: boolean;
}): ReactNode {
  const { mode } = useView();
  const plain = shownPlain(line, mode, original);
  if (plain !== null) return <IdText text={plain} />;
  return quoteTexts(line, mode).map((text, index) => (
    <Quote key={index} text={text} />
  ));
}
