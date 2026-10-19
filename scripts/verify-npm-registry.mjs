import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RELEASE_PACKAGES = Object.freeze([
  'mcp-usage-control', 'mcp-usage-control-mcp', 'mcp-usage-control-redis',
  'mcp-usage-control-cloudflare', 'mcp-usage-control-firestore',
]);

const digest = (bytes, algorithm) => createHash(algorithm).update(bytes).digest(algorithm === 'sha512' ? 'base64' : 'hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// These strict inputs come from the manually authorized, immutable release tag.
export async function verifyRegistryVisibility({
  version, artifactsDirectory, names = RELEASE_PACKAGES,
  maxAttempts = 61, intervalMs = 15_000,
  request = fetch, pause = sleep, report = line => console.log(line),
}) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('invalid immutable release version');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 101) throw new Error('invalid maxAttempts');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 60_000) throw new Error('invalid intervalMs');
  if (!Array.isArray(names) || names.length === 0 || names.some(name => !RELEASE_PACKAGES.includes(name))) {
    throw new Error('unrecognized npm release package');
  }
  const localArchives = new Map();
  for (const name of names) {
    const archive = await readFile(resolve(artifactsDirectory, `${name}-${version}.tgz`));
    localArchives.set(name, {
      sha256: digest(archive, 'sha256'),
      sha512: `sha512-${digest(archive, 'sha512')}`,
      shasum: digest(archive, 'sha1'),
    });
  }

  const confirmed = new Set();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const pending = [];
    for (const name of names) {
      if (confirmed.has(name)) continue;
      const base = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
      const versionUrl = `${base}/${version}?propagation_attempt=${attempt}`;
      const tagsUrl = `https://registry.npmjs.org/-/package/${encodeURIComponent(name)}/dist-tags?propagation_attempt=${attempt}`;
      let metadata, tags;
      try {
        const versionResponse = await request(versionUrl, { cache: 'no-store' });
        if (!versionResponse.ok) { pending.push(`${name}@${version}: version HTTP ${versionResponse.status}`); continue; }
        metadata = await versionResponse.json();
        const tagsResponse = await request(tagsUrl, { cache: 'no-store' });
        if (!tagsResponse.ok) { pending.push(`${name}@${version}: tag HTTP ${tagsResponse.status}`); continue; }
        tags = await tagsResponse.json();
      } catch (error) {
        pending.push(`${name}@${version}: registry read unavailable (${error?.name ?? 'error'})`);
        continue;
      }
      if (metadata?.name !== name || metadata.version !== version) {
        pending.push(`${name}@${version}: incomplete version metadata`);
        continue;
      }
      if (tags?.latest !== version) {
        pending.push(`${name}@${version}: latest dist-tag not propagated`);
        continue;
      }
      const expected = localArchives.get(name);
      const dist = metadata.dist;
      if (!dist || !Array.isArray(dist.signatures) || dist.signatures.length === 0 ||
        dist.attestations?.provenance?.predicateType !== 'https://slsa.dev/provenance/v1') {
        pending.push(`${name}@${version}: provenance/signatures metadata pending`);
        continue;
      }
      if (dist.shasum !== expected.shasum || dist.integrity !== expected.sha512) {
        throw new Error(`IMMUTABLE ARTIFACT MISMATCH: registry integrity is different for ${name}@${version}`);
      }
      const tarball = new URL(dist.tarball);
      if (tarball.protocol !== 'https:' || tarball.hostname !== 'registry.npmjs.org' ||
          !tarball.pathname.startsWith(`/${name}/-/`)) {
        throw new Error(`invalid registry tarball location for ${name}@${version}`);
      }
      let response, bytes;
      try {
        response = await request(tarball.href, { cache: 'no-store' });
        if (!response.ok) { pending.push(`${name}@${version}: tarball HTTP ${response.status}`); continue; }
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        pending.push(`${name}@${version}: tarball download unavailable (${error?.name ?? 'error'})`);
        continue;
      }
      if (digest(bytes, 'sha256') !== expected.sha256) {
        throw new Error(`IMMUTABLE ARTIFACT MISMATCH: downloaded tarball bytes differ for ${name}@${version}`);
      }
      confirmed.add(name);
      report(`verified immutable ${name}@${version}: exact archive bytes, latest tag, provenance metadata`);
    }
    if (confirmed.size === names.length) {
      report(`registry verification complete: ${confirmed.size}/${names.length} in ${attempt} attempts`);
      return { attempts: attempt, verified: [...confirmed] };
    }
    report(`registry propagation pending (attempt ${attempt}/${maxAttempts}, elapsed up to ${(attempt - 1) * intervalMs / 1000}s): ${pending.join('; ')}`);
    if (attempt < maxAttempts) await pause(intervalMs);
  }
  throw new Error(`registry propagation verification timed out after ${maxAttempts} attempts; ${names.length - confirmed.size} package(s) missing`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [version, artifactsDirectory, onePackage] = process.argv.slice(2);
  if (!version || !artifactsDirectory) {
    console.error('usage: node scripts/verify-npm-registry.mjs <version> <immutable-release-artifacts-dir> [one-package-name]');
    process.exitCode = 2;
  } else {
    await verifyRegistryVisibility({ version, artifactsDirectory, names: onePackage ? [onePackage] : RELEASE_PACKAGES }).catch(error => {
      console.error(`registry verification FAILED: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
