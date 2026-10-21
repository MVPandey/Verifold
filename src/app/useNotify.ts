import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Snapshot } from '../protocol/api.ts';
import {
  freshMemory,
  notesFor,
  notifyState,
  type Note,
  type NotifyMemory,
  type NotifyState,
  type Permission,
} from './notify.ts';

/** The person's choice, kept in this browser. Off until they turn notes on. */
const choiceKey = 'verifold-app-notify';

function readChoice(): boolean {
  try {
    return localStorage.getItem(choiceKey) === 'on';
  } catch {
    return false;
  }
}

function saveChoice(on: boolean): void {
  try {
    if (on) localStorage.setItem(choiceKey, 'on');
    else localStorage.removeItem(choiceKey);
  } catch {
    // A browser that keeps no storage forgets the choice, so notes stay off.
  }
}

function permission(): Permission {
  return typeof Notification === 'undefined'
    ? 'unsupported'
    : Notification.permission;
}

/** In the background: the page is hidden, or its window has no focus, as on the desk. */
function background(): boolean {
  return document.visibilityState === 'hidden' || !document.hasFocus();
}

/** Show one note. A click brings the tab forward on the note's page. */
function show(note: Note): void {
  try {
    const shown = new Notification(note.title, {
      body: note.body,
      tag: note.key,
      icon: '/symbol.webp',
    });
    shown.addEventListener('click', () => {
      window.focus();
      location.hash = note.route;
      shown.close();
    });
  } catch {
    // A browser that refuses a note here shows none.
  }
}

/**
 * Desktop notes for the app: the setting, a way to turn it on or off, and a
 * note for each new event of each snapshot (see notify.ts). Turning notes on
 * asks the browser for permission then, never on load.
 */
export function useNotify(snapshot: Snapshot | null): {
  readonly state: NotifyState;
  readonly toggle: () => void;
} {
  const [state, setState] = useState<NotifyState>(() =>
    notifyState(readChoice(), permission()),
  );
  const memory = useRef<NotifyMemory>(freshMemory);
  useEffect(() => {
    if (!snapshot) return;
    const next = notesFor(
      memory.current,
      snapshot.lab,
      snapshot.project,
      background(),
      state === 'on',
    );
    memory.current = next.memory;
    for (const note of next.notes) show(note);
  }, [snapshot, state]);
  const toggle = useCallback((): void => {
    if (state === 'on') {
      saveChoice(false);
      setState('off');
      return;
    }
    if (typeof Notification === 'undefined') {
      setState('unavailable');
      return;
    }
    void (
      Notification.permission === 'default'
        ? Notification.requestPermission()
        : Promise.resolve(Notification.permission)
    ).then((answer) => {
      saveChoice(answer === 'granted');
      setState(notifyState(answer === 'granted', answer));
    });
  }, [state]);
  return useMemo(() => ({ state, toggle }), [state, toggle]);
}
