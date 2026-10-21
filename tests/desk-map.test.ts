import test from 'node:test';
import assert from 'node:assert/strict';
import {
  essential,
  path,
  plan,
  spread,
  type Box,
  type Column,
  type Edge,
  type Node,
  type Point,
} from '../src/desk/desk-map.ts';

/** The pilot's map: five tasks in four columns after the objective. */
const box = (left: number, top: number, bottom: number): Box => ({
  left,
  top,
  right: left + 236,
  bottom,
});
const placed: Record<string, [number, Box]> = {
  objective: [0, box(0, 4, 110)],
  'task-1': [1, box(292, 4, 150)],
  'task-2': [1, box(292, 164, 310)],
  'task-3': [2, box(584, 4, 150)],
  'task-4': [3, box(876, 4, 150)],
  'task-5': [4, box(1168, 4, 150)],
};
const nodes = new Map<string, Node>(
  Object.entries(placed).map(([id, [column, at]]) => [id, { column, box: at }]),
);
const columns: Column[] = [0, 1, 2, 3, 4].map((index) => ({
  left: index * 292,
  right: index * 292 + 236,
  boxes: [...nodes.values()]
    .filter((node) => node.column === index)
    .map((node) => node.box),
}));
const edges: Edge[] = [
  { from: 'objective', to: 'task-1' },
  { from: 'objective', to: 'task-2' },
  { from: 'task-1', to: 'task-3' },
  { from: 'task-3', to: 'task-4' },
  { from: 'task-2', to: 'task-4' },
  { from: 'task-1', to: 'task-5' },
  { from: 'task-4', to: 'task-5' },
];

/** Points every 2 px along a polyline. */
function along(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1];
    const b = points[index];
    if (!a || !b) continue;
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
    for (let step = 0; step <= steps; step++)
      out.push({
        x: a.x + ((b.x - a.x) * step) / steps,
        y: a.y + ((b.y - a.y) * step) / steps,
      });
  }
  return out;
}

const inside = (point: Point, area: Box): boolean =>
  point.x > area.left &&
  point.x < area.right &&
  point.y > area.top &&
  point.y < area.bottom;

await test('arrows run level and upright, and pass no box but their own two', () => {
  const { routes, depth } = plan(columns, nodes, edges);
  assert.equal(routes.length, edges.length);
  routes.forEach((route, index) => {
    const edge = edges[index];
    assert.ok(edge && route.length >= 2);
    // Each segment is level or upright.
    for (let at = 1; at < route.length; at++)
      assert.ok(
        route[at - 1]?.x === route[at]?.x || route[at - 1]?.y === route[at]?.y,
        `${edge.from} > ${edge.to} turns at an angle`,
      );
    // The arrow starts at its source's right side and ends at its target's left side.
    assert.equal(route[0]?.x, nodes.get(edge.from)?.box.right);
    assert.equal(route.at(-1)?.x, (nodes.get(edge.to)?.box.left ?? 0) - 2);
    for (const [id, node] of nodes)
      if (id !== edge.from && id !== edge.to)
        assert.ok(
          along(route).every((point) => !inside(point, node.box)),
          `${edge.from} > ${edge.to} passes ${id}`,
        );
  });
  // task-2 > task-4 skips column 2, so it runs under task-3. task-1 > task-5 skips two columns.
  const skip = along(routes[4] ?? []);
  assert.ok(
    skip.some((point) => point.y >= 150 + 14 && point.x > 584 && point.x < 820),
  );
  const far = along(routes[5] ?? []);
  for (const [left, right] of [
    [584, 820],
    [876, 1112],
  ] as const)
    assert.ok(
      far.some(
        (point) => point.y >= 150 + 14 && point.x > left && point.x < right,
      ),
    );
  // The lowest lane tells the map how much room it needs under the boxes.
  assert.ok(depth >= 150 + 14);
});

await test('arrows from one box share a trunk, and arrows from different boxes get their own slots', () => {
  // One box feeds two boxes lower in the next column: both arrows turn at the same x.
  const fan = new Map<string, Node>([
    ['source', { column: 0, box: box(0, 4, 150) }],
    ['upper', { column: 1, box: box(292, 164, 310) }],
    ['lower', { column: 1, box: box(292, 324, 470) }],
  ]);
  const fanColumns: Column[] = [0, 1].map((index) => ({
    left: index * 292,
    right: index * 292 + 236,
    boxes: [...fan.values()]
      .filter((node) => node.column === index)
      .map((node) => node.box),
  }));
  const fanned = plan(fanColumns, fan, [
    { from: 'source', to: 'upper' },
    { from: 'source', to: 'lower' },
  ]).routes;
  assert.equal(fanned[0]?.[1]?.x, fanned[1]?.[1]?.x);
  // In the gap before task-4, the arrows from task-3 and task-2 run side by side.
  const { routes } = plan(columns, nodes, edges);
  const gap = (route: Point[] | undefined): number | undefined =>
    route?.find((point) => point.x > 820 && point.x < 876)?.x;
  assert.ok(gap(routes[3]) !== undefined && gap(routes[4]) !== undefined);
  assert.ok(Math.abs((gap(routes[3]) ?? 0) - (gap(routes[4]) ?? 0)) >= 8);
});

await test('a path rounds its corners, and arrows at one box spread out', () => {
  assert.equal(
    path([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 30 },
    ]),
    'M0 0L14 0Q20 0 20 6L20 30',
  );
  assert.equal(
    path([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]),
    'M0 0L10 0',
  );
  const area: Box = { left: 0, top: 100, right: 200, bottom: 240 };
  assert.deepEqual(spread(area, 1), [128]);
  assert.deepEqual(spread(area, 2), [123, 133]);
  assert.deepEqual(spread(area, 3), [118, 128, 138]);
  const short: Box = { left: 0, top: 0, right: 100, bottom: 30 };
  assert.ok(spread(short, 5).every((height) => height >= 8 && height <= 22));
});

await test('the map leaves out an arrow that another path already shows', () => {
  // The pilot: task-4 waits for tasks 1 to 3, and task-5 waits for tasks 1 to 4.
  const waits: Edge[] = [
    { from: 'objective', to: 'task-1' },
    { from: 'objective', to: 'task-2' },
    { from: 'task-1', to: 'task-3' },
    ...['task-1', 'task-2', 'task-3'].map((from) => ({ from, to: 'task-4' })),
    ...['task-1', 'task-2', 'task-3', 'task-4'].map((from) => ({
      from,
      to: 'task-5',
    })),
  ];
  assert.deepEqual(
    essential(waits).map((edge) => `${edge.from} > ${edge.to}`),
    [
      'objective > task-1',
      'objective > task-2',
      'task-1 > task-3',
      'task-2 > task-4',
      'task-3 > task-4',
      'task-4 > task-5',
    ],
  );
  // Without another path, every arrow stays.
  assert.equal(essential(edges.slice(0, 3)).length, 3);
});
