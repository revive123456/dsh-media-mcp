# dsh-media-mcp

[中文](README.zh.md) | English

Turn a sentence into an image or a short video on your machine.

`dsh-media-mcp` is a small [MCP](https://modelcontextprotocol.io) server. Your AI client calls it,
it calls your media provider, and the result lands on disk as a normal file you can open. It also
exposes its own settings as tools, so changing the model, the size or the output folder is something
you say in chat — no settings screen to hunt for.

Works with any MCP client. Built for and tested with
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

## What you can do

Just ask:

- **"Draw a corgi surfing at sunset."** — you get back an absolute path to a saved JPEG.
- **"Make a five second clip of a paper boat drifting down a rainy street."** — a video, in a few
  minutes (three to four, measured).
- **"What models are you using?"** — `get_config` answers.
- **"Switch to Seedream 4.0, 2048x2048."** — `set_config` saves it; the next image uses it.

| Tool | What it does |
| --- | --- |
| `generate_image` | Generate from a prompt, save it, return the paths. Optional per-call `model`, `size`, `outputDir`. |
| `generate_video` | Generate a short clip. Text to video only. Optional per-call `model`, `ratio`, `duration`, `outputDir`. Slow and paid — ask for it explicitly. |
| `get_config` | Show the settings in effect, whether a key is configured, and which models are known. |
| `set_config` | Change a setting and save it. Applies to the next call. |

It knows a size each image model will refuse, and says so **before** spending your money:

```
model doubao-seedream-4-5-251128 requires at least 3686400 pixels, but 1024x1024 is only
1048576. Retry with a larger size such as 1920x1920.
```

## Requirements

Node.js `^22.19.0 || >=24.0.0`. No dependencies, no build step: clone it and run it.

## Setup

### 1. Get an API key

The built-in preset is Volcengine Ark (Doubao / Seedream / Seedance). The server speaks the OpenAI
images API for pictures and Ark's task API for video, so a different vendor works too — it needs one
entry in `src/providers.mjs`.

### 2. Write the config file

This is where your key lives. `~/.config/media-gen/config.yml` on macOS and Linux, or
`%APPDATA%\media-gen\config.yml` on Windows:

```yaml
provider: ark
apiKey: your-api-key
imageModel: doubao-seedream-5-0-flash-260915
imageSize: 1024x1024
videoModel: doubao-seedance-2-5-260628
# outputDir: "~/Pictures/generated"
```

Then `chmod 600` it. [`config.example.yml`](config.example.yml) is the same thing to copy from, and
`MEDIA_GEN_CONFIG` points somewhere else if you prefer.

Quote a value that starts with `~`, otherwise YAML reads it as nothing.

### 3. Point your client at the server

Any MCP client:

```jsonc
{
  "mcpServers": {
    "media": {
      "command": "node",
      "args": ["/absolute/path/to/dsh-media-mcp/src/server.mjs"],
      "cwd": "/absolute/path/to/your/workspace"
    }
  }
}
```

DeepSeek Harness — append this row to `$DSH_HOME/profiles/<profile>/cordis.patch.yml`.
`@deepseek-ai/dsh-mcp-client` already ships with `dsh`, so nothing needs installing:

```yaml
- insert:
    - id: mcp-media
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: media
        command: node
        args:
          - /absolute/path/to/dsh-media-mcp/src/server.mjs
        cwd: /absolute/path/to/your/workspace
        toolCallTimeoutMs: 900000   # a video waits minutes; the 60s default is far too short
        failOnStartupError: true
```

The tools appear as `mcp__media__generate_image`, `mcp__media__generate_video`,
`mcp__media__get_config` and `mcp__media__set_config`.

**No app restart needed:** a patched profile picks the row up in the same session, and generated
files follow `cwd`, so point `cwd` at the workspace you want them in.

## Where your files go

| What | Default | Override |
| --- | --- | --- |
| Images | `<workspace>/image_output/` — one `img-YYYYMMDD-HHMMSS.jpg` per result | `outputDir` (config or per call) |
| Videos | `<workspace>/video_output/` — one `vid-YYYYMMDD-HHMMSS.mp4` per result | `outputDir` (config or per call) |

`<workspace>` is the `cwd` you gave the server. Setting `outputDir` sends **both** kinds to that one
folder; leave it unset to keep them apart. `media-gen outdir` prints both directories, and `~` is
expanded in a configured path.

Tools return **paths**, not file data, so a large image or clip never floods the conversation. Open
the file with any viewer; in DeepSeek Harness you can also hand an image path to the `read_image`
tool.

## Settings

Change any of these with `set_config`, or by editing the file — it is read on every call, so nothing
needs restarting either way.

| Setting | In the config file | Environment variable | Notes |
| --- | --- | --- | --- |
| Provider | `provider:` | `MEDIA_GEN_PROVIDER` | Which preset to use. Default `ark`. |
| API key | `apiKey:` | `MEDIA_GEN_API_KEY` | Required. Never printed by any tool. |
| API URL | `baseUrl:` | `MEDIA_GEN_BASE_URL` | Overrides the preset's URL. |
| Image model | `imageModel:` | `MEDIA_GEN_IMAGE_MODEL` | Default model for pictures. |
| Image size | `imageSize:` | `MEDIA_GEN_IMAGE_SIZE` | Default size, `WxH`. |
| Video model | `videoModel:` | `MEDIA_GEN_VIDEO_MODEL` | Default model for clips. |
| Image timeout | `imageTimeoutMs:` | `MEDIA_GEN_IMAGE_TIMEOUT_MS` | Milliseconds one image call may take. Default `180000`. |
| Video timeout | `videoTimeoutMs:` | `MEDIA_GEN_VIDEO_TIMEOUT_MS` | Milliseconds the whole video flow may take. Default `720000`. |
| Output folder | `outputDir:` | `MEDIA_GEN_OUTPUT_DIR` | Overrides both defaults above. `~` is expanded. |

An environment variable beats the config file. For the model lists, their size floors and their
notes, run `media-gen models` or ask `get_config`.

Aspect ratio and clip length are per call (`ratio`, `duration`; default `16:9` and `5` seconds),
because they change what a clip costs.

### Timeouts

A five second clip measured about four minutes, so both waits are yours to set rather than constants
baked into the code:

```yaml
imageTimeoutMs: 300000     # a slow image provider
videoTimeoutMs: 1200000    # longer clips
```

`set_config` writes the same two keys, `media-gen config set videoTimeoutMs=1200000` does it from a
shell, and either can be overridden for one call: `generate_image` and `generate_video` take
`timeoutMs`, the CLI takes `--timeout-ms 1200000`. `get_config` reports what is in effect.

The ceiling is `3600000` (one hour). A larger value is refused rather than shortened, because a call
that hangs for an hour is a mistake worth seeing.

**Keep your client's tool timeout above ours.** The server can only stop its own wait; if your MCP
client gives up first you get its error instead of a message naming the video task id. The DSH row
above uses `toolCallTimeoutMs: 900000` for that reason.

A config file from an older release, written as `MEDIA_GEN_API_KEY=...` lines, still works. Renaming
it to `config.yml` is all it takes to move on.

## Command line

The same server comes with a small CLI. Symlink `bin/media-gen.mjs` onto your `PATH`:

```bash
media-gen env                            # what is in effect right now
media-gen models                         # image models and their size floors
media-gen outdir                         # where images and videos will be written
media-gen img "a corgi surfing at sunset"
media-gen img "cyberpunk alley" -s 2048x2048 -o alley.jpg
media-gen video "a paper boat drifting down a rainy street" --duration 5
media-gen config set imageModel=doubao-seedream-4-0-250828
media-gen config set videoModel=doubao-seedance-1-0-pro-250528
media-gen key                            # redacted; the raw key is never printed
media-gen serve                          # run the MCP server on stdio
```

## Troubleshooting

| What you see | What it means |
| --- | --- |
| `no API key configured` | `apiKey:` is missing or empty in the config file. |
| `model … requires at least N pixels` | That image model has a size floor — use the size the message suggests. |
| `media API error [InvalidEndpointOrModel.NotFound]` | The model is not available to your account or region. `get_config` lists the models this version knows. |
| `media API error [SetLimitExceeded]` | Ark's "Safe Experience Mode" usage cap for that model. Raise or close it on the Ark console's model-activation page. |
| `video task … did not finish within Ns` | The clip was still rendering. The message carries the task id, so you can query it instead of paying for a second render — or raise `videoTimeoutMs`. |
| `video task … reported a status this version does not know` | A state the server will not guess at. Update the server rather than retrying blindly. |
| A video tool call is cut off by your client | Raise its tool timeout. The clip legitimately takes minutes; the row above uses `900000`. |
| `ignored: <key>` in `get_config` | A config key that is not a setting — usually a typo, so it changed nothing. |
| `format: env assignments — legacy` | The file is in the old `KEY=value` style. It still works; rename it to `config.yml` whenever you like. |

## What video can and cannot do

Text to video, one clip per call. Reference images and videos (image-to-video, extend, edit) are not
supported: each of those changes the request contract, and what is not implemented should not look
like it is.

## Development

Tests are offline — no network, no API key, no spend:

```bash
node --test tests/*.test.mjs
```

## License

MIT — see [LICENSE](LICENSE).
