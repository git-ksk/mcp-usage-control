import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));

test('help enumerates actual provider-backed modes without launching an external process', () => {
  const done = spawnSync(process.execPath, [runner, '--help'], { encoding: 'utf8', timeout: 6000 });
  assert.equal(done.status, 0);
  assert.match(done.stdout, /<redis\|firestore\|cloudflare\|all>/);
});

test('missing backend fails, never substitutes an in-memory implementation', () => {
  const done = spawnSync(process.execPath, [runner, 'firestore'], {
    encoding: 'utf8', timeout: 6000,
    env: { ...process.env, FIRESTORE_EMULATOR_HOST: '' },
  });
  assert.notEqual(done.status, 0);
  assert.match(done.stderr, /FIRESTORE_EMULATOR_HOST required/);
});

test('occupied workerd port rejects instead of running against an unrelated DO', async () => {
  const blocker = createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(8799, '127.0.0.1', resolve);
  });
  try {
    const done = spawnSync(process.execPath, [runner, 'cloudflare', '--start-workerd'], {
      encoding: 'utf8', timeout: 6000,
    });
    assert.notEqual(done.status, 0);
    assert.match(done.stderr, /port 8799 is already in use/);
    assert.doesNotMatch(done.stdout, /PASS:/);
  } finally {
    await new Promise(resolve => blocker.close(resolve));
  }
});
