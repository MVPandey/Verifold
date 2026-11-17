import assert from 'node:assert/strict';
import { test } from 'node:test';

import { judge } from './audit-app.mjs';

const EXEMPT = { 'GHSA-cccc-ffff-gggg': 'A reason.' };

function advisory(id, severity = 'high') {
  return { title: `Advisory ${id}`, url: `https://github.com/advisories/${id}`, severity };
}

function reportOf(packages) {
  return { auditReportVersion: 2, vulnerabilities: packages };
}

test('a report with no vulnerabilities passes', () => {
  assert.equal(judge(reportOf({}), EXEMPT).ok, true);
});

test('a high advisory that is not exempt fails, and the failure names it', () => {
  const verdict = judge(
    reportOf({ glob: { severity: 'high', via: [advisory('GHSA-2222-3333-4444')] } }),
    EXEMPT,
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures[0], /glob: Advisory GHSA-2222-3333-4444/);
});

test('a critical advisory that is not exempt fails', () => {
  const report = reportOf({
    glob: { severity: 'critical', via: [advisory('GHSA-2222-3333-4444', 'critical')] },
  });
  assert.equal(judge(report, EXEMPT).ok, false);
});

test('an exempt advisory passes, with the packages that depend on its package', () => {
  const verdict = judge(
    reportOf({
      match: { severity: 'high', via: [advisory('GHSA-cccc-ffff-gggg')] },
      walker: { severity: 'high', via: ['match'] },
      bundler: { severity: 'high', via: ['match', 'walker'] },
    }),
    EXEMPT,
  );
  assert.deepEqual(verdict, {
    ok: true,
    failures: [],
    exempted: ['GHSA-cccc-ffff-gggg'],
    unused: [],
  });
});

test('an exempt advisory does not cover another high advisory in the same package', () => {
  const verdict = judge(
    reportOf({
      match: {
        severity: 'high',
        via: [advisory('GHSA-cccc-ffff-gggg'), advisory('GHSA-2222-3333-4444')],
      },
    }),
    EXEMPT,
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.failures.length, 1);
});

test('a moderate advisory passes, and an exemption that the report names no more is reported', () => {
  const verdict = judge(
    reportOf({
      glob: { severity: 'moderate', via: [advisory('GHSA-2222-3333-4444', 'moderate')] },
    }),
    EXEMPT,
  );
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.unused, ['GHSA-cccc-ffff-gggg']);
});

test('an exemption holds for the high advisory only, not for a moderate one with the same ID', () => {
  const verdict = judge(
    reportOf({
      match: { severity: 'moderate', via: [advisory('GHSA-cccc-ffff-gggg', 'moderate')] },
    }),
    EXEMPT,
  );
  assert.deepEqual([verdict.ok, verdict.exempted], [true, []]);
});

test('a high advisory without an advisory ID can not be exempt', () => {
  const report = reportOf({
    match: {
      severity: 'high',
      via: [{ title: 'No link', url: 'https://example.invalid/x', severity: 'high' }],
    },
  });
  assert.equal(judge(report, { undefined: 'A reason.' }).ok, false);
});

test('an ID that only appears inside a longer link is not exempt', () => {
  const report = reportOf({
    match: {
      severity: 'high',
      via: [
        {
          title: 'Another advisory',
          url: 'https://github.com/advisories/GHSA-cccc-ffff-gggg/../GHSA-2222-3333-4444',
          severity: 'high',
        },
      ],
    },
  });
  assert.equal(judge(report, EXEMPT).ok, false);
});

test('a package that npm marks as high with no advisory behind it fails', () => {
  const verdict = judge(reportOf({ walker: { severity: 'high', via: ['match'] } }), EXEMPT);
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures[0], /names no advisory/);
});

test('a report that npm could not make fails', () => {
  for (const report of [
    null,
    'text',
    [],
    {},
    { error: { code: 'ENOLOCK' } },
    { vulnerabilities: [] },
  ]) {
    assert.equal(judge(report, EXEMPT).ok, false, JSON.stringify(report));
  }
});

test('a property of every object, such as constructor, is no exemption', () => {
  const report = reportOf({
    match: {
      severity: 'high',
      via: [{ title: 'x', url: 'https://github.com/advisories/constructor', severity: 'high' }],
    },
  });
  assert.equal(judge(report, {}).ok, false);
});
