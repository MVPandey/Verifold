/**
 * Terminal frames in the desk. Moving an iframe in the page reloads it, and the
 * desk replaces its content on each refresh. So each frame lives in one layer
 * outside that content, and the page lays it over its slot after each render
 * and each change of layout.
 */

const frames = new Map<string, HTMLIFrameElement>();
let layer: HTMLElement | null = null;
let main: HTMLElement | null = null;

/**
 * Lay each frame over its slot. A slot that is not shown hides its frame. The
 * view and the panel scroll on their own, so a frame is clipped to the visible
 * part of the area that holds its slot.
 */
export function placeTerminals(): void {
  for (const [session, frame] of frames) {
    const slot = main?.querySelector<HTMLElement>(
      `.terminal-slot[data-session="${CSS.escape(session)}"]`,
    );
    const box = slot?.getBoundingClientRect();
    const area = slot
      ?.closest<HTMLElement>('#view, #panel-body')
      ?.getBoundingClientRect();
    const top = area ? Math.max(0, area.top - (box?.top ?? 0)) : 0;
    const bottom = area ? Math.max(0, (box?.bottom ?? 0) - area.bottom) : 0;
    if (!box || box.width === 0 || top + bottom >= box.height) {
      frame.hidden = true;
      continue;
    }
    frame.hidden = false;
    frame.style.top = `${box.top + window.scrollY}px`;
    frame.style.left = `${box.left + window.scrollX}px`;
    frame.style.width = `${box.width}px`;
    frame.style.height = `${box.height}px`;
    frame.style.clipPath =
      top || bottom ? `inset(${top}px 0 ${bottom}px 0)` : '';
  }
}

/** Keep one frame for each terminal slot of the page. A terminal without a slot loses its frame. */
export function mountTerminals(content: HTMLElement): void {
  main = content;
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'terminal-layer';
    document.body.append(layer);
    new ResizeObserver(() => placeTerminals()).observe(document.body);
    window.addEventListener('resize', () => placeTerminals());
    // A scroll of the view or the panel moves the slot. Scroll events do not bubble, so listen in the capture phase.
    document.addEventListener('scroll', () => placeTerminals(), {
      capture: true,
      passive: true,
    });
  }
  const used = new Set<string>();
  for (const slot of content.querySelectorAll<HTMLElement>(
    '.terminal-slot[data-session]',
  )) {
    const session = slot.dataset.session ?? '';
    used.add(session);
    if (frames.has(session)) continue;
    const frame = document.createElement('iframe');
    frame.className = 'terminal-frame';
    frame.title = slot.dataset.label ?? 'Harness terminal';
    frame.src = `/terminal?session=${encodeURIComponent(session)}`;
    layer.append(frame);
    frames.set(session, frame);
  }
  for (const [session, frame] of frames)
    if (!used.has(session)) {
      frame.remove();
      frames.delete(session);
    }
  placeTerminals();
}
