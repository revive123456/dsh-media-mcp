/**
 * Shared test helpers.
 *
 * Not a `*.test.mjs` file, so the runner does not treat it as a suite.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const SERVER = join(root, 'src', 'server.mjs');
export const SECRET = 'unit-test-key-abcdef';

/**
 * Reproduce the scrub `@deepseek-ai/dsh-subprocess` applies before spawning any
 * harness child. Kept in sync by hand; the real definition is
 * `SENSITIVE_ENV_PATTERN` in that package.
 */
export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;

/** Drop credential-shaped and `DSH_*` names, exactly as the harness does. */
export function scrubbedEnv(parent = process.env) {
  const env = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (SENSITIVE_ENV_PATTERN.test(name)) continue;
    if (name.toUpperCase().startsWith('DSH_')) continue;
    env[name] = value;
  }
  return env;
}

/** Spawn the real server and expose a request/response helper over its stdio. */
export function startServer(env) {
  const child = spawn(process.execPath, [SERVER], {
    env,
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  const queue = [];
  const waiters = [];
  let buffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line === '') continue;
      const message = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter === undefined) queue.push(message);
      else waiter(message);
    }
  });

  return {
    child,
    rpc(id, method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

/** Create an isolated config file a spawned server can be pointed at. */
export function fixtureConfig({ apiKey = SECRET } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'media-gen-fixture-'));
  const path = join(dir, 'config.yml');
  const lines = ['provider: ark'];
  if (apiKey !== undefined) lines.push(`apiKey: ${apiKey}`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return { dir, path };
}
