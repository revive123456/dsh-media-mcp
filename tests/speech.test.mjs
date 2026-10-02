import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { PROVIDERS } from '../src/providers.mjs';
import {
  buildSpeechRequest,
  extractSpeechAudio,
  generateSpeech,
  parseSampleRate,
  parseSpeechFormat,
  parseSpeechFrames,
} from '../src/speech.mjs';

const ark = PROVIDERS.ark;
const ENDPOINT = `${ark.speechBaseUrl}${ark.speechPath}`;

/** Settings pointing at a throwaway output directory. */
function makeSettings(overrides = {}) {
  return {
    provider: ark,
    apiKey: 'test-key',
    speechApiKey: 'test-key',
    baseUrl: ark.baseUrl,
    speechModel: ark.defaultSpeechModel,
    speechVoice: ark.defaultSpeechVoice,
    speechFormat: ark.defaultSpeechFormat,
    speechSampleRate: ark.defaultSpeechSampleRate,
    speechTimeoutMs: undefined,
    outputDir: undefined,
    configPath: '/tmp/media-gen-test/config.yml',
    cwd: mkdtempSync(join(tmpdir(), 'media-gen-speech-')),
    ...overrides,
  };
}

/** Wrap frames the way the documented SSE transport does. */
function sse(frames) {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}`).join('\n\n');
}

/** A stub response carrying a raw text body. */
function textResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

/** Stub the whole flow: one request, one scripted answer. */
function stubFetch({ status = 200, body = sse([
  { code: 0, data: Buffer.from('first-chunk').toString('base64') },
  { code: 0, data: Buffer.from('second-chunk').toString('base64') },
  { code: 20000000, message: 'ok' },
]) } = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    return textResponse(status, body);
  };
  impl.calls = calls;
  return impl;
}

test('parseSpeechFormat and parseSampleRate reject anything malformed', () => {
  assert.equal(parseSpeechFormat('mp3', ark), 'mp3');
  assert.equal(parseSpeechFormat(' OGG_OPUS ', ark), 'ogg_opus');
  assert.throws(() => parseSpeechFormat('wav', ark), /format must be one of mp3, pcm, ogg_opus/);
  assert.throws(() => parseSpeechFormat(undefined, ark), /format must be one of/);

  assert.equal(parseSampleRate(24_000), 24_000);
  // The config file and the CLI both hand this over as a string.
  assert.equal(parseSampleRate('16000'), 16_000);
  assert.throws(() => parseSampleRate('0'), /positive whole number of Hz/);
  assert.throws(() => parseSampleRate('22k'), /positive whole number of Hz/);
});

test('buildSpeechRequest follows the v3 contract, and the model stays out of the body', () => {
  const mp3 = buildSpeechRequest(ark, {
    text: '你好',
    voice: ark.defaultSpeechVoice,
    format: 'mp3',
    sampleRate: 24_000,
  });

  assert.deepEqual(mp3, {
    user: { uid: 'media-gen' },
    req_params: {
      text: '你好',
      speaker: ark.defaultSpeechVoice,
      sample_rate: 24_000,
      audio_params: { format: 'mp3', bit_rate: 64_000 },
    },
  });
  // The resource id is a header, so it must not leak into the payload.
  assert.equal(JSON.stringify(mp3).includes(ark.defaultSpeechModel), false);

  // Uncompressed pcm has no bit rate to negotiate.
  const pcm = buildSpeechRequest(ark, { text: 'hi', voice: 'v', format: 'pcm', sampleRate: 16_000 });
  assert.deepEqual(pcm.req_params.audio_params, { format: 'pcm' });
});

test('parseSpeechFrames accepts SSE lines, a whole-body object and transport noise', () => {
  assert.deepEqual(parseSpeechFrames(''), []);
  assert.deepEqual(parseSpeechFrames(sse([{ code: 0, data: 'a' }, { code: 20000000 }])), [
    { code: 0, data: 'a' },
    { code: 20000000 },
  ]);
  // A plain JSON body is one frame, not zero.
  assert.deepEqual(parseSpeechFrames('{"code":0,"data":"a"}'), [{ code: 0, data: 'a' }]);
  // `[DONE]` and unparsable lines are skipped rather than surfacing as bad frames.
  assert.deepEqual(parseSpeechFrames('data: [DONE]\n\ndata: {"code":0,"data":"a"}\n\noops'), [
    { code: 0, data: 'a' },
  ]);
});

test('extractSpeechAudio concatenates chunks and fails closed on an unknown code', () => {
  const audio = extractSpeechAudio([
    { code: 0, data: Buffer.from('one').toString('base64') },
    { code: 20000000 },
    { code: 0, data: Buffer.from('two').toString('base64') },
  ]);
  assert.deepEqual(audio, Buffer.from('onetwo'));

  // An unrecognized code is reported with the provider's own words instead of
  // being skipped, which would look like "the model returned no audio".
  assert.throws(
    () => extractSpeechAudio([{ code: 45_000_001, message: 'voice not activated' }]),
    /speech API error \[45000001\]: voice not activated/,
  );
  // The header-nested spelling is understood too.
  assert.throws(
    () => extractSpeechAudio([{ header: { code: 1, message: 'bad speaker' } }]),
    /speech API error \[1\]: bad speaker/,
  );
});

test('generateSpeech posts the documented request and writes the decoded audio', async () => {
  const fetchImpl = stubFetch();
  const result = await generateSpeech(
    makeSettings(),
    { text: '这是一段语音合成测试。' },
    { fetchImpl, now: () => new Date(2026, 9, 1, 19, 52, 0) },
  );

  const call = fetchImpl.calls[0];
  assert.equal(call.url, ENDPOINT);
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers['x-api-key'], 'test-key');
  assert.equal(call.options.headers['x-api-resource-id'], ark.defaultSpeechModel);
  // A per-request id is what makes a support question answerable.
  assert.match(call.options.headers['x-api-request-id'], /^[0-9a-f-]{36}$/);

  assert.deepEqual(JSON.parse(call.options.body), {
    user: { uid: 'media-gen' },
    req_params: {
      text: '这是一段语音合成测试。',
      speaker: ark.defaultSpeechVoice,
      sample_rate: 24_000,
      audio_params: { format: 'mp3', bit_rate: 64_000 },
    },
  });

  assert.equal(result.model, ark.defaultSpeechModel);
  assert.equal(result.voice, ark.defaultSpeechVoice);
  assert.equal(result.format, 'mp3');
  assert.equal(result.characters, '这是一段语音合成测试。'.length);
  assert.equal(result.files.length, 1);
  assert.equal(basename(result.files[0].path), 'speech-20261001-195200.mp3');
  assert.deepEqual(readFileSync(result.files[0].path), Buffer.from('first-chunksecond-chunk'));
  // Speech lands in the workspace's speech_output by default, like the other two.
  assert.equal(result.directory.endsWith('speech_output'), true);
});

test('generateSpeech honours per-call model, voice, format and output directory', async () => {
  const fetchImpl = stubFetch();
  const settings = makeSettings();
  const outputDir = join(settings.cwd, 'elsewhere');

  const result = await generateSpeech(
    settings,
    { text: 'hello', model: 'seed-tts-1.0', voice: 'en_female_anna_mars_bigtts', format: 'ogg_opus', outputDir },
    { fetchImpl },
  );

  const sent = JSON.parse(fetchImpl.calls[0].options.body);
  assert.equal(sent.req_params.speaker, 'en_female_anna_mars_bigtts');
  assert.deepEqual(sent.req_params.audio_params, { format: 'ogg_opus', bit_rate: 64_000 });
  assert.equal(fetchImpl.calls[0].options.headers['x-api-resource-id'], 'seed-tts-1.0');
  assert.equal(result.directory, outputDir);
  assert.equal(result.files[0].path.endsWith('.ogg'), true);
  assert.equal(readdirSync(outputDir).length, 1);
});

test('generateSpeech surfaces an HTTP error with the provider message', async () => {
  const fetchImpl = stubFetch({
    status: 403,
    body: sse([{ code: 45_000_003, message: 'requested resource not granted' }]),
  });

  await assert.rejects(
    () => generateSpeech(makeSettings(), { text: 'hello' }, { fetchImpl }),
    /media API error \[45000003\] HTTP 403: requested resource not granted/,
  );
});

test('generateSpeech reports a business error code carried on a 200 response', async () => {
  const fetchImpl = stubFetch({ body: sse([{ code: 40_000_000, message: 'invalid speaker' }]) });

  await assert.rejects(
    () => generateSpeech(makeSettings(), { text: 'hello' }, { fetchImpl }),
    /speech API error \[40000000\]: invalid speaker/,
  );
});

test('a successful response with no audio fails loudly and writes nothing', async () => {
  const settings = makeSettings();
  const fetchImpl = stubFetch({ body: sse([{ code: 20000000, message: 'ok' }]) });

  await assert.rejects(
    () => generateSpeech(settings, { text: 'hello' }, { fetchImpl }),
    /returned no audio data \(model .* voice .* format mp3\)/,
  );
  // The directory is created only once bytes are in hand.
  assert.equal(existsSync(join(settings.cwd, 'speech_output')), false);
});

test('generateSpeech fails before the network when no key is configured', async () => {
  const fetchImpl = stubFetch();

  await assert.rejects(
    () => generateSpeech(makeSettings({ speechApiKey: undefined, apiKey: undefined }), { text: 'hi' }, { fetchImpl }),
    /no API key configured/,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('generateSpeech validates before the network, because a call costs money', async () => {
  const fetchImpl = stubFetch();

  await assert.rejects(
    () => generateSpeech(makeSettings(), { text: '   ' }, { fetchImpl }),
    /missing required argument "text"/,
  );
  await assert.rejects(
    () => generateSpeech(makeSettings(), { text: 'hi', format: 'wav' }, { fetchImpl }),
    /format must be one of/,
  );
  await assert.rejects(
    () => generateSpeech(makeSettings(), { text: 'hi', timeoutMs: 0 }, { fetchImpl }),
    /timeoutMs must be a positive whole number/,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('generateSpeech accepts a configured budget and refuses an impossible one', async () => {
  const fetchImpl = stubFetch();

  // A configured budget is the one a real call uses; it is accepted silently.
  const result = await generateSpeech(
    makeSettings({ speechTimeoutMs: 90_000 }),
    { text: 'hi' },
    { fetchImpl },
  );
  assert.equal(result.files.length, 1);

  // A budget above the one-hour ceiling is refused before the request, not
  // clamped: quietly shortening a deliberate value hides the mistake.
  await assert.rejects(
    () => generateSpeech(makeSettings({ speechTimeoutMs: 9_999_999 }), { text: 'hi' }, { fetchImpl }),
    /timeoutMs must be at most 3600000 ms/,
  );
});

test('two calls in the same second do not overwrite each other', async () => {
  // Regression: the file name has one-second resolution, so a frozen clock is
  // exactly the situation two quick calls produce. Before the suffix rule the
  // second call destroyed the first file, silently.
  const settings = makeSettings();
  const frozen = () => new Date(2026, 9, 2, 21, 34, 28);
  const audioFor = (label) => sse([
    { code: 0, data: Buffer.from(label).toString('base64') },
    { code: 20000000 },
  ]);

  const first = await generateSpeech(
    settings,
    { text: 'first' },
    { fetchImpl: stubFetch({ body: audioFor('audio-first') }), now: frozen },
  );
  const second = await generateSpeech(
    settings,
    { text: 'second' },
    { fetchImpl: stubFetch({ body: audioFor('audio-second') }), now: frozen },
  );

  assert.notEqual(first.files[0].path, second.files[0].path);
  assert.equal(basename(first.files[0].path), 'speech-20261002-213428.mp3');
  assert.equal(basename(second.files[0].path), 'speech-20261002-213428-2.mp3');
  // Both files are still on disk, each with its own audio.
  assert.deepEqual(readFileSync(first.files[0].path), Buffer.from('audio-first'));
  assert.deepEqual(readFileSync(second.files[0].path), Buffer.from('audio-second'));
  assert.equal(readdirSync(join(settings.cwd, 'speech_output')).length, 2);
});
