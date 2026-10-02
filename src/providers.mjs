/**
 * Provider presets and effective-settings resolution.
 *
 * A provider owns everything that is *not* a user preference: where its API
 * lives, which request fields it needs, and which models this project has
 * actually verified. Swapping providers is a config-time decision, so nothing
 * in this file may assume any particular vendor.
 *
 * The model catalogue is the one place where hard-won environment facts live —
 * pixel floors, cost notes, quota caveats. Encoding them here is what lets the
 * server reject a doomed request with an explanation instead of forwarding an
 * opaque API error.
 *
 * @module providers
 */

import {
  DEFAULT_IMAGE_TIMEOUT_MS,
  DEFAULT_SPEECH_TIMEOUT_MS,
  DEFAULT_VIDEO_TIMEOUT_MS,
  parseTimeoutMs,
} from './config.mjs';

/**
 * Image models verified against the `ark` provider.
 *
 * `minPixels` is the floor the provider enforces; `0` means any size works.
 * The notes are user-facing and intentionally terse.
 */
const ARK_IMAGE_MODELS = [
  {
    id: 'doubao-seedream-4-0-250828',
    label: 'Seedream 4.0',
    minPixels: 0,
    note: 'most reliable; works from 1024x1024',
  },
  {
    id: 'doubao-seedream-4-5-251128',
    label: 'Seedream 4.5',
    minPixels: 3686400,
    note: 'requires >= 3686400 pixels, e.g. 2048x2048',
  },
  {
    id: 'doubao-seedream-5-0-260128',
    label: 'Seedream 5.0',
    minPixels: 3686400,
    note: 'requires >= 3686400 pixels, e.g. 2048x2048',
  },
  {
    id: 'doubao-seedream-5-0-flash-260915',
    label: 'Seedream 5.0 Flash',
    minPixels: 0,
    note: 'works at 1024x1024; was quota-capped by the account usage limit',
  },
];

/**
 * Video models verified against the `ark` provider.
 *
 * `note` carries what a caller cannot guess: how long a render takes, whether
 * the result has audio, and which duration range the provider documents. No
 * duration is enforced locally — a rejected duration fails task creation before
 * any render is billed, so the provider's own message is the better authority.
 */
const ARK_VIDEO_MODELS = [
  {
    id: 'doubao-seedance-2-5-260628',
    label: 'Seedance 2.5',
    note: '1280x720 / 24fps / 5s; measured ~4 min; includes AAC audio',
  },
  {
    id: 'doubao-seedance-1-0-pro-250528',
    label: 'Seedance 1.0 Pro',
    note: '1920x1088 / 5s; no audio, cheaper',
  },
  {
    id: 'doubao-seedance-1-0-pro-fast-251015',
    label: 'Seedance 1.0 Pro Fast',
    note: '1920x1088 / 5s; no audio, faster',
  },
];

/**
 * Speech (text-to-speech) resources known for the `ark` provider.
 *
 * The id is the resource selector, not a checkpoint: it travels in the
 * `X-Api-Resource-Id` header. A note states only what is behind it — `seed-tts-2.0`
 * is the one this project has actually synthesized with, and the other entry says
 * it is unverified. Do not upgrade a note to a measured claim without a run.
 */
const ARK_SPEECH_MODELS = [
  {
    id: 'seed-tts-2.0',
    label: 'Seed TTS 2.0',
    note: 'verified 2026-10-02: 18 chars -> 27 KB mp3 in ~2s, voice zh_female_vv_uranus_bigtts',
  },
  {
    id: 'seed-tts-1.0',
    label: 'Seed TTS 1.0',
    note: 'earlier resource id seen in third-party clients; unverified here',
  },
];

/**
 * Known providers.
 *
 * `extraBody` is merged into every image request and is how a provider's
 * non-portable requirements (Ark's `watermark`) stay out of the generic code.
 * `videoParamStyle` is the same idea for video: `prompt` appends
 * `--ratio`/`--duration` to the prompt text, `fields` sends them as top-level
 * request fields. Ark accepts the prompt form on this account for every model in
 * the catalogue; the field form is the newer documented contract for Seedance
 * 2.x, so it stays one line away instead of being guessed at.
 *
 * Speech gets the same treatment: `speechBaseUrl` + `speechPath` name the
 * synthesis endpoint (which is a different service from the image/video host),
 * and the speech model id travels in a header rather than the body, which is why
 * it is a preset field and not part of the generic request builder.
 */
