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
 * Known providers.
 *
 * `extraBody` is merged into every image request and is how a provider's
 * non-portable requirements (Ark's `watermark`) stay out of the generic code.
 * `videoParamStyle` is the same idea for video: `prompt` appends
 * `--ratio`/`--duration` to the prompt text, `fields` sends them as top-level
 * request fields. Ark accepts the prompt form on this account for every model in
 * the catalogue; the field form is the newer documented contract for Seedance
 * 2.x, so it stays one line away instead of being guessed at.
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
    outputDir: loaded.values.outputDir,
    sources: loaded.sources,
    configPath: loaded.path,
    configExists: loaded.exists,
    configFormat: loaded.format,
    configUnknownKeys: loaded.unknownKeys,
    cwd: loaded.cwd,
  };
}
