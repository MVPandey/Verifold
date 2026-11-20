import { useId, useState } from 'react';
import type { ReactElement } from 'react';

import type { Api } from '../api/client.ts';
import { messageOf } from '../api/client.ts';
import { GUEST } from '../api/types.ts';
import type { AgentView, LabView } from '../api/types.ts';
import { tokens } from '../model/format.ts';
import { wholeField } from '../model/limits.ts';
import {
  DEFAULT_COORDINATOR_TOKENS,
  MAX_TOKENS_PER_HOUR,
  labCapLine,
  nextTime,
} from '../model/pace.ts';

/** Run one call of the person's pace, then read the lab again. A refusal shows its reason. */
function useSend(onChange: () => void): {
  readonly error: string | null;
  readonly busy: boolean;
  readonly send: (sent: Promise<LabView>) => void;
} {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = (sent: Promise<LabView>): void => {
    setBusy(true);
    setError(null);
    sent.then(
      () => {
        setBusy(false);
        onChange();
      },
      (failure: unknown) => {
        setBusy(false);
        setError(messageOf(failure));
      },
    );
  };
  return { error, busy, send };
}

/**
 * The person's pace for one seat, in its profile: pause it until a time or until a resume, resume it, and set or
 * remove its limit of tokens per hour. A move of the person replaces the coordinator's. The desk and an invited
 * agent take none.
 */
export function SeatPaceControls(props: {
  readonly api: Api;
  readonly view: AgentView;
  readonly now: Date;
  readonly onChange: () => void;
}): ReactElement | null {
  const { view, api } = props;
  const agent = view.agent.id;
  const [until, setUntil] = useState('');
  const [limit, setLimit] = useState('');
  const { error, busy, send } = useSend(props.onChange);
  const id = useId();
  if (view.desk || view.agent.harness === GUEST) return null;
  const at = until.trim() ? nextTime(until, props.now) : null;
  const tokensPerHour = wholeField(limit, MAX_TOKENS_PER_HOUR);
  const own = view.cap && !view.cap.share ? view.cap : null;
  return (
    <div className="i-pace">
      {view.pause ? (
        <button
          className="btn small"
          type="button"
          disabled={busy}
          onClick={() => send(api.setPace({ type: 'resume', agent }))}
        >
          Resume
        </button>
      ) : (
        <div className="budget">
          <label htmlFor={`${id}-until`}>Pause until</label>
          <input
            id={`${id}-until`}
            value={until}
            placeholder="14:30, or empty"
            onChange={(event) => setUntil(event.target.value)}
          />
          <button
            className="btn small"
            type="button"
            disabled={busy || (until.trim() !== '' && at === null)}
            onClick={() => send(api.setPace({ type: 'pause', agent, until: at }))}
          >
            Pause
          </button>
        </div>
      )}
      {until.trim() !== '' && at === null && !view.pause ? (
        <p className="note">Type a time of day such as 14:30.</p>
      ) : null}
      <p className="f-where">
        {view.pause
          ? 'Until it goes on, only your posts start its next turn.'
          : 'A paused agent finishes its turn. Then only your posts start its next turn. An empty field pauses it until you resume it.'}
      </p>
      <div className="budget">
        <label htmlFor={`${id}-limit`}>Tokens per hour</label>
        <input
          id={`${id}-limit`}
          inputMode="numeric"
          value={limit}
          placeholder={own ? tokens(own.tokens_per_hour) : 'No limit'}
          onChange={(event) => setLimit(event.target.value)}
        />
        <button
          className="btn small"
          type="button"
          disabled={busy || typeof tokensPerHour !== 'number'}
          onClick={() => {
            if (typeof tokensPerHour === 'number') {
              send(api.setPace({ type: 'cap', agent, tokens_per_hour: tokensPerHour }));
              setLimit('');
            }
          }}
        >
          Set limit
        </button>
        {own ? (
          <button
            className="linkbtn"
            type="button"
            disabled={busy}
            onClick={() => send(api.setPace({ type: 'cap', agent, tokens_per_hour: null }))}
          >
            Remove limit
          </button>
        ) : null}
      </div>
      {tokensPerHour === undefined ? <p className="note">Type a whole number of tokens.</p> : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The lab's limit of tokens per hour and the coordinator's own limit, in the panel of the lab's time. A change
 * counts for this lab only. Settings keeps what new labs start with.
 */
export function LabPaceControls(props: {
  readonly api: Api;
  readonly lab: LabView;
  readonly onChange: () => void;
}): ReactElement {
  const { lab, api } = props;
  const [limit, setLimit] = useState('');
  const current = lab.settings.pace?.coordinator_tokens_per_hour ?? DEFAULT_COORDINATOR_TOKENS;
  const [share, setShare] = useState(String(current));
  const { error, busy, send } = useSend(props.onChange);
  const id = useId();
  const tokensPerHour = wholeField(limit, MAX_TOKENS_PER_HOUR);
  const plain = share.replace(/[\s,_]/g, '');
  const shareValue = /^\d+$/.test(plain) ? Number(plain) : undefined;
  const shareOk = shareValue !== undefined && shareValue <= MAX_TOKENS_PER_HOUR;
  return (
    <div className="limits">
      <p>{labCapLine(lab.lab_cap)}</p>
      <div className="budget">
        <label htmlFor={`${id}-lab`}>Tokens per hour for the lab</label>
        <input
          id={`${id}-lab`}
          inputMode="numeric"
          value={limit}
          placeholder={lab.lab_cap ? tokens(lab.lab_cap.tokens_per_hour) : 'No limit'}
          onChange={(event) => setLimit(event.target.value)}
        />
        <button
          className="btn small"
          type="button"
          disabled={busy || typeof tokensPerHour !== 'number'}
          onClick={() => {
            if (typeof tokensPerHour === 'number') {
              send(api.setPace({ type: 'cap', tokens_per_hour: tokensPerHour }));
              setLimit('');
            }
          }}
        >
          Set limit
        </button>
        {lab.lab_cap ? (
          <button
            className="linkbtn"
            type="button"
            disabled={busy}
            onClick={() => send(api.setPace({ type: 'cap', tokens_per_hour: null }))}
          >
            Remove limit
          </button>
        ) : null}
      </div>
      <div className="budget">
        <label htmlFor={`${id}-share`}>Tokens per hour for the coordinator</label>
        <input
          id={`${id}-share`}
          inputMode="numeric"
          value={share}
          onChange={(event) => setShare(event.target.value)}
        />
        <button
          className="btn small"
          type="button"
          disabled={busy || !shareOk || shareValue === current}
          onClick={() => {
            if (shareValue !== undefined) send(api.setCoordinatorShare(shareValue));
          }}
        >
          Set limit
        </button>
      </div>
      <p className="quiet">
        At a limit, the next turn waits for the next hour. A turn counts when it ends, so a long
        turn can pass the limit. 0 means no limit for the coordinator.
      </p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
