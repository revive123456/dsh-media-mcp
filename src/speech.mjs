/**
 * Speech synthesis (text to speech): one request, one audio file.
 *
 * Speech differs from images and video in ways that shape this module:
 *
 * - the endpoint is a different service from the image/video host, so the
 *   provider preset names it separately (`speechBaseUrl` + `speechPath`);
 * - the model is a *resource selector* that travels in a header
 *   (`X-Api-Resource-Id`) while the text, speaker and audio parameters go in the
 *   body, so the generic request builder cannot own the whole request;
 * - the answer is a stream of JSON frames carrying base64 audio, not a URL, which
 *   means there is nothing to download and nothing to poll.
 *
 * The frame parsing is deliberately fail-closed: a code this version does not
 * know is reported with the provider's own message instead of being skipped,
 * because skipping it would look like "the model returned no audio".
 *
 * `fetch` is injectable, so the whole flow is testable without a network.
 *
 * @module speech
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DEFAULT_SPEECH_TIMEOUT_MS, KEY_SPEC, parseTimeoutMs } from './config.mjs';
import { apiError, joinUrl, requireText, truncate } from './generate.mjs';
import {
  buildSpeechFileName,
  ensureDir,
  resolveOutputDir,
  writeUniqueFileSync,
} from './images.mjs';
import { findSpeechModel } from './providers.mjs';

/** Frame code that means "this frame carries audio". */
const AUDIO_CODE = 0;

/** Frame code that means "synthesis finished, nothing more is coming". */
const DONE_CODE = 20_000_000;

/** Audio format -> file extension. `ogg_opus` becomes the container suffix. */
const AUDIO_EXTENSIONS = { mp3: '.mp3', pcm: '.pcm', ogg_opus: '.ogg' };

/** Parse an audio format against the provider's accepted list. */
export function parseSpeechFormat(value, provider) {
  const format = String(value ?? '').trim().toLowerCase();
  const allowed = provider.speechFormats ?? [];
  if (!allowed.includes(format)) {
    throw new Error(`format must be one of ${allowed.join(', ')} (received "${value}")`);
  }
  return format;
}

/** Parse a sampling rate in Hz, rejecting anything that is not a positive integer. */
export function parseSampleRate(value) {
  const rate = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isInteger(rate) || rate <= 0) {
    throw new Error(`sampleRate must be a positive whole number of Hz (received "${value}")`);
  }
  return rate;
}

/**
 * Build the synthesis body.
 *
 * Field names and nesting follow the provider's v3 "unidirectional" contract:
 * `text`, `speaker` and `sample_rate` plus an `audio_params` block live inside
 * `req_params`. The model id is *not* here — it is the `X-Api-Resource-Id`
 * header, which is why {@link generateSpeech} sets it separately.
 *
 * Variable-bitrate formats report a bit rate; uncompressed `pcm` has none.
 */
export function buildSpeechRequest(provider, { text, voice, format, sampleRate }) {
  const audioParams = { format };
  if (format === 'mp3' || format === 'ogg_opus') {
    audioParams.bit_rate = provider.defaultSpeechBitRate ?? 64_000;
  }
  return {
    user: { uid: 'media-gen' },
    req_params: {
      text,
      speaker: voice,
      sample_rate: sampleRate,
      audio_params: audioParams,
    },
  };
}

