import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const mode = process.argv[2];
const packageJsonPath = resolve(process.cwd(), 'package.json');
const backupPath = resolve(process.cwd(), '.muc-package-json.prepack');

async function workspaceVersions() {
  const packagesDir = resolve(process.cwd(), '..');
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const versions = new Map();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await readFile(resolve(packagesDir, entry.name, 'package.json'), 'utf8');
      const manifest = JSON.parse(raw);
      if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
        versions.set(manifest.name, manifest.version);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  return versions;
}

function normalizeWorkspaceSpec(spec, version, dependencyName) {
  if (spec === 'workspace:' || spec === 'workspace:*') return version;
  if (spec === 'workspace:^') return `^${version}`;
  if (spec === 'workspace:~') return `~${version}`;

  const explicit = spec.slice('workspace:'.length);
  if (/^[~^]?\d/.test(explicit)) return explicit;

  throw new Error(
    `unsupported workspace dependency spec for ${dependencyName}: ${spec}`,
  );
}

async function prepare() {
  const raw = await readFile(packageJsonPath, 'utf8');
  try {
    await readFile(backupPath, 'utf8');
    throw new Error(`prepack backup already exists: ${backupPath}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const manifest = JSON.parse(raw);
  const versions = await workspaceVersions();
  let changed = false;

  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const dependencies = manifest[section];
    if (!dependencies) continue;

    for (const [name, spec] of Object.entries(dependencies)) {
      if (typeof spec !== 'string' || !spec.startsWith('workspace:')) continue;
      const version = versions.get(name);
      if (!version) {
        throw new Error(`cannot resolve workspace package version for ${name}`);
      }
      dependencies[name] = normalizeWorkspaceSpec(spec, version, name);
      changed = true;
    }
  }

  if (manifest.scripts?.prepack || manifest.scripts?.postpack) {
    delete manifest.scripts.prepack;
    delete manifest.scripts.postpack;
    changed = true;
  }

  await writeFile(backupPath, raw, 'utf8');
  if (changed) {
    await writeFile(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
}

async function restore() {
  try {
    const raw = await readFile(backupPath, 'utf8');
    await writeFile(packageJsonPath, raw, 'utf8');
    await rm(backupPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

if (mode === 'prepare') {
  await prepare();
} else if (mode === 'restore') {
  await restore();
} else {
  throw new Error('usage: node scripts/pack-workspace-deps.mjs <prepare|restore>');
}
