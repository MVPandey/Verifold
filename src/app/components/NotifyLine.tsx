import { useContext, type ReactNode } from 'react';
import { notifyLine } from '../notify.ts';
import { ToolsContext } from '../tools.ts';

/**
 * The notification setting under the lab: off by default, a plain button to
 * turn it on or off, and what the browser allows. Nothing shows when the
 * browser has no notifications, or when the page has no tools, as in a test.
 */
export function NotifyLine(): ReactNode {
  const tools = useContext(ToolsContext);
  const line = tools ? notifyLine(tools.notify.state) : null;
  if (!tools || !line) return null;
  return (
    <p className="notify">
      <span>{line.text}</span>
      {line.button && (
        <button
          type="button"
          className="link-button"
          onClick={tools.notify.toggle}
        >
          {line.button}
        </button>
      )}
    </p>
  );
}
