import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  defaultConfigPath,
  legacyConfigPath,
  loadConfig,
  maskSecret,
  MAX_TIMEOUT_MS,
  parseConfigText,
  parseEnvFile,
  parseTimeoutMs,
  parseYamlConfig,
  resolveConfigPath,
  updateConfigFile,
  yamlScalar,
} from '../src/config.mjs';

/** Throwaway directory for one test. */
function tempDir() {
  return mkdtempSync(join(tmpdir(), 'media-gen-config-'));
}

test('parseYamlConfig reads a flat mapping, quotes and comments', () => {
  const { values, unknownKeys } = parseYamlConfig(
    [
      '# media-gen',
      '---',
      'provider: ark',
      'imageSize: "2048x2048"',
      "outputDir: '/tmp/with space'",
      'baseUrl: https://example.test/api/v3   # trailing note',
      'apiKey:',
      'typo_key: x',
      '',
    ].join('\n'),
  );

  assert.equal(values.provider, 'ark');
  assert.equal(values.imageSize, '2048x2048');
  assert.equal(values.outputDir, '/tmp/with space');
  assert.equal(values.baseUrl, 'https://example.test/api/v3');
  assert.equal(values.apiKey, undefined);
  assert.deepEqual(unknownKeys, ['typo_key']);
});

test('parseYamlConfig refuses to invent structure', () => {
  const { values, unknownKeys } = parseYamlConfig(
    ['media:', '  provider: ark', 'MEDIA_GEN_API_KEY: file-key'].join('\n'),
  );

  // A nested block is not part of this format, and an environment variable name
  // is not a setting key. Both are reported instead of being half-read, because
  // a silently ignored key is indistinguishable from a broken setting.
  assert.deepEqual(values, {});
  assert.deepEqual(unknownKeys, ['media', 'provider', 'MEDIA_GEN_API_KEY']);
});

test('parseConfigText reads both spellings, even in one half-converted file', () => {
  const mixed = parseConfigText(
    ['export MEDIA_GEN_API_KEY=old-key', 'provider: ark'].join('\n'),
  );
  assert.equal(mixed.format, 'yaml');
  assert.equal(mixed.values.apiKey, 'old-key');
  assert.equal(mixed.values.provider, 'ark');

  const env = parseConfigText('MEDIA_GEN_IMAGE_SIZE="2048x2048"\n');
  assert.equal(env.format, 'env');
  assert.equal(env.values.imageSize, '2048x2048');
});

test('parseEnvFile still accepts export prefixes, quotes and comments', () => {
  const vars = parseEnvFile(
    [
      '# a comment',
      '',
      'export MEDIA_GEN_PROVIDER=ark',
      'MEDIA_GEN_IMAGE_SIZE="2048x2048"',
      "MEDIA_GEN_OUTPUT_DIR='/tmp/with space'",
      'MEDIA_GEN_BASE_URL=https://example.test/api/v3  # trailing note',
      'not an assignment',
    ].join('\n'),
  );

  assert.equal(vars.MEDIA_GEN_PROVIDER, 'ark');
  assert.equal(vars.MEDIA_GEN_IMAGE_SIZE, '2048x2048');
  assert.equal(vars.MEDIA_GEN_OUTPUT_DIR, '/tmp/with space');
  assert.equal(vars.MEDIA_GEN_BASE_URL, 'https://example.test/api/v3');
  assert.equal(vars['not an assignment'], undefined);
});

test('yamlScalar quotes only what YAML would otherwise reinterpret', () => {
  assert.equal(yamlScalar('ark'), 'ark');
  assert.equal(yamlScalar('1024x1024'), '1024x1024');
  assert.equal(yamlScalar('https://example.test/api/v3'), 'https://example.test/api/v3');
  // `~` starts a null in YAML, so an expanded home path must be quoted to survive.
  assert.equal(yamlScalar('~/Desktop/image_output'), '"~/Desktop/image_output"');
  assert.equal(yamlScalar('/tmp/with space'), '"/tmp/with space"');
  assert.equal(yamlScalar('no'), '"no"');
  assert.equal(yamlScalar('a"b'), '"a\\"b"');
});

