/**
 * Video generation: create an asynchronous task, poll it, download the result.
 *
 * Video differs from images in three ways that shape this module:
 *
 * - the provider answers with a task id, not a picture, so every call polls;
 * - a render takes minutes, so the wait is bounded by an explicit deadline and
 *   every failure names the task id, which is the only handle for a follow-up;
 * - a stray call costs real money, so the whole request is validated locally
 *   before the first network call.
 *
 * `fetch` and `sleep` are injectable, so the polling loop is testable without a
 * network and without waiting on a clock.
 *
 * @module video
 */

import { join } from 'node:path';
import { DEFAULT_VIDEO_TIMEOUT_MS, KEY_SPEC, parseTimeoutMs } from './config.mjs';
import { apiError, joinUrl, readJson, requireText, truncate } from './generate.mjs';
import {
  buildVideoFileName,
  ensureDir,
  resolveOutputDir,
  writeUniqueFileSync,
} from './images.mjs';
import { findVideoModel } from './providers.mjs';

/** How long to wait between two task polls. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

const RATIO_PATTERN = /^\d{1,2}:\d{1,2}$/;

/** Task states that mean "keep waiting". */
const PENDING_STATUSES = new Set(['queued', 'pending', 'running', 'processing', 'in_progress']);

/** Task states that mean "the render finished". */
const SUCCEEDED_STATUSES = new Set(['succeeded', 'success', 'completed']);

/** Task states that mean "the render will never finish". */
const FAILED_STATUSES = new Set(['failed', 'canceled', 'cancelled', 'expired']);

/** Wait without pulling a timer dependency into the module. */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse an aspect ratio such as `16:9`, rejecting anything else. */
export function parseRatio(value) {
  const ratio = String(value ?? '').trim();
  if (!RATIO_PATTERN.test(ratio)) {
    throw new Error(`ratio must look like W:H, e.g. 16:9 (received "${value}")`);
  }
  return ratio;
}

/** Parse a whole number of seconds, rejecting anything else. */
export function parseDurationSeconds(value) {
  const seconds = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(`duration must be a positive whole number of seconds (received "${value}")`);
  }
  return seconds;
}

/**
 * Compose the create-task body.
 *
 * `provider.videoParamStyle` decides how ratio and duration travel: `prompt`
 * appends the provider's `--flag` convention to the prompt text, `fields` sends
 * them as top-level request fields. Keeping this in the preset is what stops a
 * vendor convention from leaking into the flow.
 */
export function buildVideoRequest(provider, { model, prompt, ratio, duration }) {
  const style = provider.videoParamStyle ?? 'prompt';
  const text =
    style === 'fields' ? prompt : `${prompt} --ratio ${ratio} --duration ${duration}`;
  const body = { model, content: [{ type: 'text', text }] };
  if (style === 'fields') {
    body.ratio = ratio;
    body.duration = duration;
  }
  return body;
}

