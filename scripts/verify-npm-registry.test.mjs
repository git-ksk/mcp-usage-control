import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyRegistryVisibility } from './verify-npm-registry.mjs';

const name = 'mcp-usage-control';
const version = '1.2.3';
const bytes = Buffer.from('synthetic immutable release package bytes');
const digest = kind => createHash(kind).update(bytes).digest(kind === 'sha512' ? 'base64' : 'hex');
async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'muc-registry-test-'));
  try {
    await writeFile(join(dir, `${name}-${version}.tgz`), bytes);
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
function registry({ readyOnAttempt = 1, alteredBytes = false, alteredIntegrity = false, wrongLatest = false, noAttestation = false } = {}) {
  return async url => {
    const attempt = Number(new URL(url).searchParams.get('propagation_attempt') ?? 1);
    if (url.includes('/-/mcp-usage-control-')) {
      return new Response(alteredBytes ? 'different published bytes' : bytes, { status: 200 });
    }
    if (attempt < readyOnAttempt) return new Response('not yet visible', { status: 404 });
    if (url.includes('/dist-tags')) return Response.json({ latest: wrongLatest ? '1.2.2' : version });
    return Response.json({ name, version, dist: {
      shasum: digest('sha1'),
      integrity: alteredIntegrity ? 'sha512-invalid' : `sha512-${digest('sha512')}`,
      tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
      signatures: [{ sig: 'signed', keyid: 'mock' }],
      ...(!noAttestation ? { attestations: { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } } : {}),
    } });
  };
}

test('eventual visibility later than 90 seconds is accepted within bounded 15-minute budget', async () => {
  await fixture(async artifactsDirectory => {
    let virtualMs = 0;
    const result = await verifyRegistryVisibility({
      version, artifactsDirectory, names: [name], request: registry({ readyOnAttempt: 9 }),
      pause: async ms => { virtualMs += ms; }, report: () => {},
    });
    assert.equal(result.attempts, 9);
    assert.equal(virtualMs, 120_000);
  });
});

test('already-published artifact is verified and no publication action exists', () => fixture(async artifactsDirectory => {
  let requests = 0;
  const result = await verifyRegistryVisibility({
    version, artifactsDirectory, names: [name], request: async url => { requests++; return registry()(url); },
    pause: async () => { throw new Error('must not wait'); }, report: () => {},
  });
  assert.equal(result.verified.length, 1);
  assert.equal(requests, 3);
}));

test('version that never appears fails within explicit finite attempt ceiling', () => fixture(async artifactsDirectory => {
  let sleeps = 0;
  await assert.rejects(() => verifyRegistryVisibility({
    version, artifactsDirectory, names: [name], maxAttempts: 4,
    request: registry({ readyOnAttempt: 99 }),
    pause: async () => { sleeps++; }, report: () => {},
  }), /timed out/);
  assert.equal(sleeps, 3);
}));

for (const [reason, opts] of [
  ['different registry integrity', { alteredIntegrity: true }],
  ['different exact archive bytes', { alteredBytes: true }],
]) {
  test(`published immutable bytes mismatch fails hard: ${reason}`, () => fixture(async artifactsDirectory => {
    await assert.rejects(() => verifyRegistryVisibility({
      version, artifactsDirectory, names: [name], request: registry(opts), report: () => {},
    }), /IMMUTABLE ARTIFACT MISMATCH/);
  }));
}

test('latest tag lag or missing attestation cannot silently pass', () => fixture(async artifactsDirectory => {
  for (const opts of [{ wrongLatest: true }, { noAttestation: true }]) {
    await assert.rejects(() => verifyRegistryVisibility({
      version, artifactsDirectory, names: [name], request: registry(opts),
      maxAttempts: 2, pause: async () => {}, report: () => {},
    }), /timed out/);
  }
}));


test('transient registry transport failure is treated as pending rather than different published bytes', () => fixture(async artifactsDirectory => {
  let calls = 0;
  const request = async url => {
    calls += 1;
    if (calls === 3) throw Object.assign(new Error('socket timeout'), { name: 'TimeoutError' });
    return registry()(url);
  };
  const result = await verifyRegistryVisibility({
    version, artifactsDirectory, names: [name], request,
    maxAttempts: 3, pause: async () => {}, report: () => {},
  });
  assert.equal(result.attempts, 2);
}));


test('CLI invoked through a symbolic-link path never silently skips verification', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'muc-registry-cli-'));
  try {
    const alias = join(dir, 'registry-check-alias.mjs');
    await symlink(fileURLToPath(new URL('./verify-npm-registry.mjs', import.meta.url)), alias);
    const result = spawnSync(process.execPath, [alias], { encoding: 'utf8' });
    assert.equal(result.status, 2, `expected CLI usage failure, not an unconditional success: ${result.stderr}`);
    assert.match(result.stderr, /usage:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