test('resolveConfigPath honours MEDIA_GEN_CONFIG and XDG_CONFIG_HOME', () => {
  assert.equal(defaultConfigPath({ XDG_CONFIG_HOME: '/tmp/xdg' }), join('/tmp/xdg', 'media-gen', 'config.yml'));
  assert.equal(legacyConfigPath({ XDG_CONFIG_HOME: '/tmp/xdg' }), join('/tmp/xdg', 'media-gen', 'config.env'));
  assert.equal(
    resolveConfigPath({ XDG_CONFIG_HOME: '/tmp/xdg' }),
    join('/tmp/xdg', 'media-gen', 'config.yml'),
  );
  assert.equal(
    resolveConfigPath({ MEDIA_GEN_CONFIG: '/tmp/explicit.yml' }),
    '/tmp/explicit.yml',
  );
});

test('loadConfig reports values, provenance and the file format', () => {
  const path = join(tempDir(), 'config.yml');
  writeFileSync(path, 'imageModel: from-file\napiKey: file-key\n');

  const loaded = loadConfig({
    env: { MEDIA_GEN_CONFIG: path, MEDIA_GEN_IMAGE_MODEL: 'from-env' },
    cwd: '/tmp/workspace',
  });

  assert.equal(loaded.exists, true);
  assert.equal(loaded.format, 'yaml');
  assert.deepEqual(loaded.unknownKeys, []);
  assert.equal(loaded.values.provider, undefined);
  // The environment wins over the file.
  assert.equal(loaded.values.imageModel, 'from-env');
  assert.equal(loaded.sources.imageModel, 'env');
  // The file wins over nothing.
  assert.equal(loaded.values.apiKey, 'file-key');
  assert.equal(loaded.sources.apiKey, 'file');
  assert.equal(loaded.sources.provider, 'unset');
  assert.equal(loaded.cwd, '/tmp/workspace');
});

test('loadConfig tolerates a missing file', () => {
  const loaded = loadConfig({ env: { MEDIA_GEN_CONFIG: join(tempDir(), 'nope.yml') } });
  assert.equal(loaded.exists, false);
  assert.equal(loaded.values.apiKey, undefined);
});

test('loadConfig falls back to a pre-YAML config.env at the default location only', () => {
  const xdg = tempDir();
  mkdirSync(join(xdg, 'media-gen'));
  writeFileSync(join(xdg, 'media-gen', 'config.env'), 'export MEDIA_GEN_API_KEY=legacy-key\n');

  const legacy = loadConfig({ env: { XDG_CONFIG_HOME: xdg } });
  assert.equal(legacy.path, join(xdg, 'media-gen', 'config.env'));
  assert.equal(legacy.format, 'env');
  assert.equal(legacy.values.apiKey, 'legacy-key');

  // Once the YAML file exists it is the only one that counts.
  writeFileSync(join(xdg, 'media-gen', 'config.yml'), 'apiKey: yaml-key\n');
  const yaml = loadConfig({ env: { XDG_CONFIG_HOME: xdg } });
  assert.equal(yaml.path, join(xdg, 'media-gen', 'config.yml'));
  assert.equal(yaml.values.apiKey, 'yaml-key');

  // An explicitly named file is never silently substituted.
  const explicit = loadConfig({
    env: { XDG_CONFIG_HOME: xdg, MEDIA_GEN_CONFIG: join(xdg, 'nope.yml') },
  });
  assert.equal(explicit.path, join(xdg, 'nope.yml'));
  assert.equal(explicit.exists, false);
});

