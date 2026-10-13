/**
 * The arrows of the task map, drawn like a flowchart: level and upright
 * segments with rounded corners. A column holds the boxes of one depth, and an
 * arrow runs from the box that a task waits for to the task.
 *
 * - An arrow turns upright only in the gaps between columns. Each source gets
 *   its own slot in a gap, so arrows from one box share a trunk and arrows from
 *   different boxes run side by side.
 * - An arrow that skips a column passes under that column's boxes, in a lane of
 *   its own, so it never passes behind a box.
 * - Arrows that leave or reach one box spread along its edge.
 */

/** A rectangle in map coordinates. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** One column: its horizontal extent and its boxes. */
export interface Column {
  readonly left: number;
  readonly right: number;
  readonly boxes: readonly Box[];
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** One arrow: from the box `from` to the box `to`, by node ID. */
export interface Edge {
  readonly from: string;
  readonly to: string;
}

/** Where a node is: its box and its column. */
export interface Node {
  readonly box: Box;
  readonly column: number;
}

/** The space between parallel arrows. */
const pitch = 8;
/** How far a lane runs under the lowest box of a column. */
const under = 14;

/**
 * Heights along a box edge for `count` arrows, so they do not meet in one
 * point. They center on the usual height and stay inside the box.
 */
export function spread(box: Box, count: number): number[] {
  const usual = box.top + Math.min(28, (box.bottom - box.top) / 2);
  const low = box.top + 8;
  const high = Math.max(low, box.bottom - 8);
  return Array.from({ length: count }, (_, index) =>
    Math.min(
      high,
      Math.max(low, usual + (index - (count - 1) / 2) * (pitch + 2)),
    ),
  );
}

/**
 * The arrows that a reader needs: an arrow from A to C is left out when another
 * path already leads from A to C, for example through B. The task still waits
 * for A; the map shows it through B.
 */
export function essential(edges: readonly Edge[]): Edge[] {
  const next = new Map<string, string[]>();
  for (const edge of edges)
    next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
  const reaches = (from: string, to: string, skip: Edge): boolean => {
    const seen = new Set<string>([from]);
    const queue = [from];
    while (queue.length) {
      const at = queue.shift() ?? '';
      for (const step of next.get(at) ?? []) {
        if (at === skip.from && step === skip.to) continue;
        if (step === to) return true;
        if (!seen.has(step)) {
          seen.add(step);
          queue.push(step);
        }
      }
    }
    return false;
  };
  return edges.filter((edge) => !reaches(edge.from, edge.to, edge));
}

/** An SVG path through the points, with rounded corners. */
export function path(points: readonly Point[], radius = 6): string {
  const [first, ...rest] = points;
  if (!first) return '';
  let d = `M${first.x} ${first.y}`;
  for (let index = 0; index < rest.length; index++) {
    const corner = rest[index];
    const before = index === 0 ? first : rest[index - 1];
    const after = rest[index + 1];
    if (!corner || !before) continue;
    if (!after) {
      d += `L${corner.x} ${corner.y}`;
      continue;
    }
    const inLength = Math.hypot(corner.x - before.x, corner.y - before.y);
    const outLength = Math.hypot(after.x - corner.x, after.y - corner.y);
    const r = Math.min(radius, inLength / 2, outLength / 2);
    if (r < 0.5) {
      d += `L${corner.x} ${corner.y}`;
      continue;
    }
    const enter = {
      x: corner.x - ((corner.x - before.x) / inLength) * r,
      y: corner.y - ((corner.y - before.y) / inLength) * r,
    };
    const leave = {
      x: corner.x + ((after.x - corner.x) / outLength) * r,
      y: corner.y + ((after.y - corner.y) / outLength) * r,
    };
    d += `L${round(enter.x)} ${round(enter.y)}Q${corner.x} ${corner.y} ${round(leave.x)} ${round(leave.y)}`;
  }
  return d;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * The points of every arrow of a map, by edge index. The returned `depth` is
 * the lowest lane, so the map can make room under its boxes.
 */
export function plan(
  columns: readonly Column[],
  nodes: ReadonlyMap<string, Node>,
  edges: readonly Edge[],
): { readonly routes: Point[][]; readonly depth: number } {
  const middle = (id: string): number => {
    const box = nodes.get(id)?.box;
    return box ? (box.top + box.bottom) / 2 : 0;
  };
  // Arrows leave and arrive in the order of their other ends, so they do not cross at the edges.
  const leave = new Map<number, number>();
  const arrive = new Map<number, number>();
  for (const [side, ends, other] of [
    ['from', leave, 'to'],
    ['to', arrive, 'from'],
  ] as const) {
    const groups = new Map<string, number[]>();
    edges.forEach((edge, index) =>
      groups.set(edge[side], [...(groups.get(edge[side]) ?? []), index]),
    );
    for (const [id, group] of groups) {
      const box = nodes.get(id)?.box;
      if (!box) continue;
      group.sort(
        (a, b) =>
          middle(edges[a]?.[other] ?? '') - middle(edges[b]?.[other] ?? ''),
      );
      spread(box, group.length).forEach((height, at) => {
        const edge = group[at];
        if (edge !== undefined) ends.set(edge, height);
      });
    }
  }
  // A box with one arrow out lets it leave at the height where it arrives, so a simple chain runs level.
  edges.forEach((edge, index) => {
    const source = nodes.get(edge.from);
    const target = nodes.get(edge.to);
    const height = arrive.get(index);
    if (
      source &&
      target &&
      height !== undefined &&
      target.column === source.column + 1 &&
      edges.filter((other) => other.from === edge.from).length === 1 &&
      height >= source.box.top + 8 &&
      height <= source.box.bottom - 8
    )
      leave.set(index, height);
  });
  // And a box with one arrow in takes it at the height where it leaves.
  edges.forEach((edge, index) => {
    const source = nodes.get(edge.from);
    const target = nodes.get(edge.to);
    const height = leave.get(index);
    if (
      source &&
      target &&
      height !== undefined &&
      target.column === source.column + 1 &&
      edges.filter((other) => other.to === edge.to).length === 1 &&
      height >= target.box.top + 8 &&
      height <= target.box.bottom - 8
    )
      arrive.set(index, height);
  });
  // Lanes under the columns that arrows skip: one lane per source in each column.
  const lanes = new Map<string, number>();
  let depth = 0;
  const laneOf = (column: number, source: string): number => {
    const key = `${column}:${source}`;
    const known = lanes.get(key);
    if (known !== undefined) return known;
    const box = columns[column];
    const floor = Math.max(
      0,
      ...(box?.boxes.map((entry) => entry.bottom) ?? [0]),
    );
    const taken = [...lanes.keys()].filter((entry) =>
      entry.startsWith(`${column}:`),
    ).length;
    const lane = floor + under + taken * pitch;
    lanes.set(key, lane);
    depth = Math.max(depth, lane);
    return lane;
  };
  // Slots in the gaps between columns: one per source, side by side.
  const slots = new Map<string, number>();
  const slotOf = (gap: number, source: string): number => {
    const key = `${gap}:${source}`;
    const known = slots.get(key);
    if (known !== undefined) return known;
    const users = [
      ...new Set(
        edges
          .filter((edge) => {
            const from = nodes.get(edge.from)?.column ?? -1;
            const to = nodes.get(edge.to)?.column ?? -1;
            return from <= gap && to > gap;
          })
          .map((edge) => edge.from),
      ),
    ].sort((a, b) => middle(a) - middle(b));
    const left = columns[gap]?.right ?? 0;
    const right = columns[gap + 1]?.left ?? left;
    const at = users.indexOf(source);
    const x = (left + right) / 2 + (at - (users.length - 1) / 2) * pitch;
    slots.set(key, x);
    return x;
  };
  const routes = edges.map((edge, index): Point[] => {
    const source = nodes.get(edge.from);
    const target = nodes.get(edge.to);
    if (!source || !target) return [];
    const points: Point[] = [
      { x: source.box.right, y: leave.get(index) ?? source.box.top },
    ];
    let y = points[0]?.y ?? 0;
    for (let column = source.column + 1; column < target.column; column++) {
      const x = slotOf(column - 1, edge.from);
      const lane = laneOf(column, edge.from);
      points.push({ x, y }, { x, y: lane });
      y = lane;
    }
    const end = arrive.get(index) ?? target.box.top;
    const x = slotOf(target.column - 1, edge.from);
    points.push({ x, y }, { x, y: end }, { x: target.box.left - 2, y: end });
    // Drop corners that do not turn, so a level arrow is one segment.
    return points.filter((point, at, all) => {
      const before = all[at - 1];
      const after = all[at + 1];
      return !(
        before &&
        after &&
        ((before.x === point.x && point.x === after.x) ||
          (before.y === point.y && point.y === after.y))
      );
    });
  });
  return { routes, depth };
}

/** Draw the arrows of one map element. It needs `.map-col` columns, `[data-node]` boxes, and `[data-from]` on each task. */
export function drawMap(map: HTMLElement): void {
  const svg = map.querySelector('svg.map-links');
  const layer = svg?.querySelector('g');
  if (!svg || !layer) return;
  const origin = map.getBoundingClientRect();
  const place = (element: Element): Box => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left - origin.left + map.scrollLeft,
      top: rect.top - origin.top + map.scrollTop,
      right: rect.right - origin.left + map.scrollLeft,
      bottom: rect.bottom - origin.top + map.scrollTop,
    };
  };
  const columns: Column[] = [];
  const nodes = new Map<string, Node>();
  const finished = new Set<string>(['objective']);
  map.querySelectorAll('.map-col').forEach((element, index) => {
    const cells = Array.from(
      element.querySelectorAll<HTMLElement>('[data-node]'),
    );
    const boxes = cells.map(place);
    const area = place(element);
    columns.push({ left: area.left, right: area.right, boxes });
    cells.forEach((cell, at) => {
      const box = boxes[at];
      const id = cell.dataset.node;
      if (!box || !id) return;
      nodes.set(id, { box, column: index });
      if (cell.dataset.state === 'done') finished.add(id);
    });
  });
  const all: Edge[] = [];
  for (const target of map.querySelectorAll<HTMLElement>('[data-from]'))
    for (const from of (target.dataset.from ?? '').split(' '))
      if (nodes.has(from) && target.dataset.node)
        all.push({ from, to: target.dataset.node });
  const edges = essential(all);
  const { routes, depth } = plan(columns, nodes, edges);
  // An arrow keeps its element from one drawing to the next, so an arrow that lights up stays lit.
  const drawn = new Map(
    Array.from(
      layer.querySelectorAll<SVGPathElement>('path[data-source]'),
      (line) => [`${line.dataset.source} ${line.dataset.target}`, line],
    ),
  );
  const paths = routes.flatMap((points, index) => {
    const edge = edges[index];
    if (!edge || points.length < 2) return [];
    const line =
      drawn.get(`${edge.from} ${edge.to}`) ??
      document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line.dataset.source = edge.from;
    line.dataset.target = edge.to;
    line.setAttribute('d', path(points));
    line.setAttribute('marker-end', 'url(#map-arrow)');
    // A finished source or the objective gives a solid line. A dashed line still waits.
    line.classList.toggle('done', finished.has(edge.from));
    return [line];
  });
  // Lanes under the lowest box need room in the map.
  const lowest = Math.max(
    0,
    ...columns.flatMap((column) => column.boxes.map((box) => box.bottom)),
  );
  map.style.paddingBottom = `${Math.max(12, depth - lowest + 10)}px`;
  svg.setAttribute('width', String(map.scrollWidth));
  svg.setAttribute('height', String(map.scrollHeight));
  const kept = new Set(paths);
  for (const line of drawn.values()) if (!kept.has(line)) line.remove();
  layer.append(...paths.filter((line) => !line.isConnected));
}
