/**
 * Image generation: build the request, call the provider, download the results.
 *
 * `fetch` is injectable so the whole flow — including the download leg — is
 * testable without a network or an API key.
 *
 * @module generate
 */

import { writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { DEFAULT_IMAGE_TIMEOUT_MS, KEY_SPEC, parseTimeoutMs } from './config.mjs';
import { buildImageFileName, ensureDir, resolveOutputDir, validateImageRequest } from './images.mjs';

/** Default ceiling for one HTTP leg, generous enough for a large render. */
export const DEFAULT_TIMEOUT_MS = DEFAULT_IMAGE_TIMEOUT_MS;

/** Join a base URL and a path without doubling or dropping the slash. */
export function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}

/** Require a non-empty trimmed string argument. */
export function requireText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`missing required argument "${name}"`);
  }
  return value.trim();
}

/** Shorten an arbitrary payload for an error message. */
export function truncate(value, limit = 800) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '(no payload)';
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** Turn a non-2xx response into an error that keeps the provider's own words. */
export function apiError(status, payload) {
  const error = payload?.error;
  const code = error?.code ?? payload?.code ?? 'unknown';
  const message = error?.message ?? payload?.message ?? truncate(payload);
  // The status stays in the message: it is what distinguishes "you sent a bad
  // size" from "your account may not call this model".
  return new Error(`media API error [${code}] HTTP ${status}: ${message}`);
}

/** Read a response body as JSON, tolerating an empty or non-JSON body. */
export async function readJson(response) {
  const text = await response.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: truncate(text) };
  }
}

/**
 * Pull image payloads out of a response.
 *
 * Handles both shapes the OpenAI images convention allows: a URL to fetch, and
 * inline base64. Providers that return neither are reported as empty rather
 * than guessed at.
 */
export function extractImages(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : [];
  const images = [];
  for (const entry of list) {
    if (typeof entry?.url === 'string' && entry.url !== '') {
      images.push({ url: entry.url });
      continue;
    }
    if (typeof entry?.b64_json === 'string' && entry.b64_json !== '') {
      images.push({ base64: entry.b64_json });
    }
  }
  return images;
}

/** Pick a file extension from a content type, falling back to the URL path. */
export function extensionFor(contentType, url) {
  const normalized = String(contentType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return '.jpg';
  if (normalized === 'image/webp') return '.webp';

  try {
    const fromUrl = extname(new URL(url).pathname).toLowerCase();
    if (fromUrl === '.jpeg') return '.jpg';
    if (['.png', '.jpg', '.webp'].includes(fromUrl)) return fromUrl;
  } catch {
    // A malformed URL is the caller's problem to report, not this helper's.
  }
  return '.png';
}

/** Fetch the bytes behind a generated image URL. */
async function downloadImage(url, { fetchImpl, timeoutMs }) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`failed to download the generated image: HTTP ${response.status} ${url}`);
  }
  const contentType = response.headers?.get?.('content-type') ?? '';
  const bytes = Buffer.from(await response.arrayBuffer());
  return { bytes, contentType };
}

/**
 * Generate images and write them to disk.
 *
 * Reads settings fresh on every call, which is why changing the model through
 * `set_config` takes effect immediately with no restart.
 *
 * @param settings - the object returned by `resolveSettings`.
 * @param request - `{ prompt, model?, size?, outputDir?, seed?, timeoutMs? }`.
 * @param options.fetchImpl - HTTP implementation; injectable for tests.
 * @param options.now - clock; injectable so file names are deterministic.
 * @param options.timeoutMs - HTTP budget; injectable so tests do not wait.
 * @throws when the prompt is missing, the size fails validation, the timeout is
 *   malformed, or no key is configured — all before any network call.
 */
export async function generateImage(
  settings,
  request,
  { fetchImpl = fetch, now = () => new Date(), timeoutMs } = {},
) {
  const { provider } = settings;
  const prompt = requireText(request?.prompt, 'prompt');
  const model = (request?.model ?? settings.imageModel).trim();
  const size = (request?.size ?? settings.imageSize).trim();

  validateImageRequest(provider, { model, size });

  // An injected option wins (tests), then the per-call argument, then the
  // configured default, so a slow provider needs no code change.
  const budget = timeoutMs ?? parseTimeoutMs(
    request?.timeoutMs ?? settings.imageTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    'timeoutMs',
  );

  const apiKey = typeof settings.apiKey === 'string' ? settings.apiKey.trim() : '';
  if (apiKey === '') {
    throw new Error(
      `no API key configured: set ${KEY_SPEC.apiKey.env} in ${settings.configPath} ` +
        `or export it in the environment`,
    );
  }

  const body = {
    model,
    prompt,
    size,
    ...(provider.extraBody ?? {}),
  };
  if (request?.seed !== undefined) body.seed = request.seed;

  const url = joinUrl(settings.baseUrl, provider.imagePath);
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(budget),
  });

  const payload = await readJson(response);
  if (!response.ok) throw apiError(response.status, payload);

  const images = extractImages(payload);
  if (images.length === 0) {
    throw new Error(`provider returned no image data: ${truncate(payload)}`);
  }

  const directory = ensureDir(
    resolveOutputDir({ configured: request?.outputDir ?? settings.outputDir, cwd: settings.cwd }),
  );
  const at = now();
  const files = [];

  for (const [position, image] of images.entries()) {
    const index = position + 1;
    let bytes;
    let extension;

    if (image.url !== undefined) {
      const downloaded = await downloadImage(image.url, { fetchImpl, timeoutMs: budget });
      bytes = downloaded.bytes;
      extension = extensionFor(downloaded.contentType, image.url);
    } else {
      bytes = Buffer.from(image.base64, 'base64');
      extension = '.png';
    }

    const path = join(directory, buildImageFileName({ at, index, extension }));
    writeFileSync(path, bytes);
    files.push({ path, bytes: bytes.length, sourceUrl: image.url });
  }

  return {
    provider: provider.id,
    model,
    size,
    directory,
    files,
    usage: payload?.usage,
    requestId: payload?.id,
  };
}
