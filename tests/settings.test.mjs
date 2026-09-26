import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { describeConfig } from '../src/describe.mjs';
import { applyConfigPatch, currentSettings } from '../src/settings.mjs';

/** Isolated config file plus the env that points at it. */
function fixture(seed = '') {
  const dir = mkdtempSync(join(tmpdir(), 'media-gen-settings-'));
  const path = join(dir, 'config.yml');
  if (seed !== '') writeFileSync(path, seed);
  return { env: { MEDIA_GEN_CONFIG: path }, cwd: dir, path };
}

test('applyConfigPatch persists a change and returns the reloaded settings', () => {
  const { env, cwd, path } = fixture('provider: ark\napiKey: unit-test-key\n');

  const settings = applyConfigPatch(
    { imageModel: 'doubao-seedream-5-0-flash-260915' },
    { env, cwd },
  );

  assert.equal(settings.imageModel, 'doubao-seedream-5-0-flash-260915');
  assert.match(readFileSync(path, 'utf8'), /imageModel: doubao-seedream-5-0-flash-260915/);
});

test('applyConfigPatch rejects unknown keys, bad sizes and unknown providers', () => {
  const { env, cwd, path } = fixture('provider: ark\n');
  const before = readFileSync(path, 'utf8');

  assert.throws(() => applyConfigPatch({ nope: 'x' }, { env, cwd }), /unknown setting\(s\): nope/);
  assert.throws(() => applyConfigPatch({ imageSize: 'huge' }, { env, cwd }), /size must look like WxH/);
  assert.throws(() => applyConfigPatch({ provider: 'nope' }, { env, cwd }), /unknown provider "nope"/);
  assert.throws(() => applyConfigPatch({ apiKey: '   ' }, { env, cwd }), /must not be empty/);
  assert.throws(() => applyConfigPatch({}, { env, cwd }), /no settings to change/);

  // A rejected patch must leave the file exactly as it was.
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('applyConfigPatch can store a key, a video model and clear the output directory', () => {
  const { env, cwd, path } = fixture('provider: ark\n');

  const withKey = applyConfigPatch({ apiKey: 'fresh-key' }, { env, cwd });
  assert.equal(withKey.apiKey, 'fresh-key');

  const withVideo = applyConfigPatch({ videoModel: 'doubao-seedance-1-0-pro-250528' }, { env, cwd });
  assert.equal(withVideo.videoModel, 'doubao-seedance-1-0-pro-250528');
  assert.match(readFileSync(path, 'utf8'), /videoModel: doubao-seedance-1-0-pro-250528/);

  const withOutput = applyConfigPatch({ outputDir: '/tmp/pics' }, { env, cwd });
  assert.equal(withOutput.outputDir, '/tmp/pics');

  const cleared = applyConfigPatch({ outputDir: '' }, { env, cwd });
  assert.equal(cleared.outputDir, undefined);

  assert.throws(() => applyConfigPatch({ videoModel: '  ' }, { env, cwd }), /videoModel must not be empty/);
});

test('applyConfigPatch persists and validates the timeouts', () => {
  const { env, cwd, path } = fixture('provider: ark\n');

  const saved = applyConfigPatch(
    { imageTimeoutMs: 300_000, videoTimeoutMs: 1_200_000 },
    { env, cwd },
  );
  assert.equal(saved.imageTimeoutMs, 300_000);
  assert.equal(saved.videoTimeoutMs, 1_200_000);
  const text = readFileSync(path, 'utf8');
  assert.match(text, /imageTimeoutMs: 300000/);
  assert.match(text, /videoTimeoutMs: 1200000/);

  // A rejected value must not be written.
  const before = readFileSync(path, 'utf8');
  assert.throws(
    () => applyConfigPatch({ videoTimeoutMs: 9_999_999 }, { env, cwd }),
    /must be at most 3600000 ms/,
  );
  assert.throws(
    () => applyConfigPatch({ imageTimeoutMs: 'soon' }, { env, cwd }),
    /must be a positive whole number/,
  );
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('describeConfig never prints the key and states the constraints', () => {
  const { env, cwd } = fixture(
    'provider: ark\napiKey: super-secret-value\nimageModel: doubao-seedream-4-5-251128\n',
  );

  const text = describeConfig(currentSettings({ env, cwd }));

  assert.equal(text.includes('super-secret-value'), false);
  assert.match(text, /API key\s+: super-se…alue/);
  assert.match(text, /doubao-seedream-4-5-251128/);
  assert.match(text, />=3686400px/);
  assert.match(text, /config file : .*config\.yml \(present\)/);
  // The current format is the silent case; only a legacy file is called out.
  assert.doesNotMatch(text, /legacy/);
});

test('describeConfig calls out a legacy env file and the keys it ignored', () => {
  const { env, cwd } = fixture(
    ['export MEDIA_GEN_API_KEY=legacy-key', 'imagModel: typo', 'media:', '  imageSize: 2048x2048'].join('\n'),
  );

  const text = describeConfig(currentSettings({ env, cwd }));

  assert.match(text, /format\s+: env assignments — legacy, rename the file to config\.yml/);
  assert.match(text, /ignored\s+: imagModel, media, imageSize \(not a setting — check the spelling\)/);
  // The misplaced and misspelled keys set nothing: the size is still the default.
  assert.match(text, /image size  : 1024x1024/);
});
