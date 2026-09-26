/**
 * media-gen MCP server over stdio (newline-delimited JSON-RPC 2.0).
 *
 * Exposes exactly three tools, on purpose:
 *
 * - `generate_image` does the work;
 * - `get_config` reports what is in effect and which models are legal;
 * - `set_config` changes settings, so "use the 5.0 model" needs no settings UI.
 *
 * Settings are re-read on every call, so a `set_config` write is live
 * immediately: there is no cached state to invalidate and no restart to ask the
 * user for.
 *
 * Protocol notes:
 * - stdout carries ONLY JSON-RPC frames; all diagnostics go to stderr.
 * - Tool failures come back as `isError` results rather than JSON-RPC errors,
 *   so the caller reads the provider's own message instead of a generic one.
 *
 * @module server
 */

import { KEY_SPEC, maskSecret } from './config.mjs';
import { describeConfig, describeResult, describeVideoResult } from './describe.mjs';
import { generateImage } from './generate.mjs';
import { providerIds } from './providers.mjs';
import { applyConfigPatch, currentSettings } from './settings.mjs';
import { generateVideo } from './video.mjs';

/** Server identity reported during `initialize`. */
export const SERVER_NAME = 'media-gen';

/** Server version reported during `initialize`. */
export const SERVER_VERSION = '0.2.0';

const SUPPORTED_PROTOCOL = '2024-11-05';

const INSTRUCTIONS = [
  'Image and video generation through a configurable provider.',
  'Call generate_image when the user asks to draw, create or generate a picture.',
  'Call get_config to learn the current models, the legal sizes and which models exist.',
  'Call set_config when the user asks to switch the model, size or output directory.',
  'Generation costs real money; never call generate_image speculatively.',
  'generate_video is asynchronous and takes minutes: call it only when the user explicitly asks for a video.',
].join(' ');

/** Tool catalogue exposed to the harness. */
export const TOOLS = [
  {
    name: 'generate_image',
    description:
      'Generate an image from a text prompt and save it to disk. Call this when the user ' +
      'asks to draw, create, render, illustrate or generate a picture, photo or artwork. ' +
      'Returns the absolute paths of the saved files; pass one to read_image to view it. ' +
      'Each call costs real money, so call it once per explicit user request.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'What to draw, in natural language. Prefer a specific, visual description: ' +
            'style, subject, lighting and composition all help.',
        },
        model: {
          type: 'string',
          description:
            'Image model id for this call only. Omit to use the configured default. ' +
            'Call get_config for the available ids and their size constraints.',
        },
        size: {
          type: 'string',
          description:
            'Output size as WxH, for example 1024x1024. Some models require at least ' +
            '3686400 pixels, so 2048x2048 is the safe large size.',
        },
        outputDir: {
          type: 'string',
          description: 'Directory for this call only. Omit to use the configured default.',
        },
        timeoutMs: {
          type: 'integer',
          description:
            'How long this call may wait, in milliseconds. Omit to use the configured default. ' +
            'The ceiling is 3600000 (one hour).',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'generate_video',
    description:
      'Generate a short video from a text prompt and save it to disk. Asynchronous: the provider ' +
      'renders in the background and this call waits, typically one to three minutes. Call it only ' +
      'when the user explicitly asks for a video — reference images and videos are not supported. ' +
      'Returns the absolute path of the saved file, the task id and how long it waited.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'What to film, in natural language. Describe the subject, the action and the camera ' +
            'movement: a shot the model can stage beats a list of keywords.',
        },
        model: {
          type: 'string',
          description:
            'Video model id for this call only. Omit to use the configured default. ' +
            'Call get_config for the available ids and their notes.',
        },
        ratio: {
          type: 'string',
          description: 'Aspect ratio as W:H, for example 16:9 or 9:16. Default 16:9.',
        },
        duration: {
          type: 'integer',
          description:
            'Clip length in seconds. Default 5. Longer clips take longer and cost more; the ' +
            'provider decides which lengths it accepts.',
        },
        outputDir: {
          type: 'string',
          description:
            'Directory for this call only. Omit to use the configured default, which is ' +
            '<workspace>/video_output.',
        },
        timeoutMs: {
          type: 'integer',
          description:
            'How long the whole call may wait — create, poll, download — in milliseconds. Omit ' +
            'to use the configured default. A five second clip measured about four minutes, so ' +
            'keep this generous; the ceiling is 3600000 (one hour).',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_config',
    description:
      'Report the current configuration: provider, base URL, the image and video models in use, ' +
      'their defaults, the output directory, whether an API key is present (never its value), and ' +
      'the catalogue of known models with their constraints. Call this before changing settings, ' +
      'or when the user asks which model is in use.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'set_config',
    description:
      'Change settings and persist them to the config file. Call this when the user asks to ' +
      'switch a model, change a default size, output directory or timeout, or change provider. ' +
      'Only the fields passed are changed and everything else is preserved. Changes take effect ' +
      'on the next call with no restart.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: `Provider id. Known: ${providerIds().join(', ')}.`,
        },
        apiKey: {
          type: 'string',
          description:
            'API key to store. Write-only: no tool ever returns it. Omit to keep the current key.',
        },
        baseUrl: {
          type: 'string',
          description: 'API base URL override. Omit to use the provider default.',
        },
        imageModel: { type: 'string', description: 'Default image model id.' },
        imageSize: { type: 'string', description: 'Default image size as WxH, for example 1024x1024.' },
        videoModel: {
          type: 'string',
          description:
            'Default video model id. Video is generated only by an explicit generate_video call.',
        },
        imageTimeoutMs: {
          type: 'integer',
          description:
            'Default budget for one image call, in milliseconds. Raise it for a slow provider.',
        },
        videoTimeoutMs: {
          type: 'integer',
          description:
            'Default budget for the whole video flow, in milliseconds. A five second clip ' +
            'measured about four minutes.',
        },
        outputDir: {
          type: 'string',
          description:
            'Default output directory. Set to an empty string to fall back to ' +
            '<workspace>/image_output.',
        },
      },
      additionalProperties: false,
    },
  },
];

