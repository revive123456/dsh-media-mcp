/**
 * Configuration resolution for media-gen.
 *
 * The config file is a flat YAML mapping: one `key: value` per line, `#`
 * comments, an optional `---` marker, and single- or double-quoted values. Keys
 * are the setting names the MCP tools already accept (`provider`, `apiKey`,
 * `baseUrl`, `imageModel`, `imageSize`, `outputDir`), so the file and the tool
 * arguments share one vocabulary instead of two.
 *
 * A file written as env assignments (`NAME=value`, optional `export`) is still
 * read: that is what earlier releases shipped, and reading it is what lets an
 * existing `config.env` keep working until it is renamed to `config.yml`. Writes
 * always produce YAML, so a written file is no longer shell-sourceable.
 *
 * Precedence, highest first: the process environment, then the config file.
 * Sourcing the file from a shell is never required — this module parses it.
 *
 * The file holds an API key, so every write goes through a temp file and
 * re-asserts `0600`.
 *
 * @module config
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Directory name created under the XDG config root. */
export const CONFIG_DIR_NAME = 'media-gen';

/** File name inside {@link CONFIG_DIR_NAME}. */
export const CONFIG_FILE_NAME = 'config.yml';

/**
 * Longest a single tool call may wait, in milliseconds.
 *
 * A call that hangs for an hour is a configuration mistake, and quietly
 * shortening a deliberate value would be worse than saying so, so a larger
 * value is rejected instead of clamped.
 */
export const MAX_TIMEOUT_MS = 3_600_000;

/** Default budget for one image call. */
export const DEFAULT_IMAGE_TIMEOUT_MS = 180_000;

/** Default budget for the whole video flow: create task, poll it, download. */
export const DEFAULT_VIDEO_TIMEOUT_MS = 720_000;

/**
 * File name this project used before it moved to YAML.
 *
 * Read only, and only when {@link CONFIG_FILE_NAME} is absent at the default
 * location: an un-migrated installation must keep working.
 */
export const LEGACY_CONFIG_FILE_NAME = 'config.env';

/**
 * The full setting surface: setting key -> its environment variable name and
 * whether it holds a secret. Adding a setting means adding one row here.
 *
 * Deliberately provider-neutral: no key is named after a vendor. The key is also
 * the name used in the config file.
 */
export const KEY_SPEC = {
  provider: { env: 'MEDIA_GEN_PROVIDER' },
  apiKey: { env: 'MEDIA_GEN_API_KEY', secret: true },
  baseUrl: { env: 'MEDIA_GEN_BASE_URL' },
  imageModel: { env: 'MEDIA_GEN_IMAGE_MODEL' },
  imageSize: { env: 'MEDIA_GEN_IMAGE_SIZE' },
  imageTimeoutMs: { env: 'MEDIA_GEN_IMAGE_TIMEOUT_MS' },
  videoModel: { env: 'MEDIA_GEN_VIDEO_MODEL' },
  videoTimeoutMs: { env: 'MEDIA_GEN_VIDEO_TIMEOUT_MS' },
  outputDir: { env: 'MEDIA_GEN_OUTPUT_DIR' },
};

/** Every configurable setting key, in display order. */
export const SETTING_KEYS = Object.freeze(Object.keys(KEY_SPEC));

/** Tool names that may be passed to {@link updateConfigFile}. */
export const WRITABLE_SETTING_KEYS = Object.freeze([...SETTING_KEYS]);

/** Drop surrounding whitespace and treat an empty string as absent. */
function clean(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Parse a timeout in milliseconds.
 *
 * Accepts a number or the numeric string a config file yields. Used both for a
 * configured default and for a per-call override, so a bad value is refused
 * before any request is sent rather than turning into an early abort mid-render.
 *
 * @param value - the raw timeout.
 * @param name - the setting or argument name, for the error message.
 * @throws when the value is not a positive whole number of milliseconds, or
 *   exceeds {@link MAX_TIMEOUT_MS}.
 */
export function parseTimeoutMs(value, name = 'timeoutMs') {
  const ms = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new Error(
      `${name} must be a positive whole number of milliseconds (received "${value}")`,
    );
  }
  if (ms > MAX_TIMEOUT_MS) {
    throw new Error(
      `${name} must be at most ${MAX_TIMEOUT_MS} ms (1 hour, received "${value}")`,
    );
  }
  return ms;
}

