# dsh-media-mcp

中文 | [English](README.md)

一句话，变成本机的一张图、一小段视频或一段语音。

`dsh-media-mcp` 是一个很小的 [MCP](https://modelcontextprotocol.io) server：你的 AI 客户端调用它，
它调用你配置的媒体服务，结果就作为**普通文件**落到磁盘上，随手就能打开。它还把**自身设置也做成工具**，
所以换模型、换尺寸、换输出目录都是聊天里说一句的事 —— 不用去找设置界面。

任何 MCP 客户端都能用；为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）
而做，并在其上实测。

## 能做什么

直接说就行：

- **「画一只在夕阳下冲浪的柯基。」** —— 返回一个已保存 JPEG 的绝对路径。
- **「来一段五秒钟的短片：纸船顺着雨后的街道漂走。」** —— 几分钟后得到一个视频（实测三到四分钟）。
- **「把这段话读出来。」** —— 得到一段合成语音的 MP3。
- **「你现在用的是哪些模型？」** —— `get_config` 回答。
- **「换成 Seedream 4.0，2048x2048。」** —— `set_config` 记下来，下一张就按这个来。

| 工具 | 作用 |
| --- | --- |
| `generate_image` | 按提示词生成图片、落盘，返回文件路径。可用 `model` / `size` / `outputDir` 单次覆盖 |
| `generate_video` | 生成一小段视频，**仅支持文生视频**。可用 `model` / `ratio` / `duration` / `outputDir` 单次覆盖。慢且计费，请明确要求再调用 |
| `generate_speech` | 把文本合成为语音、落盘，返回文件路径。可用 `model` / `voice` / `format` / `outputDir` 单次覆盖。计费，请明确要求再调用 |
| `get_config` | 显示当前设置、Key 是否已配、以及已知模型 |
| `set_config` | 改设置并保存，下一次调用即生效 |

图片模型对尺寸有下限时，它会在**花钱之前**拦住你，并告诉你该用多大：

```
model doubao-seedream-4-5-251128 requires at least 3686400 pixels, but 1024x1024 is only
1048576. Retry with a larger size such as 1920x1920.
```

## 要求

Node.js `^22.19.0 || >=24.0.0`。无依赖、无构建步骤：克隆下来就能跑。

## 安装

### 1. 拿到 API Key

内置的是火山引擎方舟预设（豆包 / Seedream 出图、Seedance 出视频）。出图走 OpenAI images 接口，
出视频走方舟的任务式接口；换别家也行 —— 在 `src/providers.mjs` 里加一项即可。

语音是**另一套服务、另一个 Key**。方舟的 Key 在那边会被拒（报 `Invalid X-Api-Key`），所以要用语音合成，
得去豆包语音控制台另建一个 Key：<https://console.volcengine.com/speech/new/setting/apikeys>。
只用出图/出视频的话不需要它，只有调 `generate_speech` 时才用得上第二个 Key。

### 2. 写配置文件

Key 就放这里。macOS / Linux 上是 `~/.config/media-gen/config.yml`，Windows 上是
`%APPDATA%\media-gen\config.yml`：

```yaml
provider: ark
apiKey: 你的方舟-key                 # 出图、出视频
imageModel: doubao-seedream-5-0-flash-260915
imageSize: 1024x1024
videoModel: doubao-seedance-2-5-260628
# speechApiKey: 你的语音-key         # 可选；不写则复用 apiKey
speechModel: seed-tts-2.0
speechVoice: zh_female_vv_uranus_bigtts
speechFormat: mp3
# outputDir: "~/Pictures/generated"
```

写完 `chmod 600`。不想手打就复制 [`config.example.yml`](config.example.yml)；想放到别处，用
`MEDIA_GEN_CONFIG` 指过去。

以 `~` 开头的值要加引号，否则 YAML 会把它读成「空」。

### 3. 让客户端指向它

任何 MCP 客户端：

```jsonc
{
  "mcpServers": {
    "media": {
      "command": "node",
      "args": ["/绝对路径/dsh-media-mcp/src/server.mjs"],
      "cwd": "/绝对路径/你的工作区"
    }
  }
}
```

DeepSeek Harness —— 往 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 追加这一条。
`@deepseek-ai/dsh-mcp-client` 是 `dsh` 自带的，**不需要安装任何东西**：

```yaml
- insert:
    - id: mcp-media
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: media
        command: node
        args:
          - /绝对路径/dsh-media-mcp/src/server.mjs
        cwd: /绝对路径/你的工作区
        toolCallTimeoutMs: 900000   # 出视频要等好几分钟，默认的 60s 远远不够
        failOnStartupError: true
```

工具会以 `mcp__media__generate_image`、`mcp__media__generate_video`、`mcp__media__generate_speech`、
`mcp__media__get_config`、`mcp__media__set_config` 出现。

**不需要重启 app**：加了 row 的 profile 在同一会话里就能用上；生成的文件跟随 `cwd`，所以把 `cwd`
指向你希望文件落盘的那个工作区。（但改 server 自己的 `src/*.mjs` 不一样：那段代码每个进程只加载一次，
得重启 server 或 app。）

## 文件落在哪

| 产物 | 默认位置 | 覆盖方式 |
| --- | --- | --- |
| 图片 | `<workspace>/image_output/` —— 每个结果一个 `img-YYYYMMDD-HHMMSS.jpg` | `outputDir`（配置或单次参数） |
| 视频 | `<workspace>/video_output/` —— 每个结果一个 `vid-YYYYMMDD-HHMMSS.mp4` | `outputDir`（配置或单次参数） |
| 语音 | `<workspace>/speech_output/` —— 每次一个 `speech-YYYYMMDD-HHMMSS.mp3` | `outputDir`（配置或单次参数） |

`<workspace>` 就是你给 server 的 `cwd`。一旦设置了 `outputDir`，**三种产物都会写到那一个目录**；
不设则三者分开。`media-gen outdir` 会把所有目录都打印出来；配置里的 `~` 会展开。

工具返回的是**路径**而不是文件数据，所以再大的图或视频也不会灌满对话 —— 用任何软件打开即可；在
DeepSeek Harness 里也可以把图片路径交给 `read_image` 工具。

## 设置

下面每一项都可以用 `set_config` 改，也可以直接编辑文件 —— 文件在**每次调用时都会被重读**，两种方式
都无需重启。

| 设置 | 配置文件里 | 环境变量 | 说明 |
| --- | --- | --- | --- |
| Provider | `provider:` | `MEDIA_GEN_PROVIDER` | 用哪个预设，默认 `ark` |
| API Key | `apiKey:` | `MEDIA_GEN_API_KEY` | 出图/出视频必填。**任何工具都不会打印它** |
| API 地址 | `baseUrl:` | `MEDIA_GEN_BASE_URL` | 覆盖预设里的地址 |
| 图片模型 | `imageModel:` | `MEDIA_GEN_IMAGE_MODEL` | 出图的默认模型 |
| 图片尺寸 | `imageSize:` | `MEDIA_GEN_IMAGE_SIZE` | 默认尺寸，`WxH` |
| 视频模型 | `videoModel:` | `MEDIA_GEN_VIDEO_MODEL` | 出视频的默认模型 |
| 语音 Key | `speechApiKey:` | `MEDIA_GEN_SPEECH_API_KEY` | 只给语音服务用；不设则复用 `apiKey` |
| 语音模型 | `speechModel:` | `MEDIA_GEN_SPEECH_MODEL` | 语音资源 id，默认 `seed-tts-2.0` |
| 发音人 | `speechVoice:` | `MEDIA_GEN_SPEECH_VOICE` | 音色 id，默认 `zh_female_vv_uranus_bigtts`；账号已开通的音色都可用 |
| 语音格式 | `speechFormat:` | `MEDIA_GEN_SPEECH_FORMAT` | `mp3` / `pcm` / `ogg_opus`，默认 `mp3` |
| 图片超时 | `imageTimeoutMs:` | `MEDIA_GEN_IMAGE_TIMEOUT_MS` | 一次出图最多等多少毫秒，默认 `180000` |
| 视频超时 | `videoTimeoutMs:` | `MEDIA_GEN_VIDEO_TIMEOUT_MS` | 整段视频流程最多等多少毫秒，默认 `720000` |
| 语音超时 | `speechTimeoutMs:` | `MEDIA_GEN_SPEECH_TIMEOUT_MS` | 一次语音合成最多等多少毫秒，默认 `120000` |
| 输出目录 | `outputDir:` | `MEDIA_GEN_OUTPUT_DIR` | 同时覆盖上面所有默认目录；开头的 `~` 会展开 |

环境变量优先于配置文件。想知道有哪些模型、各自约束是什么，跑 `media-gen models`，或问 `get_config`。

画面比例与时长是**单次参数**（`ratio` / `duration`，默认 `16:9` 与 `5` 秒），因为它们直接决定一次
生成的费用；语音的 `voice` 与 `format` 同理。

### 超时

实测一段 5 秒片要等约 4 分钟，所以这些等待时间**由你设置**，不是写死在代码里的常量：

```yaml
imageTimeoutMs: 300000     # 出图慢的 provider
videoTimeoutMs: 1200000    # 更长的片段
speechTimeoutMs: 180000    # 很长的文本
```

`set_config` 用同样这些键写入；命令行是 `media-gen config set videoTimeoutMs=1200000`。也可以**只给
单次调用**覆盖：三个生成工具都接 `timeoutMs`，CLI 接 `--timeout-ms 1200000`。当前生效值会在
`get_config` 里报出来。

上限是 `3600000`（一小时）。超过就**直接报错而不是偷偷改小** —— 能挂一小时本身就是该被看见的配置错误。

**客户端的工具超时要大于这里的值。** server 只能结束自己的等待；如果你的 MCP 客户端先放弃，你收到的
是它的报错，而不是那条带任务 id 的信息。上面 DSH 的 row 用 `toolCallTimeoutMs: 900000` 就是这个原因。

旧版本写的 `MEDIA_GEN_API_KEY=...` 风格配置文件**仍然可用**，随时改名成 `config.yml` 就行。

## 命令行

同一套东西也带一个小 CLI。把 `bin/media-gen.mjs` 软链到 `PATH` 上：

```bash
media-gen env                            # 当前生效的配置
media-gen models                         # 图片模型（含尺寸下限）与语音模型
media-gen outdir                         # 图片、视频、语音分别会写到哪
media-gen img "一只橘猫在窗台晒太阳，写实摄影"
media-gen img "赛博朋克小巷" -s 2048x2048 -o alley.jpg
media-gen video "纸船顺着雨后的街道漂走" --duration 5
media-gen speech "你好，这是一段语音合成测试。"
media-gen speech "Read me aloud" -v zh_female_vv_uranus_bigtts -f mp3 -o hello.mp3
media-gen config set imageModel=doubao-seedream-4-0-250828
media-gen config set videoModel=doubao-seedance-1-0-pro-250528
media-gen config set speechApiKey=你的语音-key        # 只写不读，和工具一样
media-gen key                            # 脱敏显示；原始 Key 无法打印
media-gen serve                          # 在 stdio 上运行 MCP server
```

## 排错

| 现象 | 含义 |
| --- | --- |
| `no API key configured` | 配置文件里的 `apiKey:` 缺失或为空 |
| `model … requires at least N pixels` | 该图片模型有尺寸下限 —— 用报错里建议的那个尺寸 |
| `media API error [InvalidEndpointOrModel.NotFound]` | 模型在你的账号或区域不可用。本版本收录的模型可用 `get_config` 查 |
| `media API error [SetLimitExceeded]` | 撞上方舟「安全体验模式」的额度上限。到方舟控制台「模型开通」页调高或关闭 |
| `speech API error [45000010]: Invalid X-Api-Key` | 语音服务拒绝了这个 Key。方舟 Key 在那边不能用：把 `speechApiKey:` 设成豆包语音控制台建的 Key |
| `speech API error [55000000]: resource ID is mismatched with speaker related resource` | 该音色不属于当前配置的语音资源。音色与资源 id 都要对着语音控制台核一遍 —— 错的可能是不论哪一个 |
| `speech API returned no audio data` | 服务返回了但没有音频 —— 通常还是凭据或资源问题换了个样子。报错里带了原始响应 |
| `video task … did not finish within Ns` | 视频还在渲染。报错里带了任务 id，直接查它，别为第二次渲染再付一次钱 |
| `video task … reported a status this version does not know` | 出现了本版本不愿瞎猜的状态。升级 server，而不是盲目重试 |
| 视频调用被客户端掐断 | 调高客户端的工具超时。几分钟是正常的；上面的 row 用的是 `900000` |
| `get_config` 里出现 `ignored: <键名>` | 这个键不是设置项，通常只是拼错了，所以什么也没改 |
| `format: env assignments — legacy` | 配置文件是旧的 `KEY=value` 写法。仍能用，随时改名成 `config.yml` |

## 视频能做什么、不能做什么

**文生视频**，一次一条。参考图 / 参考视频（图生视频、续写、编辑）**没有实现**：这些都会改变请求契约，
没做的东西就不该看起来像做了。

## 语音能做什么、不能做什么

**文生语音**，一次一个文件，走的是服务方的流式接口 —— 但整段收齐后一次写盘，所以不会留下半截文件。
音色、格式、采样率是设置项；语速、音调、音量、情绪控制、声音克隆、语音转文字**都没有实现**，
所以不会有任何接口假装接受它们。

## 开发

测试**完全离线** —— 不联网、不需要 Key、不花钱：

```bash
node --test tests/*.test.mjs
```

## 许可

MIT — 见 [LICENSE](LICENSE)。