test('updateConfigFile preserves comments and unrelated lines', () => {
  const path = join(tempDir(), 'config.yml');
  writeFileSync(
    path,
    [
      '# hand written header',
      'apiKey: "old-key"',
      'imageModel: doubao-seedream-4-0-250828',
      '',
      '# keep me',
    ].join('\n'),
  );

  const previous = updateConfigFile(path, { imageModel: 'doubao-seedream-5-0-flash-260915' });
  const text = readFileSync(path, 'utf8');

  assert.match(text, /# hand written header/);
  assert.match(text, /# keep me/);
  assert.match(text, /imageModel: doubao-seedream-5-0-flash-260915/);
  assert.doesNotMatch(text, /doubao-seedream-4-0-250828/);
  // An untouched key keeps its original line form.
  assert.match(text, /apiKey: "old-key"/);
  assert.equal(previous.imageModel, 'doubao-seedream-4-0-250828');
});

test('updateConfigFile normalizes a pre-YAML line it rewrites', () => {
  const path = join(tempDir(), 'config.env');
  writeFileSync(path, 'export MEDIA_GEN_API_KEY="k"\nMEDIA_GEN_IMAGE_MODEL=old-model\n');

  updateConfigFile(path, { imageModel: 'new-model' });
  const text = readFileSync(path, 'utf8');

  assert.match(text, /imageModel: new-model/);
  // The line the patch did not touch is still read, so a half-converted file
  // keeps every setting it had.
  assert.match(text, /export MEDIA_GEN_API_KEY="k"/);
  const loaded = loadConfig({ env: { MEDIA_GEN_CONFIG: path } });
  assert.equal(loaded.values.apiKey, 'k');
  assert.equal(loaded.values.imageModel, 'new-model');
});

test('updateConfigFile appends keys it has not seen and locks the file down', () => {
  const path = join(tempDir(), 'config.yml');
  writeFileSync(path, 'provider: ark\n');

  updateConfigFile(path, { imageSize: '1024x1024', outputDir: '/tmp/out dir' });
  const text = readFileSync(path, 'utf8');

  assert.match(text, /provider: ark/);
  assert.match(text, /imageSize: 1024x1024/);
  // A value with a space is quoted so the mapping stays unambiguous.
  assert.match(text, /outputDir: "\/tmp\/out dir"/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(text.endsWith('\n'), true);
});

test('updateConfigFile creates a missing file and rejects unknown keys', () => {
  const path = join(tempDir(), 'nested', 'config.yml');
  updateConfigFile(path, { provider: 'ark' });
  assert.match(readFileSync(path, 'utf8'), /provider: ark/);

  assert.throws(() => updateConfigFile(path, { nope: 'x' }), /unknown setting "nope"/);
});

test('parseTimeoutMs accepts numbers and numeric strings, and bounds them', () => {
  assert.equal(parseTimeoutMs(600_000), 600_000);
  // A YAML scalar arrives as a string.
  assert.equal(parseTimeoutMs('600000'), 600_000);
  assert.equal(parseTimeoutMs(MAX_TIMEOUT_MS), MAX_TIMEOUT_MS);

  assert.throws(() => parseTimeoutMs(0), /must be a positive whole number of milliseconds/);
  assert.throws(() => parseTimeoutMs('-1'), /must be a positive whole number/);
  assert.throws(() => parseTimeoutMs('soon'), /must be a positive whole number/);
  assert.throws(() => parseTimeoutMs('1.5'), /must be a positive whole number/);
  // Over an hour is a mistake, not something to quietly clamp.
  assert.throws(() => parseTimeoutMs(MAX_TIMEOUT_MS + 1), /must be at most 3600000 ms/);
});

test('loadConfig reads the configured timeouts', () => {
  const path = join(tempDir(), 'config.yml');
  writeFileSync(path, 'imageTimeoutMs: 300000\nvideoTimeoutMs: "900000"\n');

  const loaded = loadConfig({ env: { MEDIA_GEN_CONFIG: path } });

  assert.equal(loaded.values.imageTimeoutMs, '300000');
  assert.equal(loaded.values.videoTimeoutMs, '900000');
  assert.equal(loaded.sources.imageTimeoutMs, 'file');
});

test('maskSecret never reveals a usable key', () => {
  assert.equal(maskSecret(undefined), '(unset)');
  assert.equal(maskSecret('short'), 'sh…rt');
  // Assembled at run time, not written literally: a credential-shaped string in
  // a file trips push protection, and the redaction is what is under test here.
  const key = ['ark', '11111111', '2222', '3333', '4444', '555555555555', '9999'].join('-');
  const masked = maskSecret(key);

  assert.equal(masked, 'ark-1111…9999');
  assert.equal(masked.includes('3333'), false);
  assert.equal(masked.length < key.length, true);
});