/** Write one JSON-RPC frame to stdout. */
function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** Build a successful JSON-RPC response. */
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

/** Build a JSON-RPC error response. */
function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

/** Wrap text into a successful MCP tool result. */
function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

/** Wrap text into a failed MCP tool result the caller can read and act on. */
function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: `error: ${message}` }], isError: true };
}

/** Service one `tools/call`. */
async function callTool(name, args) {
  switch (name) {
    case 'generate_image':
      return textResult(describeResult(await generateImage(currentSettings(), args ?? {})));

    case 'generate_video':
      return textResult(describeVideoResult(await generateVideo(currentSettings(), args ?? {})));

    case 'get_config':
      return textResult(describeConfig(currentSettings()));

    case 'set_config': {
      const patch = args ?? {};
      const settings = applyConfigPatch(patch);
      const changed = Object.keys(patch).filter((key) => key !== 'apiKey');
      const keyNote =
        patch.apiKey === undefined ? '' : `\nAPI key     : ${maskSecret(settings.apiKey)} (updated)`;
      return textResult(
        `configuration saved (${changed.join(', ') || 'api key only'})${keyNote}\n\n` +
          describeConfig(settings),
      );
    }

    default:
      throw new Error(`unknown tool: ${String(name)}`);
  }
}

const HANDLERS = {
  initialize(params) {
    const requested = params?.protocolVersion;
    const protocolVersion =
      typeof requested === 'string' && requested.length > 0 ? requested : SUPPORTED_PROTOCOL;
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: INSTRUCTIONS,
    };
  },

  ping() {
    return {};
  },

  'tools/list'() {
    return { tools: TOOLS };
  },

  async 'tools/call'(params) {
    try {
      return await callTool(params?.name, params?.arguments);
    } catch (error) {
      return errorResult(error);
    }
  },
};

/** Dispatch one parsed JSON-RPC message. */
async function dispatch(message) {
  const { id, method, params } = message ?? {};

  // Notifications carry no id and must never be answered.
  const isNotification = id === undefined || id === null;

  const handler = HANDLERS[method];
  if (handler === undefined) {
    if (!isNotification) replyError(id, -32601, `method not found: ${String(method)}`);
    return;
  }
  if (isNotification) return;

  try {
    reply(id, await handler(params));
  } catch (error) {
    replyError(id, -32603, error instanceof Error ? error.message : String(error));
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (line.length === 0) continue;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      process.stderr.write(`[${SERVER_NAME}] bad frame dropped: ${String(error)}\n`);
      continue;
    }

    dispatch(parsed).catch((error) => {
      process.stderr.write(`[${SERVER_NAME}] dispatch failed: ${String(error)}\n`);
    });
  }
});

process.stdin.on('end', () => process.exit(0));

process.stderr.write(`[${SERVER_NAME}] ready (pid ${process.pid})\n`);