export const PROVIDERS = {
  ark: {
    id: 'ark',
    displayName: 'Volcengine Ark (火山引擎方舟)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    imagePath: '/images/generations',
    defaultImageModel: 'doubao-seedream-4-0-250828',
    defaultImageSize: '1024x1024',
    imageModels: ARK_IMAGE_MODELS,
    extraBody: { response_format: 'url', watermark: false },
    videoPath: '/contents/generations/tasks',
    videoParamStyle: 'prompt',
    defaultVideoModel: 'doubao-seedance-2-5-260628',
    defaultVideoRatio: '16:9',
    defaultVideoDuration: 5,
    videoModels: ARK_VIDEO_MODELS,
    // Doubao speech synthesis is its own service with its own API key, so it
    // carries a base URL of its own instead of riding on `baseUrl`.
    speechBaseUrl: 'https://openspeech.bytedance.com',
    speechPath: '/api/v3/tts/unidirectional/sse',
    defaultSpeechModel: 'seed-tts-2.0',
    defaultSpeechVoice: 'zh_female_vv_uranus_bigtts',
    defaultSpeechFormat: 'mp3',
    defaultSpeechSampleRate: 24_000,
    defaultSpeechBitRate: 64_000,
    speechFormats: ['mp3', 'pcm', 'ogg_opus'],
    speechModels: ARK_SPEECH_MODELS,
  },
};

/** Provider used when the config does not name one. */
export const DEFAULT_PROVIDER_ID = 'ark';

/** Every known provider id. */
export function providerIds() {
  return Object.keys(PROVIDERS);
}

/**
 * Look up a provider preset.
 *
 * @param id - provider id; empty or absent falls back to the default.
 * @throws when the id is unknown, rather than silently using another provider.
 */
export function resolveProvider(id) {
  const key = typeof id === 'string' && id.trim() !== '' ? id.trim() : DEFAULT_PROVIDER_ID;
  const provider = PROVIDERS[key];
  if (provider === undefined) {
    throw new Error(
      `unknown provider "${key}" (known: ${providerIds().join(', ')})`,
    );
  }
  return provider;
}

/** Find a catalogue entry for a model id, if this project knows it. */
export function findImageModel(provider, modelId) {
  return (provider.imageModels ?? []).find((entry) => entry.id === modelId);
}

/** Find a catalogue entry for a video model id, if this project knows it. */
export function findVideoModel(provider, modelId) {
  return (provider.videoModels ?? []).find((entry) => entry.id === modelId);
}

/** Find a catalogue entry for a speech resource id, if this project knows it. */
export function findSpeechModel(provider, modelId) {
  return (provider.speechModels ?? []).find((entry) => entry.id === modelId);
}

/**
 * Turn raw loaded values into the settings every layer consumes.
 *
 * Resolution order per field: explicit environment/file value, then the
 * provider default. The result carries provenance so `get_config` can explain
 * where a value came from.
 *
 * @param loaded - the object returned by `loadConfig`.
 */
export function resolveSettings(loaded) {
  const provider = resolveProvider(loaded.values.provider);
  return {
    provider,
    apiKey: loaded.values.apiKey,
    baseUrl: loaded.values.baseUrl ?? provider.baseUrl,
    imageModel: loaded.values.imageModel ?? provider.defaultImageModel,
    imageSize: loaded.values.imageSize ?? provider.defaultImageSize,
    videoModel: loaded.values.videoModel ?? provider.defaultVideoModel,
    speechModel: loaded.values.speechModel ?? provider.defaultSpeechModel,
    speechVoice: loaded.values.speechVoice ?? provider.defaultSpeechVoice,
    speechFormat: loaded.values.speechFormat ?? provider.defaultSpeechFormat,
    // Sample rate and bit rate are provider facts, not preferences, so they stay
    // in the preset until a caller has a reason to override them per call.
    speechSampleRate: provider.defaultSpeechSampleRate,
    // The speech service issues its own key, but a single-key installation is
    // the common case: fall back to the image/video key instead of demanding a
    // second credential up front.
    speechApiKey: loaded.values.speechApiKey ?? loaded.values.apiKey,
    // Timeouts resolve here, not at the call site, so a bad configured value
    // fails loudly on every entry point instead of aborting one request early.
    imageTimeoutMs: parseTimeoutMs(
      loaded.values.imageTimeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS,
      'imageTimeoutMs',
    ),
    videoTimeoutMs: parseTimeoutMs(
      loaded.values.videoTimeoutMs ?? DEFAULT_VIDEO_TIMEOUT_MS,
      'videoTimeoutMs',
    ),
    speechTimeoutMs: parseTimeoutMs(
      loaded.values.speechTimeoutMs ?? DEFAULT_SPEECH_TIMEOUT_MS,
      'speechTimeoutMs',
    ),
    outputDir: loaded.values.outputDir,
    sources: loaded.sources,
    configPath: loaded.path,
    configExists: loaded.exists,
    configFormat: loaded.format,
    configUnknownKeys: loaded.unknownKeys,
    cwd: loaded.cwd,
  };
}
