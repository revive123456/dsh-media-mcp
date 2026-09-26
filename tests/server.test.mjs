import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SECRET, fixtureConfig, startServer } from './helpers.mjs';

/** Env a normal harness launch would give the child. */
function launchEnv(configPath) {
  return { ...process.env, MEDIA_GEN_CONFIG: configPath, HOME: tmpdir() };
}

test('server speaks the MCP handshake and exposes three tools', async (t) => {
  const { path } = fixtureConfig();
  const server = startServer(launchEnv(path));
  t.after(() => server.child.kill());

  const init = await server.rpc(1, 'initialize', { protocolVersion: '2024-11-05' });
  assert.equal(init.result.serverInfo.name, 'media-gen');
  assert.equal(init.result.protocolVersion, '2024-11-05');
  assert.match(init.result.instructions, /generate_image/);

  const list = await server.rpc(2, 'tools/list', {});
  assert.deepEqual(
    list.result.tools.map((tool) => tool.name),
    ['generate_image', 'generate_video', 'get_config', 'set_config'],
  );
  // The prompt is the one required field, which is what makes the tool usable
  // from a plain natural-language request.
  const generate = list.result.tools.find((tool) => tool.name === 'generate_image');
  assert.deepEqual(generate.inputSchema.required, ['prompt']);
});

test('get_config reports settings and never leaks the key', async (t) => {
  const { path } = fixtureConfig();
  const server = startServer(launchEnv(path));
  t.after(() => server.child.kill());

  const response = await server.rpc(1, 'tools/call', { name: 'get_config', arguments: {} });
  const text = response.result.content[0].text;

  assert.equal(response.result.isError, undefined);
  assert.equal(text.includes(SECRET), false);
  assert.match(text, /unit-tes…cdef/);
  assert.match(text, /doubao-seedream-4-0-250828/);
  assert.match(text, />=3686400px/);
  assert.match(text, /config file : .*config\.yml \(present\)/);
  // The timeouts are reported, so "why did my call stop?" is answerable without
  // reading the source.
  assert.match(text, /timeouts\s+: image 180s, video 720s/);
});

test('set_config persists a change that the very next call observes', async (t) => {
  const { path } = fixtureConfig();
  const server = startServer(launchEnv(path));
  t.after(() => server.child.kill());

  const saved = await server.rpc(1, 'tools/call', {
    name: 'set_config',
    arguments: { imageModel: 'doubao-seedream-5-0-flash-260915', imageSize: '2048x2048' },
  });
  assert.equal(saved.result.isError, undefined);
  assert.match(saved.result.content[0].text, /configuration saved \(imageModel, imageSize\)/);

  // The file on disk changed...
  const text = readFileSync(path, 'utf8');
  assert.match(text, /imageModel: doubao-seedream-5-0-flash-260915/);
  assert.match(text, /imageSize: 2048x2048/);

  // ...and no restart was needed for the next call to see it.
  const after = await server.rpc(2, 'tools/call', { name: 'get_config', arguments: {} });
  assert.match(after.result.content[0].text, /image model : doubao-seedream-5-0-flash-260915/);
});

test('a rejected set_config comes back as a readable tool error', async (t) => {
  const { path } = fixtureConfig();
  const before = readFileSync(path, 'utf8');
  const server = startServer(launchEnv(path));
  t.after(() => server.child.kill());

  const response = await server.rpc(1, 'tools/call', {
    name: 'set_config',
    arguments: { imageSize: 'huge' },
  });

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /size must look like WxH/);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('generate_image reports a missing key instead of calling the provider', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'media-gen-nokey-'));
  const path = join(dir, 'config.yml');
  writeFileSync(path, 'provider: ark\n');
  const server = startServer(launchEnv(path));
  t.after(() => server.child.kill());

  const response = await server.rpc(1, 'tools/call', {
    name: 'generate_image',
    arguments: { prompt: 'a cat' },
  });

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /no API key configured/);
});

test('an unknown method is rejected without killing the server', async (t) => {
  const { path } = fixtureConfig();
  const server = startServer(launchEnv(path));
  t.after(() => server.child.kill());

  const bad = await server.rpc(1, 'does/not/exist', {});
  assert.equal(bad.error.code, -32601);

  const still = await server.rpc(2, 'tools/list', {});
  assert.equal(still.result.tools.length, 4);
});
