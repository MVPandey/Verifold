import { createContext, useContext } from 'react';
import type { ReactElement } from 'react';

import type { AgentView, Picture as PictureChoice } from '../api/types.ts';
import { author } from '../model/agents.ts';
import { GONE_COLOR, pictureLook, roles, seatBeside, seatMarks } from '../model/identity.ts';

/** The agent whose profile shows, and the way to show another one or none. */
export interface ProfileDoor {
  readonly shown: string | null;
  readonly show: (agentId: string | null) => void;
}

/** The profile sheet's door. The app provides it, and a press on any name or picture goes through it. */
export const Profiles = createContext<ProfileDoor>({ shown: null, show: () => undefined });

const SHAPES: Readonly<Record<string, ReactElement>> = {
  square: <rect x="1.5" y="1.5" width="21" height="21" rx="4" />,
  circle: <circle cx="12" cy="12" r="10.8" />,
  hex: <polygon points="12,1 21.6,6.5 21.6,17.5 12,23 2.4,17.5 2.4,6.5" />,
  diamond: <polygon points="12,0.6 23.4,12 12,23.4 0.6,12" />,
  arch: <path d="M2 22.5V11.5a10 10 0 0 1 20 0v11z" />,
  triangle: <polygon points="12,1.6 23,22.2 1,22.2" />,
};

/** Where the symbol sits inside each shape. */
const FIT: Readonly<Record<string, string>> = {
  circle: 'scale(.92)',
  hex: 'scale(.9)',
  diamond: 'scale(.72)',
  arch: 'translate(0 1.6) scale(.9)',
  triangle: 'translate(0 4.2) scale(.62)',
};

const SYMBOLS: Readonly<Record<string, ReactElement>> = {
  wave: <path d="M5 12q3.5-6 7 0t7 0" />,
  dots: (
    <g stroke="none" fill="currentColor">
      <circle cx="8.6" cy="8.6" r="1.7" />
      <circle cx="15.4" cy="8.6" r="1.7" />
      <circle cx="8.6" cy="15.4" r="1.7" />
      <circle cx="15.4" cy="15.4" r="1.7" />
    </g>
  ),
  arrow: <path d="M8 16l8-8M9.5 8H16v6.5" />,
  fork: <path d="M12 18v-6M12 12L7.5 6.8M12 12l4.5-5.2" />,
  bars: <path d="M7.5 17v-5M12 17V7M16.5 17v-3" />,
  ring: <circle cx="12" cy="12" r="4.4" />,
  plus: <path d="M12 6.5v11M6.5 12h11" />,
  zigzag: <path d="M5.5 14.5l4.3-5.5 4.4 5.5 4.3-5.5" />,
  orbit: (
    <>
      <circle cx="12" cy="12" r="5" />
      <circle cx="16.6" cy="7.6" r="1.9" stroke="none" fill="currentColor" />
    </>
  ),
  slashes: <path d="M8.5 17.5l3-11M13 17.5l3-11" />,
};

/**
 * A picture that an agent chose: one shape, one color, and one symbol, drawn here. It has no face and no
 * character, and the same three choices draw the same picture on every screen. `hollow` draws the outline only.
 */
