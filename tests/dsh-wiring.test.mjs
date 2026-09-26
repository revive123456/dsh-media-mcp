/**
 * Integration contract with DeepSeek Harness.
 *
 * DSH never forwards a credential-shaped environment variable to an MCP child:
 * `scrubbedParentEnv()` in `@deepseek-ai/dsh-subprocess` drops every name
 * matching `/KEY|PASSWORD|SECRET|TOKEN/i` before the spawn. `MEDIA_GEN_API_KEY`
 * matches that pattern.
 *
 * These tests pin the consequence: the API key can only ever arrive through the
 * config file, so the server must work with a fully scrubbed environment and no
 * shell profile setting anything. If someone later "simplifies" the server to
 * read the key from the environment, this file fails.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { SECRET, fixtureConfig, scrubbedEnv, startServer } from './helpers.mjs';
import { KEY_SPEC } from '../src/config.mjs';

test('the DSH scrub removes MEDIA_GEN_API_KEY but keeps HOME and PATH', () => {
  const scrubbed = scrubbedEnv({
    PATH: '/usr/bin',
    HOME: '/home/someone',
    LANG: 'en_US.UTF-8',
    DEEPSEEK_API_KEY: 'sk-parent-secret',
    MEDIA_GEN_API_KEY: SECRET,
    DSH_HOME: '/home/someone/.dsh',
    DSH_PROFILE: 'web',
  });

  // The credential-shaped names are gone...
  assert.equal(scrubbed.MEDIA_GEN_API_KEY, undefined);
  assert.equal(scrubbed.DEEPSEEK_API_KEY, undefined);
  // ...harness identity is gone...
  assert.equal(scrubbed.DSH_HOME, undefined);
  assert.equal(scrubbed.DSH_PROFILE, undefined);
  // ...and the ordinary environment a child needs survives.
  assert.equal(scrubbed.PATH, '/usr/bin');
  assert.equal(scrubbed.HOME, '/home/someone');
  assert.equal(scrubbed.LANG, 'en_US.UTF-8');
});

test('the config file alone is enough, with nothing set in the shell', async (t) => {
  const { path } = fixtureConfig();
  const before = readFileSync(path, 'utf8');

  // Start from a parent environment that has no MEDIA_GEN_* value at all, then
  // apply the harness scrub. This is the worst case: no shell profile exported
  // anything and the harness stripped credentials on top.
  const parent = { ...process.env };
  for (const name of Object.keys(parent)) {
    if (name.startsWith('MEDIA_GEN_')) delete parent[name];
  }
  const env = scrubbedEnv(parent);
  assert.equal(env.MEDIA_GEN_API_KEY, undefined);
  env.MEDIA_GEN_CONFIG = path;
  env.HOME = tmpdir();

  const server = startServer(env);
  t.after(() => server.child.kill());

  const response = await server.rpc(1, 'tools/call', { name: 'get_config', arguments: {} });
  const text = response.result.content[0].text;

  // The key was resolved even though no environment variable carried it...
  assert.match(text, /API key\s+: unit-tes…cdef/);
  assert.match(text, /MEDIA_GEN_API_KEY\s+from config file/);
  assert.equal(text.includes(SECRET), false);

  // ...and a settings change still lands in that file.
  const saved = await server.rpc(2, 'tools/call', {
    name: 'set_config',
    arguments: { imageSize: '2048x2048' },
  });
  assert.equal(saved.result.isError, undefined);
  assert.match(readFileSync(path, 'utf8'), /imageSize: 2048x2048/);

  // The file is the only thing that changed.
  assert.notEqual(readFileSync(path, 'utf8'), before);
});

test('the scrub is not defeated by the name of the setting', () => {
  // Guards the reasoning above: if the key were ever renamed to something the
  // pattern misses, the environment would silently start mattering again.
  assert.match(KEY_SPEC.apiKey.env, /KEY/);
});
