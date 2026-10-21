import { createContext } from 'react';
import type { ActOutcome } from './api.ts';
import type { NotifyState } from './notify.ts';

/**
 * The app's tools that every page can reach: the search, dismissing the
 * time away, and the notification setting. The app provides them. A page
 * rendered without them, as in a test, shows none of their controls.
 */
export interface AppTools {
  readonly openSearch: () => void;
  readonly dismissAway: (key: string) => Promise<ActOutcome>;
  readonly notify: {
    readonly state: NotifyState;
    readonly toggle: () => void;
  };
}

export const ToolsContext = createContext<AppTools | null>(null);