export function Picture(props: {
  readonly picture: PictureChoice;
  readonly size: number;
  readonly hollow?: boolean;
  readonly faded?: boolean;
}): ReactElement {
  const { shape, color, symbol } = props.picture;
  const { hollow, size } = props;
  return (
    <svg
      className={`i-pic${props.faded ? ' faded' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <g fill={hollow ? 'none' : color} stroke={hollow ? color : 'none'} strokeWidth="1.6">
        {SHAPES[shape]}
      </g>
      <g
        className="i-symbol"
        transform={FIT[shape]}
        color={hollow ? color : '#14121b'}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {SYMBOLS[symbol]}
      </g>
    </svg>
  );
}

/**
 * A member's picture. An agent that chose none has a dashed outline with the number of its ID. An on-call agent's
 * picture is an outline, and the picture of an agent that left is gray. With `dot`, a green dot says that the
 * agent is in a turn, and a yellow dot that it waits for the person.
 *
 * The picture is for the eye. The name beside it, or the button around it, says who it is. `ghost` is the small
 * faint picture of an author who posted before the latest one.
 */
export function Mark(props: {
  readonly view: AgentView;
  readonly size?: number | undefined;
  readonly dot?: boolean | undefined;
  readonly ghost?: boolean | undefined;
}): ReactElement {
  const { view } = props;
  const look = pictureLook(view);
  const size = props.size ?? (props.ghost ? 18 : 26);
  const seat = seatBeside(view);
  const name = seat ? `${view.agent.name}, ${seat}` : view.agent.name;
  // The small faint picture of an earlier author carries no dot.
  const dot = props.dot === false || props.ghost ? null : look.dot;
  return (
    <span className={`i-mark${props.ghost ? ' ghost' : ''}`} title={name} aria-hidden="true">
      {look.picture ? (
        <Picture
          picture={look.gone ? { ...look.picture, color: GONE_COLOR } : look.picture}
          size={size}
          hollow={look.hollow}
          faded={look.gone}
        />
      ) : (
        <svg
          className={`i-pic none${look.gone ? ' faded' : ''}`}
          width={size}
          height={size}
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <rect x="2" y="2" width="20" height="20" rx="4" />
          <text x="12" y="16" textAnchor="middle">
            {look.number}
          </text>
        </svg>
      )}
      {dot ? <i className={`i-dot ${dot}`} /> : null}
    </span>
  );
}

/**
 * The picture of a post's author. A member's picture opens its profile. The person shows as "You", and a blind
 * rerun as a dashed circle, because it has no name and no picture in a thread.
 */
export function Who(props: {
  readonly agents: readonly AgentView[];
  readonly id: string;
  readonly size?: number;
  readonly dot?: boolean;
  /** Whether no name stands beside the picture, so that the picture carries the name. */
  readonly alone?: boolean;
  readonly ghost?: boolean;
}): ReactElement {
  const { show } = useContext(Profiles);
  const who = author(props.agents, props.id);
  if (who.kind !== 'member') {
    const classes = `f-face ${who.kind}${props.ghost ? ' ghost' : ''}`;
    const text = who.kind === 'person' ? 'You' : '';
    return props.alone ? (
      <span className={classes} role="img" aria-label={who.name} title={who.name}>
        {text}
      </span>
    ) : (
      <span className={classes} aria-hidden="true">
        {text}
      </span>
    );
  }
  const { view } = who;
  return (
    <button
      type="button"
      className="i-open"
      // Beside a name, the name is the control that a keyboard reaches, and the picture is for the pointer.
      tabIndex={props.alone ? undefined : -1}
      aria-hidden={props.alone ? undefined : true}
      aria-label={props.alone ? `Profile of ${view.agent.name}` : undefined}
      onClick={(event) => {
        event.stopPropagation();
        show(view.agent.id);
      }}
    >
      <Mark view={view} size={props.size} dot={props.dot} ghost={props.ghost} />
    </button>
  );
}

/**
 * A member's name, and beside it the label of its seat, small and gray, when the two differ. A press on the name
 * opens the profile. `seat` is the label as it was when a post was written, in place of the label of now.
 */
export function Name(props: {
  readonly view: AgentView;
  readonly seat?: string | null | undefined;
}): ReactElement {
  const { show } = useContext(Profiles);
  const { view } = props;
  const seat = props.seat === undefined ? seatBeside(view) : props.seat;
  return (
    <>
      <button
        type="button"
        className={`i-name${view.left ? ' gone' : ''}`}
        onClick={(event) => {
          event.stopPropagation();
          show(view.agent.id);
        }}
      >
        {view.agent.name}
      </button>
      {seat ? <span className="i-prov">{seat}</span> : null}
    </>
  );
}

/** The marks of the seats that a member holds, and after them its roles: the given one, then its own. */
export function MarksAndRoles(props: { readonly view: AgentView }): ReactElement | null {
  const marks = seatMarks(props.view);
  const all = roles(props.view);
  if (marks.length + all.length === 0) return null;
  return (
    <p className="i-marks">
      {marks.map((mark) => (
        <span key={mark} className={`i-seat${mark === 'Coordinator' ? ' coord' : ''}`}>
          {mark}
        </span>
      ))}
      {all.map((role) => (
        <span key={role} className="f-role">
          {role}
        </span>
      ))}
    </p>
  );
}
