/**
 * Reading and writing the effective settings.
 *
 * Split out of the server entry point so tests can import it without starting
 * a stdio server, and so the CLI and the server share one write path.
 *
 * @module settings
 */

import { KEY_SPEC, SETTING_KEYS, loadConfig, parseTimeoutMs, updateConfigFile } from './config.mjs';
import { parseSize } from './images.mjs';
import { resolveProvider, resolveSettings } from './providers.mjs';
import { parseSpeechFormat } from './speech.mjs';

/**
 * Load and resolve settings from the live environment.
 *
 * Called on every request rather than cached, which is what makes a
 * `set_config` write visible immediately without a restart.
 */
export function currentSettings({ env = process.env, cwd = process.cwd() } = {}) {
  return resolveSettings(loadConfig({ env, cwd }));
}

/**
 * Validate and persist a settings patch.
 *
 * Every value is validated before the file is touched, so an invalid request
 * can never leave a half-applied configuration behind. A rejected value is
 * reported instead of being silently dropped — a form would have had to either
 * accept it or lose the user's edit.
 *
 * @param patch - subset of `{ provider, apiKey, baseUrl, imageModel, imageSize, videoModel, outputDir }`.
 * @returns the freshly reloaded settings.
 * @throws when a key name or a value is not accepted.
 */
export function applyConfigPatch(patch, { env = process.env, cwd = process.cwd() } = {}) {
  const settings = currentSettings({ env, cwd });
  const requested = patch ?? {};

  const unknown = Object.keys(requested).filter((key) => !SETTING_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new Error(`unknown setting(s): ${unknown.join(', ')} (known: ${SETTING_KEYS.join(', ')})`);
  }

  const next = {};

  if (requested.provider !== undefined) {
    next.provider = String(requested.provider).trim();
    resolveProvider(next.provider);
  }

  if (requested.apiKey !== undefined) {
    const apiKey = String(requested.apiKey).trim();
    if (apiKey === '') throw new Error(`${KEY_SPEC.apiKey.env} must not be empty`);
    next.apiKey = apiKey;
  }

  if (requested.baseUrl !== undefined) {
    const baseUrl = String(requested.baseUrl).trim().replace(/\/+$/, '');
    if (baseUrl === '') {
      throw new Error('baseUrl must not be empty; omit it to use the provider default');
    }
    next.baseUrl = baseUrl;
  }

  if (requested.imageModel !== undefined) {
    const imageModel = String(requested.imageModel).trim();
    if (imageModel === '') throw new Error('imageModel must not be empty');
    next.imageModel = imageModel;
  }

  if (requested.imageSize !== undefined) {
    const imageSize = String(requested.imageSize).trim();
    parseSize(imageSize);
    next.imageSize = imageSize;
  }

  if (requested.videoModel !== undefined) {
    const videoModel = String(requested.videoModel).trim();
    if (videoModel === '') throw new Error('videoModel must not be empty');
    next.videoModel = videoModel;
  }

  if (requested.imageTimeoutMs !== undefined) {
    next.imageTimeoutMs = parseTimeoutMs(requested.imageTimeoutMs, 'imageTimeoutMs');
  }

  if (requested.videoTimeoutMs !== undefined) {
    next.videoTimeoutMs = parseTimeoutMs(requested.videoTimeoutMs, 'videoTimeoutMs');
  }

  if (requested.speechApiKey !== undefined) {
    const speechApiKey = String(requested.speechApiKey).trim();
    if (speechApiKey === '') throw new Error(`${KEY_SPEC.speechApiKey.env} must not be empty`);
    next.speechApiKey = speechApiKey;
  }

  if (requested.speechModel !== undefined) {
    const speechModel = String(requested.speechModel).trim();
    if (speechModel === '') throw new Error('speechModel must not be empty');
    next.speechModel = speechModel;
  }

  if (requested.speechVoice !== undefined) {
    const speechVoice = String(requested.speechVoice).trim();
    if (speechVoice === '') throw new Error('speechVoice must not be empty');
    next.speechVoice = speechVoice;
  }

  if (requested.speechFormat !== undefined) {
    const speechFormat = String(requested.speechFormat).trim();
    if (speechFormat === '') throw new Error('speechFormat must not be empty');
    parseSpeechFormat(speechFormat, settings.provider);
    next.speechFormat = speechFormat;
  }

  if (requested.speechTimeoutMs !== undefined) {
    next.speechTimeoutMs = parseTimeoutMs(requested.speechTimeoutMs, 'speechTimeoutMs');
  }

  if (requested.outputDir !== undefined) {
    next.outputDir = String(requested.outputDir).trim();
  }

  if (Object.keys(next).length === 0) throw new Error('no settings to change');

  updateConfigFile(settings.configPath, next);
  return currentSettings({ env, cwd });
}
