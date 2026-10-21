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

export function Up(): ReactNode {
  return (
    <Icon size={15} width={2.6}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </Icon>
  );
}
