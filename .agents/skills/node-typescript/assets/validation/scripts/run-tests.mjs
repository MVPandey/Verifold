import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

async function findTests(directory) {
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return files;
    throw error;
  }
  for (const entry of entries) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) files.push(...(await findTests(url)));
    else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(fileURLToPath(url));
  }
  return files.sort();
}

const files = await findTests(new URL('../.test-build/tests/', import.meta.url));
if (files.length === 0) {
  console.error('No compiled test files found. Validation requires a test suite.');
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit' });
  child.once('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once('close', (code) => {
    process.exitCode = code ?? 1;
  });
}
