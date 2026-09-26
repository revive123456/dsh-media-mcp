import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { generateImage } from '../src/generate.mjs';
import { PROVIDERS } from '../src/providers.mjs';

const ark = PROVIDERS.ark;

/** Settings pointing at a throwaway output directory. */
function makeSettings(overrides = {}) {
  return {
    provider: ark,
    apiKey: 'test-key',
    baseUrl: ark.baseUrl,
    imageModel: ark.defaultImageModel,
    imageSize: '1024x1024',
    outputDir: undefined,
    configPath: '/tmp/media-gen-test/config.yml',
    cwd: mkdtempSync(join(tmpdir(), 'media-gen-generate-')),
    ...overrides,
  };
}

/** A fetch stub that answers the API POST and the image download separately. */
function stubFetch({ body, status = 200, bytes = Buffer.from('jpeg-bytes'), contentType = 'image/jpeg' } = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === 'POST') {
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(body),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => contentType },
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  impl.calls = calls;
  return impl;
}

test('generateImage posts the expected request and writes the downloaded bytes', async () => {
  const bytes = Buffer.from('jpeg-bytes');
  const fetchImpl = stubFetch({ body: { data: [{ url: 'https://cdn.test/a.jpg' }] }, bytes });

  const result = await generateImage(
    makeSettings(),
    { prompt: 'a corgi surfing at sunset' },
    { fetchImpl, now: () => new Date(2026, 8, 24, 10, 0, 0) },
  );

  assert.equal(result.model, 'doubao-seedream-4-0-250828');
  assert.equal(result.size, '1024x1024');
  assert.equal(result.files.length, 1);
  assert.equal(basename(result.files[0].path), 'img-20260924-100000.jpg');
  assert.equal(result.files[0].bytes, bytes.length);
  assert.deepEqual(readFileSync(result.files[0].path), bytes);

  const post = fetchImpl.calls[0];
  assert.equal(post.url, 'https://ark.cn-beijing.volces.com/api/v3/images/generations');
  assert.equal(post.options.headers.authorization, 'Bearer test-key');
  const sent = JSON.parse(post.options.body);
  assert.deepEqual(sent, {
    model: 'doubao-seedream-4-0-250828',
    prompt: 'a corgi surfing at sunset',
    size: '1024x1024',
    response_format: 'url',
    watermark: false,
  });
});

test('generateImage disambiguates multi-image responses', async () => {
  const fetchImpl = stubFetch({
    body: { data: [{ url: 'https://cdn.test/a.png' }, { url: 'https://cdn.test/b.png' }] },
    contentType: 'image/png',
  });

  const result = await generateImage(
    makeSettings(),
    { prompt: 'two cats' },
    { fetchImpl, now: () => new Date(2026, 8, 24, 10, 0, 0) },
  );

  assert.deepEqual(result.files.map((file) => basename(file.path)), [
    'img-20260924-100000.png',
    'img-20260924-100000-2.png',
  ]);
});

test('generateImage accepts inline base64 payloads', async () => {
  const fetchImpl = stubFetch({
    body: { data: [{ b64_json: Buffer.from('png-bytes').toString('base64') }] },
  });

  const result = await generateImage(makeSettings(), { prompt: 'a logo' }, { fetchImpl });

  assert.equal(basename(result.files[0].path).endsWith('.png'), true);
  // Exactly one call: an inline payload needs no download leg.
  assert.equal(fetchImpl.calls.length, 1);
});

test('generateImage honours a per-call model, size and output directory', async () => {
  const fetchImpl = stubFetch({ body: { data: [{ url: 'https://cdn.test/a.jpg' }] } });
  const settings = makeSettings();
  const outputDir = join(settings.cwd, 'elsewhere');

  const result = await generateImage(
    settings,
    { prompt: 'a big render', model: 'doubao-seedream-5-0-flash-260915', size: '2048x2048', outputDir },
    { fetchImpl },
  );

  const sent = JSON.parse(fetchImpl.calls[0].options.body);
  assert.equal(sent.model, 'doubao-seedream-5-0-flash-260915');
  assert.equal(sent.size, '2048x2048');
  assert.equal(result.directory, outputDir);
  assert.equal(readdirSync(outputDir).length, 1);
});

test('generateImage surfaces the provider error without writing files', async () => {
  const settings = makeSettings();
  const fetchImpl = stubFetch({
    status: 400,
    body: { error: { code: 'InvalidParameter', message: 'size too small' } },
  });

  await assert.rejects(
    () => generateImage(settings, { prompt: 'a cat' }, { fetchImpl }),
    (error) => {
      // Both the provider's code and the HTTP status must survive, because the
      // status is what distinguishes a bad request from a permissions problem.
      assert.match(error.message, /media API error \[InvalidParameter\] HTTP 400: size too small/);
      return true;
    },
  );
  assert.deepEqual(readdirSync(settings.cwd), []);
});

test('generateImage fails before the network when a size is below the floor', async () => {
  const fetchImpl = stubFetch({ body: { data: [] } });

  await assert.rejects(
    () =>
      generateImage(
        makeSettings(),
        { prompt: 'a cat', model: 'doubao-seedream-4-5-251128', size: '1024x1024' },
        { fetchImpl },
      ),
    /requires at least 3686400 pixels/,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('generateImage fails before the network when no key is configured', async () => {
  const fetchImpl = stubFetch({ body: { data: [] } });

  await assert.rejects(
    () => generateImage(makeSettings({ apiKey: undefined }), { prompt: 'a cat' }, { fetchImpl }),
    /no API key configured/,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('generateImage takes its timeout from config, a call, or neither', async () => {
  const configured = stubFetch({ body: { data: [{ url: 'https://cdn.test/a.jpg' }] } });
  await generateImage(makeSettings({ imageTimeoutMs: 30_000 }), { prompt: 'a cat' }, { fetchImpl: configured });
  assert.equal(configured.calls.length, 2);

  const perCall = stubFetch({ body: { data: [{ url: 'https://cdn.test/a.jpg' }] } });
  await generateImage(makeSettings(), { prompt: 'a cat', timeoutMs: 45_000 }, { fetchImpl: perCall });
  assert.equal(perCall.calls.length, 2);

  // A malformed timeout is refused before the network, like every other input
  // that decides whether money is spent.
  const noCalls = stubFetch();
  await assert.rejects(
    () => generateImage(makeSettings({ imageTimeoutMs: 0 }), { prompt: 'a cat' }, { fetchImpl: noCalls }),
    /must be a positive whole number of milliseconds/,
  );
  await assert.rejects(
    () => generateImage(makeSettings(), { prompt: 'a cat', timeoutMs: 'soon' }, { fetchImpl: noCalls }),
    /timeoutMs must be a positive whole number/,
  );
  await assert.rejects(
    () => generateImage(makeSettings(), { prompt: 'a cat', timeoutMs: 3_600_001 }, { fetchImpl: noCalls }),
    /must be at most 3600000 ms/,
  );
  assert.equal(noCalls.calls.length, 0);
});

test('generateImage requires a prompt', async () => {
  await assert.rejects(
    () => generateImage(makeSettings(), { prompt: '   ' }, { fetchImpl: stubFetch() }),
    /missing required argument "prompt"/,
  );
});
