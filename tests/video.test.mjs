import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { PROVIDERS } from '../src/providers.mjs';
import {
  buildVideoRequest,
  extractTaskId,
  extractVideoUrl,
  generateVideo,
  parseDurationSeconds,
  parseRatio,
  taskStatus,
} from '../src/video.mjs';

const ark = PROVIDERS.ark;
const TASK_ID = 'cgt-test-1';

/** Settings pointing at a throwaway output directory. */
function makeSettings(overrides = {}) {
  return {
    provider: ark,
    apiKey: 'test-key',
    baseUrl: ark.baseUrl,
    imageModel: ark.defaultImageModel,
    imageSize: '1024x1024',
    videoModel: ark.defaultVideoModel,
    outputDir: undefined,
    configPath: '/tmp/media-gen-test/config.yml',
    cwd: mkdtempSync(join(tmpdir(), 'media-gen-video-')),
    ...overrides,
  };
}

/** A JSON response stub. */
function json(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

/**
 * Stub the whole flow: one create, a scripted run of poll statuses, one download.
 *
 * `statuses` is consumed in order; the last entry repeats, which is what lets a
 * test pin "still running, then finished".
 */
function stubFetch({
  statuses = ['queued', 'succeeded'],
  createBody,
  createStatus = 200,
  pollBody,
  pollStatus = 200,
  downloadStatus = 200,
  bytes = Buffer.from('mp4-bytes'),
} = {}) {
  const calls = [];
  let polls = 0;

  const impl = async (url, options = {}) => {
    calls.push({ url, options });

    if (options.method === 'POST') {
      return json(createStatus, createBody ?? { id: TASK_ID, status: 'queued' });
    }
    if (String(url).includes(`/contents/generations/tasks/${TASK_ID}`)) {
      const status = statuses[Math.min(polls, statuses.length - 1)];
      polls += 1;
      if (pollStatus >= 400 || pollBody !== undefined) {
        return json(pollStatus, pollBody ?? {});
      }
      return json(200, status === 'succeeded'
        ? {
          id: TASK_ID,
          status,
          content: { video_url: 'https://cdn.test/out.mp4' },
          usage: { completion_tokens: 108000 },
        }
        : { id: TASK_ID, status });
    }

    return {
      ok: downloadStatus >= 200 && downloadStatus < 300,
      status: downloadStatus,
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };

  impl.calls = calls;
  return impl;
}

/** No test may wait on a real clock. */
const noSleep = async () => {};

test('parseRatio and parseDurationSeconds reject anything malformed', () => {
  assert.equal(parseRatio('16:9'), '16:9');
  assert.equal(parseRatio(' 9:16 '), '9:16');
  assert.throws(() => parseRatio('16x9'), /ratio must look like W:H/);

  assert.equal(parseDurationSeconds(5), 5);
  // The MCP schema and the CLI both hand this over as a string.
  assert.equal(parseDurationSeconds('10'), 10);
  assert.throws(() => parseDurationSeconds('0'), /positive whole number/);
  assert.throws(() => parseDurationSeconds('2.5'), /positive whole number/);
  assert.throws(() => parseDurationSeconds('five'), /positive whole number/);
});

test('buildVideoRequest follows the provider convention for ratio and duration', () => {
  const prompt = ark.videoParamStyle === 'prompt'
    ? buildVideoRequest(ark, { model: 'm', prompt: 'a boat', ratio: '16:9', duration: 5 })
    : undefined;

  // The preset for Ark embeds the flags, so the request body carries one text part.
  assert.deepEqual(prompt, {
    model: 'm',
    content: [{ type: 'text', text: 'a boat --ratio 16:9 --duration 5' }],
  });

  const fields = buildVideoRequest(
    { videoParamStyle: 'fields' },
    { model: 'm', prompt: 'a boat', ratio: '9:16', duration: 10 },
  );
  assert.deepEqual(fields, {
    model: 'm',
    content: [{ type: 'text', text: 'a boat' }],
    ratio: '9:16',
    duration: 10,
  });
});

test('extractTaskId and extractVideoUrl accept the documented spellings', () => {
  assert.equal(extractTaskId({ id: 'a' }), 'a');
  assert.equal(extractTaskId({ task_id: 'b' }), 'b');
  assert.equal(extractTaskId({}), undefined);

  assert.equal(extractVideoUrl({ content: { video_url: 'u' } }), 'u');
  assert.equal(extractVideoUrl({ data: [{ url: 'v' }] }), 'v');
  assert.equal(extractVideoUrl({}), undefined);
  assert.equal(taskStatus({ status: 'Succeeded' }), 'succeeded');
});

test('generateVideo creates a task, polls it, downloads the file and reports the wait', async () => {
  const bytes = Buffer.from('mp4-bytes');
  const fetchImpl = stubFetch({ statuses: ['queued', 'running', 'succeeded'], bytes });

  const result = await generateVideo(
    makeSettings(),
    { prompt: 'a paper boat drifting down a rainy street' },
    { fetchImpl, sleep: noSleep, now: () => new Date(2026, 8, 25, 10, 30, 0) },
  );

  // Create call: the documented endpoint, the key, and the prompt with defaults.
  const create = fetchImpl.calls[0];
  assert.equal(create.url, 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');
  assert.equal(create.options.headers.authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(create.options.body), {
    model: 'doubao-seedance-2-5-260628',
    content: [{ type: 'text', text: 'a paper boat drifting down a rainy street --ratio 16:9 --duration 5' }],
  });

  // Poll calls address the task by id.
  const polls = fetchImpl.calls.filter((call) => call.options.method !== 'POST');
  assert.equal(polls[0].url, `https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/${TASK_ID}`);

  assert.equal(result.taskId, TASK_ID);
  assert.equal(result.model, 'doubao-seedance-2-5-260628');
  assert.equal(result.ratio, '16:9');
  assert.equal(result.duration, 5);
  assert.deepEqual(result.usage, { completion_tokens: 108000 });
  assert.equal(result.files.length, 1);
  assert.equal(basename(result.files[0].path), 'vid-20260925-103000.mp4');
  assert.deepEqual(readFileSync(result.files[0].path), bytes);
  // Default output directory for video is the workspace's video_output.
  assert.equal(result.directory.endsWith('video_output'), true);
});

test('generateVideo honours per-call model, ratio, duration and output directory', async () => {
  const fetchImpl = stubFetch();
  const settings = makeSettings();
  const outputDir = join(settings.cwd, 'elsewhere');

  const result = await generateVideo(
    settings,
    {
      prompt: 'a drone shot over a canyon',
      model: 'doubao-seedance-1-0-pro-250528',
      ratio: '9:16',
      duration: 10,
      outputDir,
    },
    { fetchImpl, sleep: noSleep },
  );

  const sent = JSON.parse(fetchImpl.calls[0].options.body);
  assert.equal(sent.model, 'doubao-seedance-1-0-pro-250528');
  assert.match(sent.content[0].text, /--ratio 9:16 --duration 10$/);
  assert.equal(result.directory, outputDir);
  assert.equal(readdirSync(outputDir).length, 1);
});

test('generateVideo surfaces a provider error from task creation', async () => {
  const fetchImpl = stubFetch({
    createStatus: 403,
    createBody: { error: { code: 'SetLimitExceeded', message: 'safe experience mode' } },
  });

  await assert.rejects(
    () => generateVideo(makeSettings(), { prompt: 'a cat' }, { fetchImpl, sleep: noSleep }),
    /media API error \[SetLimitExceeded\] HTTP 403: safe experience mode/,
  );
});

test('generateVideo reports a failed task with its id and writes nothing', async () => {
  const settings = makeSettings();
  const fetchImpl = stubFetch({
    statuses: ['running', 'failed'],
    pollBody: { id: TASK_ID, status: 'failed', error: { message: 'prompt rejected' } },
  });

  await assert.rejects(
    () => generateVideo(settings, { prompt: 'a cat' }, { fetchImpl, sleep: noSleep }),
    new RegExp(`video task ${TASK_ID} failed`),
  );
  assert.equal(readdirSync(settings.cwd).length, 0);
});

test('generateVideo fails closed on a status it does not know', async () => {
  const fetchImpl = stubFetch({ pollBody: { id: TASK_ID, status: 'waiting_for_gpu' } });

  await assert.rejects(
    () => generateVideo(makeSettings(), { prompt: 'a cat' }, { fetchImpl, sleep: noSleep }),
    /does not know: "waiting_for_gpu"/,
  );
});

test('generateVideo reports a task with no status instead of polling forever', async () => {
  const fetchImpl = stubFetch({ pollBody: { id: TASK_ID } });

  await assert.rejects(
    () => generateVideo(makeSettings(), { prompt: 'a cat' }, { fetchImpl, sleep: noSleep }),
    /reported a status this version does not know: \(none\)/,
  );
});

test('generateVideo times out by id instead of paying for a second render', async () => {
  const fetchImpl = stubFetch({ statuses: ['running'] });

  await assert.rejects(
    () =>
      generateVideo(
        makeSettings(),
        { prompt: 'a cat' },
        { fetchImpl, sleep: noSleep, timeoutMs: 0 },
      ),
    new RegExp(`video task ${TASK_ID} did not finish within 0s`),
  );
}, { timeout: 5000 });

test('a configured video timeout drives the deadline', async () => {
  const fetchImpl = stubFetch({ statuses: ['running'] });

  // One millisecond of budget: the first poll is already past the deadline.
  await assert.rejects(
    () => generateVideo(makeSettings({ videoTimeoutMs: 1 }), { prompt: 'a cat' }, { fetchImpl, sleep: noSleep }),
    new RegExp(`video task ${TASK_ID} did not finish within 0s`),
  );
}, { timeout: 5000 });

test('a per-call timeout overrides the configured video budget', async () => {
  const fetchImpl = stubFetch({ statuses: ['running'] });

  await assert.rejects(
    () =>
      generateVideo(
        makeSettings({ videoTimeoutMs: 720_000 }),
        { prompt: 'a cat', timeoutMs: 1 },
        { fetchImpl, sleep: noSleep },
      ),
    new RegExp(`video task ${TASK_ID} did not finish within 0s`),
  );
}, { timeout: 5000 });

test('generateVideo refuses a malformed timeout before the network', async () => {
  const fetchImpl = stubFetch();

  await assert.rejects(
    () => generateVideo(makeSettings(), { prompt: 'a cat', timeoutMs: 0 }, { fetchImpl }),
    /timeoutMs must be a positive whole number/,
  );
  await assert.rejects(
    () => generateVideo(makeSettings(), { prompt: 'a cat', timeoutMs: 'soon' }, { fetchImpl }),
    /timeoutMs must be a positive whole number/,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('generateVideo refuses a success with no video URL', async () => {
  const fetchImpl = stubFetch({ pollBody: { id: TASK_ID, status: 'succeeded', content: {} } });

  await assert.rejects(
    () => generateVideo(makeSettings(), { prompt: 'a cat' }, { fetchImpl, sleep: noSleep }),
    /succeeded but returned no video URL/,
  );
});

test('generateVideo fails before the network when no key is configured', async () => {
  const fetchImpl = stubFetch();

  await assert.rejects(
    () => generateVideo(makeSettings({ apiKey: undefined }), { prompt: 'a cat' }, { fetchImpl }),
    /no API key configured/,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('generateVideo validates before the network, because a task costs money', async () => {
  const fetchImpl = stubFetch();

  await assert.rejects(
    () => generateVideo(makeSettings(), { prompt: 'a cat', duration: 0 }, { fetchImpl }),
    /duration must be a positive whole number/,
  );
  await assert.rejects(
    () => generateVideo(makeSettings(), { prompt: '   ' }, { fetchImpl }),
    /missing required argument "prompt"/,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('a rejected download leaves no partial file behind', async () => {
  const settings = makeSettings();
  const fetchImpl = stubFetch({ downloadStatus: 500 });

  await assert.rejects(
    () => generateVideo(settings, { prompt: 'a cat' }, { fetchImpl, sleep: noSleep }),
    /failed to download the generated video: HTTP 500/,
  );
  // The directory is created only once bytes are in hand, so a failed download
  // leaves neither a partial file nor an empty folder.
  assert.equal(existsSync(join(settings.cwd, 'video_output')), false);
});
