import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildImageFileName,
  expandHome,
  parseSize,
  pixelsOf,
  resolveOutputDir,
  suggestedSize,
  timestamp,
  validateImageRequest,
  writeUniqueFileSync,
} from '../src/images.mjs';
import { PROVIDERS, findImageModel, resolveProvider, resolveSettings } from '../src/providers.mjs';

const ark = PROVIDERS.ark;

test('parseSize accepts WxH and rejects anything else', () => {
  assert.deepEqual(parseSize('2048x2048'), { width: 2048, height: 2048 });
  assert.deepEqual(parseSize(' 1024X1024 '), { width: 1024, height: 1024 });
  assert.throws(() => parseSize('1024'), /size must look like WxH/);
  assert.throws(() => parseSize('1024*1024'), /size must look like WxH/);
  assert.throws(() => parseSize(undefined), /size must look like WxH/);
});

test('pixelsOf multiplies the parsed dimensions', () => {
  assert.equal(pixelsOf('1920x1080'), 2073600);
  assert.equal(pixelsOf('1024x1024'), 1048576);
});

test('validateImageRequest enforces a catalogued pixel floor before any call', () => {
  // 4.0 has no floor.
  assert.doesNotThrow(() =>
    validateImageRequest(ark, { model: 'doubao-seedream-4-0-250828', size: '1024x1024' }),
  );

  // 4.5 requires 3686400 pixels, so the small size must be refused.
  const failure = (() => {
    try {
      validateImageRequest(ark, { model: 'doubao-seedream-4-5-251128', size: '1024x1024' });
      return undefined;
    } catch (error) {
      return error;
    }
  })();
  assert.ok(failure instanceof Error, 'expected a rejection for a size below the floor');
  assert.match(failure.message, /requires at least 3686400 pixels/);
  assert.match(failure.message, /1920x1920/);

  assert.doesNotThrow(() =>
    validateImageRequest(ark, { model: 'doubao-seedream-4-5-251128', size: '2048x2048' }),
  );
});

test('validateImageRequest lets an unknown model through', () => {
  // The provider is the authority on ids newer than this catalogue.
  assert.doesNotThrow(() => validateImageRequest(ark, { model: 'brand-new-model', size: '512x512' }));
});

test('suggestedSize rounds up to a multiple of 64', () => {
  assert.equal(suggestedSize(3686400), '1920x1920');
  assert.equal(suggestedSize(1), '64x64');
});

test('expandHome resolves tilde and relative paths', () => {
  assert.equal(expandHome('~'), homedir());
  assert.equal(expandHome('~/pics'), join(homedir(), 'pics'));
  assert.equal(expandHome('/absolute/path'), '/absolute/path');
  assert.equal(expandHome('relative'), join(process.cwd(), 'relative'));
});

test('resolveOutputDir defaults into the workspace and honours an override', () => {
  assert.equal(
    resolveOutputDir({ configured: undefined, cwd: '/tmp/workspace' }),
    join('/tmp/workspace', 'image_output'),
  );
  assert.equal(
    resolveOutputDir({ configured: '', cwd: '/tmp/workspace' }),
    join('/tmp/workspace', 'image_output'),
  );
  assert.equal(
    resolveOutputDir({ configured: '/tmp/explicit', cwd: '/tmp/workspace' }),
    '/tmp/explicit',
  );
  assert.equal(
    resolveOutputDir({ configured: '~/Desktop/image_output', cwd: '/tmp/workspace' }),
    join(homedir(), 'Desktop', 'image_output'),
  );
});

test('buildImageFileName is deterministic and disambiguates multi-image requests', () => {
  const at = new Date(2026, 8, 24, 15, 30, 5);
  assert.equal(timestamp(at), '20260924-153005');
  assert.equal(buildImageFileName({ at, index: 1, extension: '.jpg' }), 'img-20260924-153005.jpg');
  assert.equal(buildImageFileName({ at, index: 2, extension: '.png' }), 'img-20260924-153005-2.png');
});

test('provider presets resolve and reject unknown ids', () => {
  assert.equal(resolveProvider('ark').id, 'ark');
  assert.equal(resolveProvider(undefined).id, 'ark');
  assert.equal(resolveProvider('').id, 'ark');
  assert.throws(() => resolveProvider('nope'), /unknown provider "nope"/);
});

test('resolveSettings falls back to provider defaults and keeps provenance', () => {
  const settings = resolveSettings({
    path: '/tmp/config.yml',
    exists: false,
    format: 'yaml',
    unknownKeys: [],
    cwd: '/tmp/workspace',
    values: { provider: undefined, apiKey: 'k', baseUrl: undefined, imageModel: undefined, imageSize: undefined, outputDir: undefined },
    sources: { provider: 'unset', apiKey: 'file', baseUrl: 'unset', imageModel: 'unset', imageSize: 'unset', outputDir: 'unset' },
  });

  assert.equal(settings.baseUrl, ark.baseUrl);
  assert.equal(settings.imageModel, ark.defaultImageModel);
  assert.equal(settings.imageSize, ark.defaultImageSize);
  assert.equal(settings.configPath, '/tmp/config.yml');
  // Timeouts fall back to the shipped defaults when the file says nothing.
  assert.equal(settings.imageTimeoutMs, 180_000);
  assert.equal(settings.videoTimeoutMs, 720_000);
  assert.equal(findImageModel(ark, settings.imageModel).label, 'Seedream 4.0');
});

test('writeUniqueFileSync keeps a free name and suffixes a taken one', () => {
  const taken = new Set(['/tmp/out/img-20261002-213428.jpg', '/tmp/out/img-20261002-213428-2.jpg']);
  const options = {
    exists: (path) => taken.has(path),
    write: (path, bytes, config) => {
      assert.deepEqual(config, { flag: 'wx' }, 'creation must be the arbiter, not a pre-check');
      if (taken.has(path)) {
        const error = new Error('EEXIST');
        error.code = 'EEXIST';
        throw error;
      }
    },
  };

  // A free path is used untouched, which keeps the documented shape.
  assert.equal(
    writeUniqueFileSync('/tmp/out/img-20261002-213429.jpg', Buffer.from('a'), options),
    '/tmp/out/img-20261002-213429.jpg',
  );
  // A taken path walks past both existing names rather than overwriting either.
  assert.equal(
    writeUniqueFileSync('/tmp/out/img-20261002-213428.jpg', Buffer.from('a'), options),
    '/tmp/out/img-20261002-213428-3.jpg',
  );
  // A name with no extension is a valid shape too.
  assert.equal(writeUniqueFileSync('/tmp/out/audio', Buffer.from('a'), options), '/tmp/out/audio');
});

test('writeUniqueFileSync survives a name created between the check and the write', () => {
  // The race: the predicate swears the name is free, then the create fails.
  // Re-asking would loop forever, so the suffix has to advance monotonically.
  const attempts = [];
  const path = writeUniqueFileSync('/tmp/out/b.mp3', Buffer.from('y'), {
    exists: () => false,
    write: (candidate) => {
      attempts.push(candidate);
      if (attempts.length === 1) {
        const error = new Error('EEXIST');
        error.code = 'EEXIST';
        throw error;
      }
    },
  });

  assert.equal(path, '/tmp/out/b-2.mp3');
  assert.deepEqual(attempts, ['/tmp/out/b.mp3', '/tmp/out/b-2.mp3']);
});