/** Default config file location, honouring `XDG_CONFIG_HOME`. */
export function defaultConfigPath(env = process.env) {
  return join(configRoot(env), CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

/** Pre-migration config file location, for the read-only fallback. */
export function legacyConfigPath(env = process.env) {
  return join(configRoot(env), CONFIG_DIR_NAME, LEGACY_CONFIG_FILE_NAME);
}

/** The directory that holds the per-user config, honouring `XDG_CONFIG_HOME`. */
function configRoot(env) {
  return clean(env.XDG_CONFIG_HOME) ?? join(homedir(), '.config');
}

/**
 * Effective config file location.
 *
 * `MEDIA_GEN_CONFIG` wins over the default, which is what lets a test or a
 * second environment point somewhere else without touching the real file. An
 * explicitly named file is read as given; the legacy fallback applies only to
 * the default location.
 */
export function resolveConfigPath(env = process.env) {
  const explicit = clean(env.MEDIA_GEN_CONFIG);
  return explicit === undefined ? defaultConfigPath(env) : resolve(explicit);
}

/** Read a file, reporting absence instead of throwing on `ENOENT`. */
function readTextFile(path) {
  try {
    return { text: readFileSync(path, 'utf8'), exists: true };
  } catch (error) {
    if (error?.code === 'ENOENT') return { text: '', exists: false };
    throw error;
  }
}

/** Remove surrounding quotes from a raw env-file value. */
function unquote(raw) {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  // Strip a trailing comment only when it is separated by whitespace, so
  // values such as `a#b` survive.
  return value.replace(/\s+#.*$/, '').trim();
}

/**
 * Parse an env file into a raw `NAME -> value` record.
 *
 * Accepts the shapes a hand-edited file tends to grow: `export ` prefixes,
 * `#` comments, blank lines and single- or double-quoted values.
 *
 * @param text - file contents.
 * @returns every assignment found, keyed by variable name.
 */
export function parseEnvFile(text) {
  const vars = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    vars[match[1]] = unquote(match[2]);
  }
  return vars;
}

/** Read one YAML scalar, undoing the quoting {@link yamlScalar} may have added. */
function yamlValue(raw) {
  const value = raw.trim();
  if (value === '') return undefined;
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return clean(value.replace(/\s+#.*$/, ''));
}

/**
 * Parse the YAML config file.
 *
 * Only a flat mapping is defined: one `key: value` per top-level line. Anything
 * else — a nested block, a sequence, a key this version does not know — is
 * reported through `unknownKeys` instead of being guessed at, because a silently
 * ignored key looks exactly like a setting that does not work.
 *
 * @param text - file contents.
 * @returns the recognized setting values, plus every key that was skipped.
 */
export function parseYamlConfig(text) {
  const values = {};
  const unknownKeys = new Set();

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (/^\s*(?:---|\.\.\.)\s*$/.test(line)) continue;

    const match = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s?(.*)$/.exec(line);
    if (match === null) continue;

    const key = match[1];
    // An indented key belongs to a nested block, which this format does not
    // define; reading it as a top-level setting would invent structure.
    if (/^\s/.test(line) || !Object.hasOwn(KEY_SPEC, key)) {
      unknownKeys.add(key);
      continue;
    }
    values[key] = yamlValue(match[2]);
  }

  return { values, unknownKeys: [...unknownKeys] };
}

/**
 * Read every setting a config file defines, in either supported format.
 *
 * Both shapes are read from the same pass over the file, one line at a time:
 * `name: value` cannot be confused with `NAME=value`, because the separator
 * differs. That keeps a file meaningful even while it is half converted, which
 * is what a patch to a pre-YAML file produces.
 *
 * @param text - file contents.
 * @returns setting values, the keys that were skipped, and the format the file's
 *   settings were written in.
 */
export function parseConfigText(text) {
  const yaml = parseYamlConfig(text);
  const assignments = parseEnvFile(text);

  const values = {};
  let mapped = false;
  for (const [key, value] of Object.entries(yaml.values)) {
    if (value === undefined) continue;
    values[key] = value;
    mapped = true;
  }

  let assigned = false;
  for (const key of SETTING_KEYS) {
    const value = assignments[KEY_SPEC[key].env];
    if (value === undefined) continue;
    assigned = true;
    // The mapping spelling wins when a file carries both.
    values[key] ??= value;
  }

  return {
    values,
    // Only the mapping form can carry a key this version does not know; an env
    // file may legitimately hold unrelated variables.
    unknownKeys: yaml.unknownKeys,
    format: mapped || !assigned ? 'yaml' : 'env',
  };
}

/**
 * Read the effective configuration.
 *
 * A missing file is not an error — the environment alone may define everything.
 * A file that exists but cannot be read does throw, because ignoring it would
 * silently hide a permissions problem.
 *
 * @param options - `env` and `cwd` injection points for tests.
 * @returns config path, per-key values, where each value came from, the file
 *   format, and any keys the file defined that this version does not use.
 */
export function loadConfig({ env = process.env, cwd = process.cwd() } = {}) {
  const explicit = clean(env.MEDIA_GEN_CONFIG) !== undefined;
  let path = resolveConfigPath(env);
  let file = readTextFile(path);

  if (!explicit && !file.exists) {
    const legacy = readTextFile(legacyConfigPath(env));
    if (legacy.exists) {
      path = legacyConfigPath(env);
      file = legacy;
    }
  }

  const parsed = parseConfigText(file.text);
  const values = {};
  const sources = {};
  for (const key of SETTING_KEYS) {
    const fromEnv = clean(env[KEY_SPEC[key].env]);
    if (fromEnv !== undefined) {
      values[key] = fromEnv;
      sources[key] = 'env';
      continue;
    }
    const fromFile = clean(parsed.values[key]);
    if (fromFile !== undefined) {
      values[key] = fromFile;
      sources[key] = 'file';
      continue;
    }
    values[key] = undefined;
    sources[key] = 'unset';
  }

  return {
    path,
    exists: file.exists,
    format: file.exists ? parsed.format : 'yaml',
    unknownKeys: file.exists ? parsed.unknownKeys : [],
    values,
    sources,
    cwd,
  };
}

/** Plain YAML scalars: no quoting needed and no YAML meaning. */
const PLAIN_YAML_SCALAR = /^[A-Za-z0-9_@./][A-Za-z0-9_@./:+-]*$/;

/** Scalars YAML would read as something other than the string itself. */
const YAML_RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'y', 'n']);

/**
 * Render one value as a YAML scalar, quoting when the plain form would change
 * its meaning — a leading `~` (null in YAML), a `#`, a colon-space, or a word
 * such as `no`.
 */
export function yamlScalar(value) {
  const text = String(value);
  if (PLAIN_YAML_SCALAR.test(text) && !YAML_RESERVED.has(text.toLowerCase())) return text;
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

/** The setting key a config line assigns, in either supported format. */
function settingKeyOfLine(line) {
  const yaml = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:/.exec(line);
  if (yaml !== null && Object.hasOwn(KEY_SPEC, yaml[1])) return yaml[1];

  const env = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  if (env !== null) return SETTING_KEYS.find((key) => KEY_SPEC[key].env === env[1]);
  return undefined;
}

/**
 * Update settings in the config file, preserving every unrelated line.
 *
 * A rewritten line is normalized to the YAML mapping, so patching a file left
 * over from the env-file era converts it in place without losing the comments,
 * the ordering, or any value the patch did not touch.
 *
 * The write is atomic (temp file + rename) and the result is `0600`, so a crash
 * cannot truncate a file that holds an API key and cannot widen it.
 *
 * @param path - config file location.
 * @param patch - setting key -> new value; `undefined` leaves a key untouched.
 * @returns the previous value of every key that was written.
 * @throws when a key is not part of {@link KEY_SPEC}.
 */
export function updateConfigFile(path, patch) {
  const pending = new Map();
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (!Object.hasOwn(KEY_SPEC, key)) {
      throw new Error(
        `unknown setting "${key}" (known: ${SETTING_KEYS.join(', ')})`,
      );
    }
    pending.set(key, String(value));
  }
  if (pending.size === 0) return {};

  const original = readTextFile(path).text;
  const before = parseConfigText(original).values;
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original === '' ? [] : original.split(/\r?\n/);
  const written = new Set();

  const rewritten = lines.map((line) => {
    const key = settingKeyOfLine(line);
    if (key === undefined || !pending.has(key)) return line;
    written.add(key);
    return `${key}: ${yamlScalar(pending.get(key))}`;
  });

  for (const [key, value] of pending) {
    if (written.has(key)) continue;
    while (rewritten.length > 0 && rewritten[rewritten.length - 1].trim() === '') {
      rewritten.pop();
    }
    rewritten.push(`${key}: ${yamlScalar(value)}`);
  }

  const body = rewritten.join(eol).replace(/\s+$/, '');
  const text = body === '' ? '' : `${body}${eol}`;

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  chmodSync(path, 0o600);

  return Object.fromEntries([...pending.keys()].map((key) => [key, before[key]]));
}

/**
 * Show only enough of a secret to confirm which one is in place.
 *
 * @param value - the secret, or `undefined` when unset.
 * @returns a redacted label that is safe for logs, chat and tool output.
 */
export function maskSecret(value) {
  const secret = clean(value);
  if (secret === undefined) return '(unset)';
  if (secret.length <= 10) return `${secret.slice(0, 2)}…${secret.slice(-2)}`;
  return `${secret.slice(0, 8)}…${secret.slice(-4)}`;
}