/** Parse one line that may or may not be a complete JSON object. */
function tryJson(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse the endpoint's JSON frames.
 *
 * The documented transport is SSE — one `data: {...}` line per frame — but a
 * whole-body JSON object is accepted too, because a provider that answers both
 * ways is one configuration away and misreading it here would surface as a
 * misleading "no audio data" error.
 *
 * @returns every frame that parsed as an object; unparsable transport noise is
 *   dropped rather than thrown, so the caller can still act on the frames it got.
 */
export function parseSpeechFrames(text) {
  const body = String(text ?? '').trim();
  if (body === '') return [];

  const whole = tryJson(body);
  if (whole !== undefined) return [whole];

  const frames = [];
  for (const line of body.split(/\r?\n/)) {
    const item = line.trim();
    if (item === '') continue;
    const json = item.startsWith('data:') ? item.slice('data:'.length).trim() : item;
    if (json === '' || json === '[DONE]') continue;
    const frame = tryJson(json);
    if (frame !== undefined) frames.push(frame);
  }
  return frames;
}

/** The status code of one frame, tolerating a `header`-nested spelling. */
function frameCode(frame) {
  const code = frame?.code ?? frame?.header?.code;
  return typeof code === 'number' ? code : undefined;
}

/** The provider's own message for one frame, when it carries one. */
function frameMessage(frame) {
  const message = frame?.message ?? frame?.header?.message;
  return typeof message === 'string' && message.trim() !== '' ? message.trim() : undefined;
}

/**
 * Flatten frames into the audio bytes they carry.
 *
 * @throws when a frame reports a failure code, keeping the provider's message —
 *   a `401` or a "voice not activated" has to reach the caller verbatim.
 */
export function extractSpeechAudio(frames) {
  const chunks = [];
  for (const frame of frames) {
    const code = frameCode(frame);
    if (code === DONE_CODE) continue;
    if (code !== undefined && code !== AUDIO_CODE) {
      throw new Error(
        `speech API error [${code}]: ${frameMessage(frame) ?? truncate(frame)}`,
      );
    }
    const data = frame?.data;
    if (typeof data === 'string' && data !== '') {
      chunks.push(Buffer.from(data, 'base64'));
    }
  }
  return Buffer.concat(chunks);
}

/**
 * Synthesize one piece of text and write it to disk.
 *
 * Everything is validated before the first network call: a synthesis request is
 * cheap but not free, and a malformed one should never leave the machine.
 *
 * @param settings - the object returned by `resolveSettings`.
 * @param request - `{ text, model?, voice?, format?, outputDir?, timeoutMs? }`;
 *   `prompt` is accepted as a synonym for `text`.
 * @param options.fetchImpl - HTTP implementation; injectable for tests.
 * @param options.now - clock; injectable so file names are deterministic.
 * @param options.timeoutMs - HTTP budget; injectable so tests do not wait.
 * @throws when the text is missing, the format or timeout is malformed, or no
 *   key is configured — all before any request is sent.
 */
export async function generateSpeech(
  settings,
  request,
  { fetchImpl = fetch, now = () => new Date(), timeoutMs } = {},
) {
  const { provider } = settings;
  const startedAt = Date.now();

  const text = requireText(request?.text ?? request?.prompt, 'text');
  const model = String(request?.model ?? settings.speechModel).trim();
  const voice = String(request?.voice ?? settings.speechVoice).trim();
  const format = parseSpeechFormat(request?.format ?? settings.speechFormat, provider);
  const sampleRate = parseSampleRate(request?.sampleRate ?? settings.speechSampleRate);

  // An injected option wins (tests), then the per-call argument, then the
  // configured default.
  const budget = timeoutMs ?? parseTimeoutMs(
    request?.timeoutMs ?? settings.speechTimeoutMs ?? DEFAULT_SPEECH_TIMEOUT_MS,
    'timeoutMs',
  );

  const apiKey = typeof settings.speechApiKey === 'string' ? settings.speechApiKey.trim() : '';
  if (apiKey === '') {
    throw new Error(
      `no API key configured: set ${KEY_SPEC.speechApiKey.env} or ${KEY_SPEC.apiKey.env} ` +
        `in ${settings.configPath} or export it in the environment`,
    );
  }

  const requestId = randomUUID();
  const response = await fetchImpl(joinUrl(provider.speechBaseUrl, provider.speechPath), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'x-api-resource-id': model,
      'x-api-request-id': requestId,
    },
    body: JSON.stringify(buildSpeechRequest(provider, { text, voice, format, sampleRate })),
    signal: AbortSignal.timeout(budget),
  });

  const body = await response.text();
  if (!response.ok) throw apiError(response.status, parseSpeechFrames(body)[0] ?? { message: truncate(body) });

  const audio = extractSpeechAudio(parseSpeechFrames(body));
  if (audio.length === 0) {
    throw new Error(
      `speech API returned no audio data (model ${model}, voice ${voice}, format ${format}): ` +
        truncate(body),
    );
  }

  // The directory is created only once bytes are in hand, so a rejected request
  // leaves neither a partial file nor an empty folder.
  const directory = ensureDir(
    resolveOutputDir({
      configured: request?.outputDir ?? settings.outputDir,
      cwd: settings.cwd,
      kind: 'speech',
    }),
  );
  const path = writeUniqueFileSync(
    join(directory, buildSpeechFileName({
      at: now(),
      extension: AUDIO_EXTENSIONS[format] ?? '.bin',
    })),
    audio,
  );

  return {
    provider: provider.id,
    model,
    voice,
    format,
    sampleRate,
    characters: text.length,
    directory,
    files: [{ path, bytes: audio.length }],
    requestId,
    waitedMs: Date.now() - startedAt,
  };
}

/** Report a catalogue entry for a resource id, so callers can explain their choice. */
export function describeSpeechModel(provider, modelId) {
  return findSpeechModel(provider, modelId)?.label;
}
