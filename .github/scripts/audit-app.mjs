// Reads `npm audit` for the app's locked packages. It exits with 1 when an advisory of high or critical severity is
// not exempt, and when it can't read the report. Run it from the repository's root. With a file as its argument it
// reads that report instead of asking npm.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// An advisory is exempt only while no fixed version of its package exists and the package does not ship to the
// people who use Verifold. Each entry says why. Remove an entry when a fixed version is out.
export const EXEMPT = {
  'GHSA-fc5q-39xc-vjpf':
    'picomatch has no fixed version (2026-11-17). Only Vite uses it, when the app is built, on patterns from this repository.',
};

const SEVERE = new Set(['high', 'critical']);
const ADVISORY_ID = /GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;

/**
 * Decide whether a report of `npm audit --json` passes.
 *
 * `failures` holds one line for each reason that it does not. `exempted` holds the exempt advisories that the report
 * names, and `unused` the exempt ones that it names no more.
 */
export function judge(report, exempt = EXEMPT) {
  const listed = report && typeof report === 'object' ? report.vulnerabilities : null;
  if (!listed || typeof listed !== 'object' || Array.isArray(listed)) {
    return {
      ok: false,
      failures: ['The report holds no list of vulnerabilities, so nothing was checked.'],
      exempted: [],
      unused: [],
    };
  }
  // npm lists each package once. An advisory is an object in `via`; a string there names another listed package.
  const advisories = new Map();
  let severePackages = 0;
  for (const [name, entry] of Object.entries(listed)) {
    if (SEVERE.has(entry?.severity)) severePackages += 1;
    for (const via of Array.isArray(entry?.via) ? entry.via : []) {
      if (via && typeof via === 'object') {
        const id = ADVISORY_ID.exec(String(via.url ?? ''))?.[0];
        advisories.set(id ?? `${name}: ${via.title}`, { ...via, id, package: name });
      }
    }
  }
  const severe = [...advisories.values()].filter((advisory) => SEVERE.has(advisory.severity));
  const failures = severe
    .filter((advisory) => !advisory.id || !Object.hasOwn(exempt, advisory.id))
    .map(
      (advisory) =>
        `${advisory.package}: ${advisory.title} (${advisory.severity}, ${advisory.url})`,
    );
  if (severePackages > 0 && severe.length === 0) {
    failures.push(
      `npm marks ${severePackages} packages as high or critical and names no advisory for them.`,
    );
  }
  const named = new Set(severe.map((advisory) => advisory.id));
  return {
    ok: failures.length === 0,
    failures,
    exempted: Object.keys(exempt).filter((id) => named.has(id)),
    unused: Object.keys(exempt).filter((id) => !named.has(id)),
  };
}

function report(path) {
  if (path) return readFileSync(path, 'utf8');
  // npm exits with 1 when it finds an advisory, so the exit code says nothing here.
  const run = spawnSync('npm', ['--prefix', 'app', 'audit', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  return run.stdout;
}

function main() {
  let verdict;
  try {
    verdict = judge(JSON.parse(report(process.argv[2])));
  } catch (error) {
    console.error(`The audit report could not be read: ${error.message}`);
    process.exit(1);
  }
  for (const id of verdict.exempted) console.log(`Exempt: ${id}. ${EXEMPT[id]}`);
  for (const id of verdict.unused) {
    console.log(
      `::warning::The report names ${id} no more. Remove it from EXEMPT in ${process.argv[1]}.`,
    );
  }
  for (const failure of verdict.failures) console.error(failure);
  if (!verdict.ok) process.exit(1);
  console.log('No advisory of high or critical severity that is not exempt.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
