/**
 * Motion that answers a change on the desk: a dot that carries the work of a
 * task that just ended along its arrows, check results that land, and cards
 * that slide to a new place. A running task pulses in CSS. With reduced motion
 * nothing moves.
 */

function still(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The keys whose value changed since the last render. A new key has no change to show. */
export function changes(
  before: ReadonlyMap<string, string>,
  now: ReadonlyMap<string, string>,
): string[] {
  return [...now]
    .filter(([key, value]) => before.has(key) && before.get(key) !== value)
    .map(([key]) => key);
}

/** The state of each task box, and the result of each check, at the last render. */
let boxes = new Map<string, string>();
let stamps = new Map<string, string>();

function boxStates(root: HTMLElement): Map<string, string> {
  return new Map(
    Array.from(
      root.querySelectorAll<HTMLElement>('[data-map] .map-box[data-node]'),
      (box) => [box.dataset.node ?? '', box.dataset.state ?? ''],
    ),
  );
}

/** Check results by place: in the Answer view, the list holds the checks in their order. */
function stampElements(root: HTMLElement): Map<string, HTMLElement> {
  return new Map(
    Array.from(
      root.querySelectorAll<HTMLElement>('.check-row[data-result]'),
      (row, index) => [`${row.className} ${index}`, row],
    ),
  );
}

/** Where each card is before a render, so a card that moves can slide. */
export function cardPlaces(root: HTMLElement): Map<HTMLElement, number> {
  return new Map(
    Array.from(
      root.querySelectorAll<HTMLElement>('#view section.card'),
      (card) => [card, card.getBoundingClientRect().top],
    ),
  );
}

/** The color of a harness, as the style sheet gives it to the element. */
function harnessColor(element: Element): string {
  return (
    getComputedStyle(element).getPropertyValue('--harness').trim() ||
    'currentColor'
  );
}

function glow(box: HTMLElement, color: string): void {
  box.animate(
    [
      { boxShadow: `0 0 0 6px color-mix(in srgb, ${color} 40%, transparent)` },
      { boxShadow: '0 0 0 0 transparent' },
    ],
    { duration: 900, easing: 'ease-out' },
  );
}

const ease = (x: number): number =>
  x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;

/**
 * A task ended: a dot runs along each arrow from its box to the tasks that wait
 * for it, with what it hands over. With reduced motion the arrow lights up.
 */
function handoff(map: HTMLElement, id: string): void {
  const box = map.querySelector<HTMLElement>(
    `.map-box[data-node="${CSS.escape(id)}"]`,
  );
  const links = map.querySelector('svg.map-links');
  if (!box || !links) return;
  const color = harnessColor(box);
  for (const line of links.querySelectorAll<SVGPathElement>(
    `path[data-source="${CSS.escape(id)}"]`,
  )) {
    const target = map.querySelector<HTMLElement>(
      `.map-box[data-node="${CSS.escape(line.dataset.target ?? '')}"]`,
    );
    if (still()) {
      line.animate([{ stroke: color, strokeWidth: '3' }, {}], {
        duration: 1600,
        easing: 'ease-in',
      });
      continue;
    }
    // The dot runs above the boxes, in the coordinates of the arrows. The morph keeps it.
    const dot = document.createElement('span');
    dot.className = 'handoff';
    dot.dataset.host = box.dataset.host ?? '';
    dot.setAttribute('aria-hidden', 'true');
    dot.append(document.createElement('i'));
    if (box.dataset.gives) {
      const label = document.createElement('b');
      label.textContent = box.dataset.gives;
      dot.append(label);
    }
    map.append(dot);
    const length = line.getTotalLength();
    const start = performance.now();
    const step = (now: number): void => {
      const part = Math.min(1, (now - start) / 1300);
      // A render that removed the arrow ends the dot.
      if (!line.isConnected) {
        dot.remove();
        return;
      }
      const point = line.getPointAtLength(length * ease(part));
      dot.style.transform = `translate(${point.x - 6}px, ${point.y - 6}px)`;
      if (part < 1) {
        requestAnimationFrame(step);
        return;
      }
      dot.remove();
      if (target?.isConnected) glow(target, color);
    };
    requestAnimationFrame(step);
  }
}

/** A check result arrives like a stamp. */
function land(row: HTMLElement): void {
  row.querySelector('.check-result')?.animate(
    [
      { transform: 'scale(1.5) rotate(-8deg)', opacity: 0 },
      { opacity: 1, offset: 0.6 },
      { transform: 'none', opacity: 1 },
    ],
    { duration: 550, easing: 'cubic-bezier(0.2, 1.5, 0.45, 1)' },
  );
}

/** A card that moved slides from its old place. A new card fades in. */
function slide(
  root: HTMLElement,
  places: ReadonlyMap<HTMLElement, number>,
): void {
  for (const card of root.querySelectorAll<HTMLElement>('#view section.card')) {
    const top = places.get(card);
    if (top === undefined) {
      card.animate(
        [
          { opacity: 0, transform: 'translateY(6px)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 220, easing: 'ease-out' },
      );
      continue;
    }
    const shift = top - card.getBoundingClientRect().top;
    if (Math.abs(shift) >= 1)
      card.animate(
        [{ transform: `translateY(${shift}px)` }, { transform: 'none' }],
        { duration: 260, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
      );
  }
}

/**
 * After a render: show what changed since the last one. `same` is false when the
 * person opened another view or panel item, so a new view starts without motion.
 * A hidden page records the change without motion.
 */
export function showChanges(
  root: HTMLElement,
  places: ReadonlyMap<HTMLElement, number>,
  same: boolean,
): void {
  const nowBoxes = boxStates(root);
  const rows = stampElements(root);
  const nowStamps = new Map(
    [...rows].map(([key, row]) => [key, row.dataset.result ?? '']),
  );
  if (same && !document.hidden && !still()) slide(root, places);
  if (same && !document.hidden) {
    const map = root.querySelector<HTMLElement>('[data-map]');
    for (const id of changes(boxes, nowBoxes))
      if (map && nowBoxes.get(id) === 'done') handoff(map, id);
    if (!still())
      for (const key of changes(stamps, nowStamps)) {
        const row = rows.get(key);
        if (row && nowStamps.get(key) !== 'none') land(row);
      }
  }
  boxes = nowBoxes;
  stamps = nowStamps;
}

let shownIcon = '';

/**
 * The tab icon: a ring with the part of the planned tasks that is done. Its
 * color turns amber when Needs you has items. Before the plan is approved, and
 * with nothing that waits, the tab shows the Verifold symbol.
 */
export function showTabIcon(
  work: { readonly done: number; readonly total: number } | null,
  needs: number,
): void {
  const key = `${work?.done ?? 0}/${work?.total ?? 0}/${needs > 0}`;
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link || key === shownIcon) return;
  shownIcon = key;
  const set = (href: string): void => {
    if (link.href.startsWith('blob:')) URL.revokeObjectURL(link.href);
    link.href = href;
  };
  if (!work?.total && !needs) {
    set('/symbol.webp');
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const pen = canvas.getContext('2d');
  if (!pen) return;
  // Tab strips can be light or dark. These tones show on both.
  const color = needs ? '#f2a516' : '#8b5cf6';
  pen.lineWidth = 9;
  pen.lineCap = 'round';
  pen.strokeStyle = 'rgba(128, 128, 128, 0.45)';
  pen.beginPath();
  pen.arc(32, 32, 24, 0, Math.PI * 2);
  pen.stroke();
  const part = work?.total ? work.done / work.total : 0;
  if (part > 0) {
    pen.strokeStyle = color;
    pen.beginPath();
    pen.arc(32, 32, 24, -Math.PI / 2, -Math.PI / 2 + part * Math.PI * 2);
    pen.stroke();
  }
  pen.fillStyle = color;
  pen.beginPath();
  pen.arc(32, 32, 10, 0, Math.PI * 2);
  pen.fill();
  canvas.toBlob((blob) => {
    // A newer state may have drawn its icon first.
    if (blob && shownIcon === key) set(URL.createObjectURL(blob));
  });
}
