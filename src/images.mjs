/**
 * Image request validation, output-directory policy and file naming.
 *
 * Kept free of network and provider state so every rule here is testable
 * offline.
 *
 * @module images
 */

import { accessSync, constants, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { findImageModel } from './providers.mjs';

const SIZE_PATTERN = /^(\d{2,5})[xX](\d{2,5})$/;

/**
 * Parse a `WxH` size string.
 *
 * @throws with the accepted shape when the value cannot be parsed, so a caller
 *   that passed `1024*1024` is told what to pass instead.
 */
export function parseSize(value) {
  const match = SIZE_PATTERN.exec(String(value ?? '').trim());
  if (match === null) {
    throw new Error(`size must look like WxH, e.g. 1024x1024 (received "${value}")`);
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** Total pixels of a `WxH` size string. */
export function pixelsOf(value) {
  const { width, height } = parseSize(value);
  return width * height;
}

/**
 * Pre-flight check for one image request.
 *
 * A model that is not in the catalogue passes: the provider is the authority on
 * ids added after this file was written, and its own message is more precise
 * than anything we could guess. A catalogued model with a pixel floor is
 * checked up front so the call never leaves the machine.
 *
 * @throws when the requested size is below the model's floor.
 */
export function validateImageRequest(provider, { model, size }) {
  const known = findImageModel(provider, model);
  if (known === undefined || !known.minPixels) return;

  const pixels = pixelsOf(size);
  if (pixels >= known.minPixels) return;

  const suggested = suggestedSize(known.minPixels);
  throw new Error(
    `model ${model} requires at least ${known.minPixels} pixels, but ${size} is only ` +
      `${pixels}. Retry with a larger size such as ${suggested}.`,
  );
}

/** Smallest square `WxH` at or above a pixel floor. */
export function suggestedSize(minPixels) {
  const side = Math.ceil(Math.sqrt(minPixels));
  const rounded = Math.ceil(side / 64) * 64;
  return `${rounded}x${rounded}`;
}

/** Expand a leading `~` and make a path absolute. */
export function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(homedir(), value.slice(2));
  }
  return isAbsolute(value) ? value : resolve(value);
}

/**
 * Default output subdirectory per kind of generated media.
 *
 * One place to look when a file went somewhere unexpected.
 */
const OUTPUT_SUBDIR = { image: 'image_output', video: 'video_output', speech: 'speech_output' };

/**
 * Decide where generated media lands.
 *
 * Policy: an explicit setting (config or per-call override) always wins;
 * otherwise files go to `<workspace>/image_output` for images,
 * `<workspace>/video_output` for video and `<workspace>/speech_output` for
 * speech. The server never defaults to a path outside the workspace, because it
 * runs outside the DSH file sandbox and a silent write to the desktop would
 * escape the user's chosen boundary.
 *
 * @param options.configured - `outputDir` from config or a per-call argument.
 * @param options.cwd - workspace directory to fall back to.
 * @param options.kind - `image`, `video` or `speech`; selects the default subdirectory.
 */
export function resolveOutputDir({ configured, cwd, kind = 'image' }) {
  const explicit =
    typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : undefined;
  const fallback = join(cwd, OUTPUT_SUBDIR[kind] ?? OUTPUT_SUBDIR.image);
  return expandHome(explicit ?? fallback);
}

/** Create a directory if needed and fail loudly when it is not writable. */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  accessSync(dir, constants.W_OK);
  return dir;
}

/** `YYYYMMDD-HHMMSS` in local time. */
export function timestamp(at = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  );
}

/**
 * Build a collision-resistant file name for the n-th image of one request.
 *
 * @param options.at - timestamp shared by every file of the request.
 * @param options.index - 1-based position within the request.
 * @param options.extension - leading-dot extension such as `.jpg`.
 */
export function buildImageFileName({ at = new Date(), index = 1, extension = '.jpg' } = {}) {
  const suffix = index > 1 ? `-${index}` : '';
  return `img-${timestamp(at)}${suffix}${extension}`;
}

/**
 * Build the file name for one generated video.
 *
 * A separate prefix keeps videos distinguishable from images even when a single
 * `outputDir` holds both.
 *
 * @param options.at - timestamp shared by the request.
 * @param options.extension - leading-dot extension such as `.mp4`.
 */
export function buildVideoFileName({ at = new Date(), extension = '.mp4' } = {}) {
  return `vid-${timestamp(at)}${extension}`;
}

/**
 * Build the file name for one synthesized audio file.
 *
 * Speech has its own prefix for the same reason video does: a single configured
 * `outputDir` may hold all three kinds, and the name should say which is which.
 *
 * @param options.at - timestamp shared by the request.
 * @param options.extension - leading-dot extension such as `.mp3`.
 */
export function buildSpeechFileName({ at = new Date(), extension = '.mp3' } = {}) {
  return `speech-${timestamp(at)}${extension}`;
}

/**
 * Write bytes to a path that is guaranteed to be new.
 *
 * Generated file names carry a timestamp with one-second resolution, so two calls
 * in the same second resolve to the same name — and the second write would
 * silently destroy the first caller's file. A `-2`, `-3` … suffix is used until a
 * free name is found, which keeps the documented shape for the common case (one
 * file per second) and loses nothing for the crowded one.
 *
 * Checking before writing would still leave a window where two processes pick the
 * same name, so the creation itself is the arbiter: `flag: 'wx'` fails with
 * `EEXIST` if the file appeared in between, and the suffix then advances
 * *monotonically* — re-asking would be wrong, because the predicate that said
 * "free" is exactly what the failed create just contradicted.
 *
 * Both the existence check and the write are injectable, so the rule is testable
 * without a filesystem.
 *
 * @param path - the path the caller intended to write.
 * @param bytes - what to write.
 * @param options.exists - predicate reporting whether a path is already taken.
 * @param options.write - writer, called with `flag: 'wx'`.
 * @returns the path actually written.
 */
export function writeUniqueFileSync(path, bytes, { exists = existsSync, write = writeFileSync } = {}) {
  const extension = extname(path);
  const stem = path.slice(0, path.length - extension.length);

  for (let index = 1; ; index += 1) {
    const candidate = index === 1 ? path : `${stem}-${index}${extension}`;
    if (!exists(candidate)) {
      try {
        write(candidate, bytes, { flag: 'wx' });
        return candidate;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
  }
}
