import { useEffect, useRef, useState, type RefObject } from 'react';

/** A long text clipped to two lines by CSS, and whether the person opened it. */
export interface Clip {
  /** Goes on the element that CSS clips. */
  readonly ref: RefObject<HTMLDivElement | null>;
  readonly open: boolean;
  /** The text does not fit, or the person opened it, so a toggle shows. */
  readonly toggles: boolean;
  readonly toggle: () => void;
}

/** A clip of `text`. It measures the rendered text, so a narrow screen clips more. */
export function useClip(text: string): Clip {
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (element && !open)
      setClipped(element.scrollHeight > element.clientHeight);
  }, [text, open]);
  return {
    ref,
    open,
    toggles: clipped || open,
    toggle: () => setOpen(!open),
  };
}
