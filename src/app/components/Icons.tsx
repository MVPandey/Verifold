import type { ReactNode } from 'react';

/** Stroke icons from the v9 canvas. They take the text color. */
function Icon({
  size,
  width,
  children,
}: {
  readonly size: number;
  readonly width: number;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function Logo(): ReactNode {
  return (
    <svg
      className="logo"
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.6}
      strokeLinecap="round"
      role="img"
      aria-label="Verifold"
    >
      <path d="M3 5l9 14 9-14" />
      <path d="M8 5h8" />
    </svg>
  );
}

export function Check({ size = 15 }: { readonly size?: number }): ReactNode {
  return (
    <Icon size={size} width={2.8}>
      <path d="M5 12l5 5 9-10" />
    </Icon>
  );
}

export function Warning(): ReactNode {
  return (
    <Icon size={15} width={2.6}>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17v.5" />
    </Icon>
  );
}

export function Cross({
  size = 15,
  width = 2.6,
}: { readonly size?: number; readonly width?: number } = {}): ReactNode {
  return (
    <Icon size={size} width={width}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Icon>
  );
}

export function Ring(): ReactNode {
  return (
    <Icon size={14} width={2.6}>
      <circle cx="12" cy="12" r="8" />
    </Icon>
  );
}

const chevrons = {
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
  down: 'M6 9l6 6 6-6',
} as const;

/** An arrowhead: the back link's, or a fold's, closed (right) or open (down). */
export function Chevron({
  to,
  size = 16,
}: {
  readonly to: keyof typeof chevrons;
  readonly size?: number;
}): ReactNode {
  return (
    <Icon size={size} width={size < 16 ? 2.4 : 2.2}>
      <path d={chevrons[to]} />
    </Icon>
  );
}

export function Up(): ReactNode {
  return (
    <Icon size={15} width={2.6}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </Icon>
  );
}

/** A direction that opened while the person was away. */
export function Plus(): ReactNode {
  return (
    <Icon size={15} width={2.6}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

/** The search button's magnifier, from the v9 header. */
export function Magnifier(): ReactNode {
  return (
    <Icon size={16} width={2}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
    </Icon>
  );
}

/** The "More actions" dots, filled, from the direction artboard. */
export function Dots(): ReactNode {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </svg>
  );
}
