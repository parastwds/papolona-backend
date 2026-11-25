/**
 * `npm test`: the full test suite on an in-memory PostgreSQL (PGlite, nothing to install).
 * Runs Jest with --experimental-vm-modules because PGlite loads its WebAssembly with import().
 * Extra arguments go to Jest.
 */
const { spawnSync } = require('child_process');

const result = spawnSync(
  process.execPath,
  ['--experimental-vm-modules', require.resolve('jest/bin/jest'), '--runInBand', ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
