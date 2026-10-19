#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const tests = {
  redis: 'packages/redis/test/mcp-sdk-e2e.mjs',
  firestore: 'packages/firestore/test/mcp-sdk-e2e.mjs',
  cloudflare: 'packages/cloudflare/test/mcp-sdk-e2e.mjs',
};
const args = process.argv.slice(2);
const provider = args[0];
const startWorkerd = args.includes('--start-workerd');

// A generic /health on 8799 cannot prove it belongs to *this* isolated
// workerd. Refuse to launch if an earlier process already owns the test port;
// otherwise this command could incorrectly report a "fresh DO" PASS against
// an unrelated or persistent Worker left behind by another test.
async function assertWorkerdPortAvailable() {
  const probe = createServer();
  try {
    await new Promise((done, reject) => {
      probe.once('error', reject);
      probe.listen(8799, '127.0.0.1', done);
    });
  } catch (error) {
    throw new Error(`Local workerd port 8799 is already in use; cannot prove isolated execution (${error?.code ?? 'bind error'})`);
  } finally {
    if (probe.listening) {
      await new Promise((done, reject) => probe.close(error => error ? reject(error) : done()));
    }
  }
}

if (args.includes('--help') || args.includes('-h') || !provider) {
  console.log(`Usage: node examples/mcp-durable-multi-round/run.mjs <redis|firestore|cloudflare|all> [--start-workerd]\n\nRedis: REDIS_URL=redis://127.0.0.1:6379 (server must be running).\nFirestore: FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 (emulator only).\nCloudflare: local Wrangler worker on 127.0.0.1:8799; --start-workerd launches a fresh isolated test worker.\nOnly test identities and localhost are used. No production credentials, datasets, or paid APIs.`);
  process.exitCode = provider ? 0 : 2;
} else if (!tests[provider] && provider !== 'all') {
  console.error('Unknown provider. Use --help for supported test runners.');
  process.exitCode = 2;
} else {
  const providers = provider === 'all' ? Object.keys(tests) : [provider];
  for (const name of providers) {
    if (name === 'redis' && !process.env.REDIS_URL) throw new Error('REDIS_URL required for real Redis E2E');
    if (name === 'firestore' && !process.env.FIRESTORE_EMULATOR_HOST) throw new Error('FIRESTORE_EMULATOR_HOST required; NEVER target production Firestore');
    if (!existsSync(join(root, tests[name]))) throw new Error(`Missing provider E2E script: ${tests[name]}`);
  }
  let workerd;
  let temporaryDirectory;
  try {
    if (providers.includes('cloudflare') && startWorkerd) {
      await assertWorkerdPortAvailable();
      temporaryDirectory = await mkdtemp(join(tmpdir(), 'muc-v130-do-sdk-e2e-'));
      workerd = spawn('pnpm', ['dlx', 'wrangler@4.114.0', 'dev', '--local',
        '--config', 'packages/cloudflare/wrangler.test.jsonc',
        '--persist-to', temporaryDirectory, '--port', '8799'],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      workerd.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
      workerd.stdout.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
      let ready = false;
      for (let i = 0; i < 45; i++) {
        if (workerd.exitCode !== null) throw new Error(`workerd exited unexpectedly:\n${stderr}`);
        try {
          const response = await fetch('http://127.0.0.1:8799/health', { signal: AbortSignal.timeout(1000) });
          if (response.ok) { ready = true; break; }
        } catch { /* workerd starting */ }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (!ready) throw new Error(`workerd not ready:\n${stderr}`);
    }
    for (const name of providers) {
      console.log(`Running official MCP SDK v2 HTTP E2E for provider ${name}`);
      const child = spawn(process.execPath, [tests[name]], { cwd: root, env: process.env, stdio: 'inherit' });
      const result = await new Promise((done, fail) => { child.once('error', fail); child.once('exit', (code, signal) => done({ code, signal })); });
      if (result.code !== 0) throw new Error(`Provider ${name} E2E failed (exit=${result.code} signal=${result.signal})`);
    }
    console.log(`PASS: ${providers.join(', ')} provider-backed official MCP HTTP E2E`);
  } finally {
    if (workerd) workerd.kill('SIGTERM');
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