/** Pull the task id out of a create-task response. */
export function extractTaskId(payload) {
  for (const candidate of [payload?.id, payload?.task_id, payload?.data?.id]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return undefined;
}

/**
 * Pull the finished video URL out of a task response.
 *
 * Ark returns `content.video_url`; the `data[].url` spelling is accepted too,
 * because the OpenAI-style convention is what a second provider tends to speak.
 */
export function extractVideoUrl(payload) {
  for (const candidate of [payload?.content?.video_url, payload?.video_url, payload?.output?.url]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  const list = Array.isArray(payload?.data) ? payload.data : [];
  for (const entry of list) {
    if (typeof entry?.url === 'string' && entry.url !== '') return entry.url;
  }
  return undefined;
}

/** Normalize a task status to lower case, if the response carries one. */
export function taskStatus(payload) {
  const status = payload?.status;
  return typeof status === 'string' ? status.trim().toLowerCase() : undefined;
}

/** Classify one poll response. */
function classify(status) {
  if (SUCCEEDED_STATUSES.has(status)) return 'succeeded';
  if (FAILED_STATUSES.has(status)) return 'failed';
  if (PENDING_STATUSES.has(status)) return 'pending';
  return 'unknown';
}

/** Read live task state until it reaches a terminal status or the deadline passes. */
async function awaitTask(taskUrl, { fetchImpl, apiKey, taskId, timeoutMs, pollIntervalMs, sleep }) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const response = await fetchImpl(taskUrl, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await readJson(response);
    if (!response.ok) throw apiError(response.status, payload);

    const status = taskStatus(payload);
    const kind = classify(status);

    if (kind === 'succeeded') return payload;
    if (kind === 'failed') {
      throw new Error(`video task ${taskId} ${status}: ${truncate(payload?.error ?? payload)}`);
    }
    if (kind === 'unknown') {
      // An unrecognized state is not a reason to keep polling forever: a task
      // whose state this version cannot interpret must be reported, not looped on.
      throw new Error(
        `video task ${taskId} reported a status this version does not know: ` +
          `${status === undefined ? '(none)' : `"${status}"`}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `video task ${taskId} did not finish within ${Math.round(timeoutMs / 1000)}s; ` +
          `query it later by id instead of paying for a second render`,
      );
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * Generate one video and write it to disk.
 *
 * @param settings - the object returned by `resolveSettings`.
 * @param request - `{ prompt, model?, ratio?, duration?, outputDir?, timeoutMs? }`.
 * @param options.fetchImpl - HTTP implementation; injectable for tests.
 * @param options.now - clock; injectable so file names are deterministic.
 * @param options.sleep - wait implementation; injectable so tests do not wait.
 * @throws when the prompt is missing, ratio, duration or timeout is malformed, or
 *   no key is configured — all before any network call, because a task costs
 *   money.
 */
export async function generateVideo(
  settings,
  request,
  {
    fetchImpl = fetch,
    now = () => new Date(),
    timeoutMs,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    sleep = defaultSleep,
  } = {},
) {
  const { provider } = settings;
  const startedAt = Date.now();

  const prompt = requireText(request?.prompt, 'prompt');
  const model = (request?.model ?? settings.videoModel).trim();
  const ratio = parseRatio(request?.ratio ?? provider.defaultVideoRatio);
  const duration = parseDurationSeconds(request?.duration ?? provider.defaultVideoDuration);

  // An injected option wins (tests), then the per-call argument, then the
  // configured default. A whole video flow needs a far larger budget than one
  // image request, which is why the two are configured separately.
  const budget = timeoutMs ?? parseTimeoutMs(
    request?.timeoutMs ?? settings.videoTimeoutMs ?? DEFAULT_VIDEO_TIMEOUT_MS,
    'timeoutMs',
  );

  const apiKey = typeof settings.apiKey === 'string' ? settings.apiKey.trim() : '';
  if (apiKey === '') {
    throw new Error(
      `no API key configured: set ${KEY_SPEC.apiKey.env} in ${settings.configPath} ` +
        `or export it in the environment`,
    );
  }

  const body = buildVideoRequest(provider, { model, prompt, ratio, duration });
  const base = joinUrl(settings.baseUrl, provider.videoPath);

  const created = await fetchImpl(base, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(budget),
  });
  const createdPayload = await readJson(created);
  if (!created.ok) throw apiError(created.status, createdPayload);

  const taskId = extractTaskId(createdPayload);
  if (taskId === undefined) {
    throw new Error(`provider did not return a task id: ${truncate(createdPayload)}`);
  }

  const taskUrl = joinUrl(base, encodeURIComponent(taskId));
  const finished = await awaitTask(taskUrl, {
    fetchImpl,
    apiKey,
    taskId,
    timeoutMs: Math.max(budget - (Date.now() - startedAt), 0),
    pollIntervalMs,
    sleep,
  });

  const videoUrl = extractVideoUrl(finished);
  if (videoUrl === undefined) {
    throw new Error(
      `video task ${taskId} succeeded but returned no video URL: ${truncate(finished)}`,
    );
  }

  const download = await fetchImpl(videoUrl, { signal: AbortSignal.timeout(budget) });
  if (!download.ok) {
    throw new Error(`failed to download the generated video: HTTP ${download.status} ${videoUrl}`);
  }
  const bytes = Buffer.from(await download.arrayBuffer());

  const directory = ensureDir(
    resolveOutputDir({
      configured: request?.outputDir ?? settings.outputDir,
      cwd: settings.cwd,
      kind: 'video',
    }),
  );
  const path = writeUniqueFileSync(join(directory, buildVideoFileName({ at: now() })), bytes);

  return {
    provider: provider.id,
    model,
    ratio,
    duration,
    taskId,
    directory,
    files: [{ path, bytes: bytes.length, sourceUrl: videoUrl }],
    usage: finished?.usage,
    requestId: taskId,
    waitedMs: Date.now() - startedAt,
  };
}

/** Report a catalogue entry for a model id, so callers can explain their choice. */
export function describeVideoModel(provider, modelId) {
  return findVideoModel(provider, modelId)?.label;
}
