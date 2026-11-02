import { createContext, useContext } from 'react';
import type { Lab } from '../protocol/api.ts';

/** How the lab reads. Both views hold the same facts. Simple can leave out detail, and it adds none. */
export type ViewMode = 'simple' | 'technical';

const storageKey = 'verifold.view';

/** The browser's choice. Simple is the default, also when the browser refuses storage, which can throw on the first touch. */
export function readViewMode(
  storage: () => Pick<Storage, 'getItem'> = () => localStorage,
): ViewMode {
  try {
    return storage().getItem(storageKey) === 'technical'
      ? 'technical'
      : 'simple';
  } catch {
    return 'simple';
  }
}

/** Remember the choice in this browser. A browser that refuses storage keeps it for this tab only. */
export function saveViewMode(
  mode: ViewMode,
  storage: () => Pick<Storage, 'setItem'> = () => localStorage,
): void {
  try {
    storage().setItem(storageKey, mode);
  } catch {
    /* The choice holds until the tab closes. */
  }
}

/**
 * The one test for a lab with threads. A snapshot keeps a brief's record at
 * every size, while its list of threads can be empty. Null or absent: a lab
 * from before threads, which keeps its old screens.
 */
export function threadedLab(lab: Lab | null): boolean {
  return lab?.brief != null;
}

/** The new home shows from the plan on. Before it, the home shows the planner's questions. A small snapshot leaves the plan out and says so. */
export function threadHome(lab: Lab): boolean {
  return (
    threadedLab(lab) && (lab.plan !== null || lab.omitted.plan !== undefined)
  );
}

export interface View {
  readonly mode: ViewMode;
  /** The lab has threads. Old labs read as they did, with no switch. */
  readonly threaded: boolean;
  readonly setMode: (mode: ViewMode) => void;
}

/** The page shows IDs in Verifold's own text: an old lab as it did, and a lab with threads in Technical. */
export function showsIds(view: Pick<View, 'mode' | 'threaded'>): boolean {
  return !view.threaded || view.mode === 'technical';
}

/** A page outside the app, as in a test, reads as an old lab. */
export const ViewContext = createContext<View>({
  mode: 'simple',
  threaded: false,
  setMode: () => {},
});

export function useView(): View {
  return useContext(ViewContext);
}
