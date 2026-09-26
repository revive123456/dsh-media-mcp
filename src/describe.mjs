/**
 * Human- and model-readable renderings of the current configuration.
 *
 * Shared by the MCP server and the CLI so the two can never disagree about what
 * is in effect, and so a redacted key is redacted in exactly one place.
 *
 * @module describe
 */

import { KEY_SPEC, SETTING_KEYS, maskSecret } from './config.mjs';

/** Describe where a value came from, for provenance lines. */
function sourceLabel(settings, key) {
  const source = settings.sources?.[key];
  if (source === 'env') return 'from environment';
  if (source === 'file') return 'from config file';
  return 'provider default';
}

/**
 * Render the catalogue of models this project knows about for the provider.
 *
 * The pixel floor is stated explicitly because a size that ignores it is the
 * most common way a request fails.
 */
export function describeModels(settings) {
  const models = settings.provider.imageModels ?? [];
  if (models.length === 0) {
    return `no model catalogue for provider "${settings.provider.id}"`;
  }
  const lines = [`known image models (provider=${settings.provider.id}):`];
  for (const model of models) {
    const floor = model.minPixels ? `>=${model.minPixels}px` : 'any size';
    lines.push(`  ${model.id.padEnd(30)} ${floor.padEnd(14)} ${model.note}`);
  }
  return lines.join('\n');
}

/**
 * Render the catalogue of video models this project knows about for the provider.
 *
 * The notes carry what a caller cannot guess — how long a render takes and
 * whether the result has audio — because those decide whether a request is worth
 * starting at all.
 */
export function describeVideoModels(settings) {
  const models = settings.provider.videoModels ?? [];
  if (models.length === 0) {
    return `no video catalogue for provider "${settings.provider.id}"`;
  }
  const lines = [`known video models (provider=${settings.provider.id}):`];
  for (const model of models) {
    lines.push(`  ${model.id.padEnd(34)} ${model.note}`);
  }
  return lines.join('\n');
}

/** Render a millisecond budget as the seconds a person reasons about. */
function formatMs(ms) {
  if (!Number.isFinite(ms)) return '(unset)';
  return `${Math.round(ms / 1000)}s`;
}

/**
 * Render the effective configuration as plain text.
 *
 * The API key is reported as present-or-absent only; its value never appears.
 */
export function describeConfig(settings) {
  const { provider } = settings;
  const model = provider.imageModels?.find((entry) => entry.id === settings.imageModel);
  const videoModel = provider.videoModels?.find((entry) => entry.id === settings.videoModel);

  return [
    `provider    : ${provider.id} — ${provider.displayName}`,
    `base URL    : ${settings.baseUrl}${settings.sources?.baseUrl === 'unset' ? ' (provider default)' : ''}`,
    `image model : ${settings.imageModel}${model ? ` — ${model.label}` : ' (not in catalogue)'}`,
    `image size  : ${settings.imageSize}`,
    `video model : ${settings.videoModel}${videoModel ? ` — ${videoModel.label}` : ' (not in catalogue)'}`,
    `timeouts    : image ${formatMs(settings.imageTimeoutMs)}, video ${formatMs(settings.videoTimeoutMs)} (a per-call timeoutMs overrides; keep your client's tool timeout above these)`,
    `output dir  : ${settings.outputDir ?? `${settings.cwd}/image_output (workspace default; video goes to video_output)`}`,
    `API key     : ${maskSecret(settings.apiKey)} (${KEY_SPEC.apiKey.env})`,
    `config file : ${settings.configPath} (${settings.configExists ? 'present' : 'absent'})`,
    ...(settings.configFormat === 'env' && settings.configExists
      ? [`format      : env assignments — legacy, rename the file to config.yml`]
      : []),
    ...(settings.configUnknownKeys?.length > 0
      ? [`ignored     : ${settings.configUnknownKeys.join(', ')} (not a setting — check the spelling)`]
      : []),
    '',
    describeModels(settings),
    '',
    describeVideoModels(settings),
    '',
    'effective sources:',
    ...SETTING_KEYS.map(
      (key) => `  ${KEY_SPEC[key].env.padEnd(26)} ${sourceLabel(settings, key)}`,
    ),
  ].join('\n');
}

/** Render one generation result as the paths a caller should act on. */
export function describeResult(result) {
  const lines = [
    `generated ${result.files.length} image(s) with ${result.model} at ${result.size}`,
    `directory: ${result.directory}`,
    ...result.files.map((file) => `  ${file.path} (${file.bytes} bytes)`),
  ];
  if (result.usage !== undefined) {
    lines.push(`usage: ${JSON.stringify(result.usage)}`);
  }
  return lines.join('\n');
}

/**
 * Render one video result as the paths and timing a caller should act on.
 *
 * The task id and wait are included because a video is asynchronous: when
 * something goes wrong later, those are what make the run traceable.
 */
export function describeVideoResult(result) {
  const lines = [
    `generated ${result.files.length} video(s) with ${result.model} at ${result.ratio}, ${result.duration}s`,
    `directory: ${result.directory}`,
    ...result.files.map((file) => `  ${file.path} (${file.bytes} bytes)`),
    `task: ${result.taskId} (waited ${Math.round(result.waitedMs / 1000)}s)`,
  ];
  if (result.usage !== undefined) {
    lines.push(`usage: ${JSON.stringify(result.usage)}`);
  }
  return lines.join('\n');
}
