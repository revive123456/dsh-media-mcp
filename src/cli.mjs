/**
 * `media-gen` command line interface.
 *
 * A thin shell over the same modules the MCP server uses, so the CLI and the
 * server can never disagree about configuration. The raw API key is not
 * printable from here on purpose: it stays in the config file or the
 * environment, and every surface reports only a redacted form.
 *
 * @module cli
 */

import { renameSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { maskSecret } from './config.mjs';
import { describeConfig, describeModels, describeResult, describeVideoResult } from './describe.mjs';
import { generateImage } from './generate.mjs';
import { resolveOutputDir } from './images.mjs';
import { PROVIDERS } from './providers.mjs';
import { applyConfigPatch, currentSettings } from './settings.mjs';
import { generateVideo } from './video.mjs';

const USAGE = `media-gen — image and video generation through a configurable provider

Usage:
  media-gen env                       show the effective configuration
  media-gen outdir                    print the directory new media goes to
  media-gen models                    list known image models and their size floors
  media-gen config                    show the effective configuration
  media-gen config set KEY=VALUE...   persist settings (see keys below)
  media-gen img "PROMPT" [-o FILE] [-m MODEL] [-s WxH] [--timeout-ms MS]
  media-gen video "PROMPT" [-o FILE] [-m MODEL] [--ratio W:H] [--duration SECONDS] [--timeout-ms MS]
  media-gen key                       print a redacted view of the API key
  media-gen serve                     run the MCP server on stdio

Settings keys: provider, apiKey, baseUrl, imageModel, imageSize, imageTimeoutMs,
               videoModel, videoTimeoutMs, outputDir
Known providers: ${Object.keys(PROVIDERS).join(', ')}

Images land in <workspace>/image_output and videos in <workspace>/video_output unless
outputDir is set. Both timeouts are milliseconds; --timeout-ms overrides them for one call.

Examples:
  media-gen img "a corgi surfing at sunset, cinematic"
  media-gen img "cyberpunk alley" -s 2048x2048 -o alley.jpg
  media-gen video "a paper boat drifting down a rainy street" --duration 5
  media-gen video "a timelapse of a storm" --duration 10 --timeout-ms 1200000
  media-gen config set imageModel=${PROVIDERS.ark.defaultImageModel}
  media-gen config set videoModel=${PROVIDERS.ark.defaultVideoModel}
  media-gen config set videoTimeoutMs=1200000
`;

/** Parse `KEY=VALUE` pairs for `config set`. */
export function parseAssignments(tokens) {
  const patch = {};
  for (const token of tokens) {
    const separator = token.indexOf('=');
    if (separator <= 0) {
      throw new Error(`expected KEY=VALUE, received "${token}"`);
    }
    patch[token.slice(0, separator)] = token.slice(separator + 1);
  }
  return patch;
}

/** Parse the prompt and flags of `media-gen img`. */
export function parseImageArgs(tokens) {
  const request = { prompt: [] };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = () => {
      index += 1;
      if (index >= tokens.length) throw new Error(`${token} expects a value`);
      return tokens[index];
    };
    switch (token) {
      case '-o':
      case '--out':
        request.out = next();
        break;
      case '-m':
      case '--model':
        request.model = next();
        break;
      case '-s':
      case '--size':
        request.size = next();
        break;
      case '--timeout-ms':
        request.timeoutMs = next();
        break;
      default:
        request.prompt.push(token);
    }
  }
  request.prompt = request.prompt.join(' ').trim();
  if (request.prompt === '') throw new Error('a prompt is required, e.g. media-gen img "a cat"');
  return request;
}

/**
 * Parse the prompt and flags of `media-gen video`.
 *
 * `--duration` and `--ratio` are the two knobs that decide cost and shape, so
 * they are accepted here as well as per MCP call.
 */
export function parseVideoArgs(tokens) {
  const request = { prompt: [] };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = () => {
      index += 1;
      if (index >= tokens.length) throw new Error(`${token} expects a value`);
      return tokens[index];
    };
    switch (token) {
      case '-o':
      case '--out':
        request.out = next();
        break;
      case '-m':
      case '--model':
        request.model = next();
        break;
      case '--ratio':
        request.ratio = next();
        break;
      case '--duration':
        request.duration = next();
        break;
      case '--timeout-ms':
        request.timeoutMs = next();
        break;
      default:
        request.prompt.push(token);
    }
  }
  request.prompt = request.prompt.join(' ').trim();
  if (request.prompt === '') {
    throw new Error('a prompt is required, e.g. media-gen video "a paper boat in the rain"');
  }
  return request;
}

/**
 * Run the CLI.
 *
 * @param argv - arguments after the executable name.
 * @returns the process exit code.
 */
export async function main(argv = []) {
  const [command, ...rest] = argv;

  try {
    switch (command) {
      case 'env':
      case 'config': {
        if (rest[0] === 'set') {
          const settings = applyConfigPatch(parseAssignments(rest.slice(1)));
          process.stdout.write(`saved\n\n${describeConfig(settings)}\n`);
          return 0;
        }
        process.stdout.write(`${describeConfig(currentSettings())}\n`);
        return 0;
      }

      case 'outdir': {
        const settings = currentSettings();
        const dir = (kind) =>
          resolveOutputDir({ configured: settings.outputDir, cwd: settings.cwd, kind });
        process.stdout.write(`images: ${dir('image')}\nvideos: ${dir('video')}\n`);
        return 0;
      }

      case 'models': {
        process.stdout.write(`${describeModels(currentSettings())}\n`);
        return 0;
      }

      case 'key': {
        process.stdout.write(`${maskSecret(currentSettings().apiKey)}\n`);
        return 0;
      }

      case 'img':
      case 'image': {
        const request = parseImageArgs(rest);
        const settings = currentSettings();
        const result = await generateImage(settings, request);

        if (request.out !== undefined && result.files.length > 0) {
          const target = isAbsolute(request.out)
            ? request.out
            : join(result.directory, request.out);
          renameSync(result.files[0].path, target);
          result.files[0].path = target;
        }

        process.stdout.write(`${describeResult(result)}\n`);
        return 0;
      }

      case 'video': {
        const request = parseVideoArgs(rest);
        const settings = currentSettings();
        const result = await generateVideo(settings, request);

        if (request.out !== undefined && result.files.length > 0) {
          const target = isAbsolute(request.out)
            ? request.out
            : join(result.directory, request.out);
          renameSync(result.files[0].path, target);
          result.files[0].path = target;
        }

        process.stdout.write(`${describeVideoResult(result)}\n`);
        return 0;
      }

      case 'serve':
        await import('./server.mjs');
        return 0;

      case undefined:
      case '-h':
      case '--help':
      case 'help':
        process.stdout.write(USAGE);
        return 0;

      default:
        process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
