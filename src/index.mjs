/**
 * Library surface of media-gen.
 *
 * The MCP server and the CLI are both thin layers over these exports, which is
 * also what the offline tests exercise.
 *
 * @module media-gen
 */

export {
  CONFIG_DIR_NAME,
  CONFIG_FILE_NAME,
  DEFAULT_IMAGE_TIMEOUT_MS,
  DEFAULT_VIDEO_TIMEOUT_MS,
  KEY_SPEC,
  LEGACY_CONFIG_FILE_NAME,
  MAX_TIMEOUT_MS,
  SETTING_KEYS,
  defaultConfigPath,
  legacyConfigPath,
  loadConfig,
  maskSecret,
  parseConfigText,
  parseEnvFile,
  parseTimeoutMs,
  parseYamlConfig,
  resolveConfigPath,
  updateConfigFile,
  yamlScalar,
} from './config.mjs';

export {
  DEFAULT_PROVIDER_ID,
  PROVIDERS,
  findImageModel,
  findVideoModel,
  providerIds,
  resolveProvider,
  resolveSettings,
} from './providers.mjs';

export {
  buildImageFileName,
  buildVideoFileName,
  ensureDir,
  expandHome,
  parseSize,
  pixelsOf,
  resolveOutputDir,
  suggestedSize,
  timestamp,
  validateImageRequest,
} from './images.mjs';

export {
  DEFAULT_TIMEOUT_MS,
  apiError,
  extensionFor,
  extractImages,
  generateImage,
  joinUrl,
  readJson,
  requireText,
  truncate,
} from './generate.mjs';

export {
  DEFAULT_POLL_INTERVAL_MS,
  buildVideoRequest,
  describeVideoModel,
  extractTaskId,
  extractVideoUrl,
  generateVideo,
  parseDurationSeconds,
  parseRatio,
  taskStatus,
} from './video.mjs';

export { applyConfigPatch, currentSettings } from './settings.mjs';

export {
  describeConfig,
  describeModels,
  describeResult,
  describeVideoModels,
  describeVideoResult,
} from './describe.mjs';
