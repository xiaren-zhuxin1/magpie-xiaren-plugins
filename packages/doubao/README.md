# 豆包（Doubao）作为 magpie provider

把本机已登录的**豆包桌面客户端**接成 magpie 的一个 provider：在 Providers 里像
CodeArts、WorkBuddy 一样出现一行，模型可选，流式、并发、多轮、错误归一，都走
magpie 的网关。

```
OpenAI / Anthropic / Codex …  →  magpie gateway 127.0.0.1:3425
                              →  this plugin（provider doubao-web）
                              →  CDP → 豆包客户端里的 https://www.doubao.com 页面
                              →  /samantha/chat/completion（SSE）
```

## 为什么不是普通 HTTP 请求

实测（2026-11-21）：同一套 cookie、同样的 query 与 header，

| 客户端 | `/samantha/thread/list` |
| --- | --- |
| PowerShell `HttpClient` | `710012001 登录已过期` |
| `curl.exe` | `710010202 系统错误` |
| **豆包客户端内的 doubao.com 页面** | **`code: 0` + 真实会话列表** |

豆包按「客户端进程 + TLS/HTTP2 指纹」放行 `samantha/*`。所以本插件不在 Bun 里
直接发请求，而是经 CDP 把 `fetch` 放进已经登录的客户端页面，再把 SSE 帧转成
OpenAI 流。对 magpie 而言，它和 codearts 是同一类 provider。

## 安装

```bash
magpie plugin add C:\magpie-community-plugin\packages\doubao
magpie plugin login doubao-web        # 随便填一个（API key 形式，内容不用真）
magpie providers                      # doubao-web 3 个模型
```

## 前置：客户端要带调试端口

插件默认连 `127.0.0.1:8333`。客户端已在跑时，用调试端口重启它：

```powershell
taskkill /IM Doubao.exe /F
& "$env:LOCALAPPDATA\Doubao\Application\app\Doubao.exe" --remote-debugging-port=8333
```

或者先全部关掉，让插件自己拉起（它会带 `--remote-debugging-port`）。

客户端里要有一个 `https://www.doubao.com` 页面（打开一次对话窗口即可）。

## 用

```bash
magpie codex doubao-web/doubao-auto     # 或 claude / gemini / opencode …
```

或直接打网关：

```bash
curl http://127.0.0.1:3425/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"doubao-web/doubao-auto","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

## 配置

| 环境变量 / 插件选项 | 默认 | 作用 |
| --- | --- | --- |
| `DOUBAO_APP` | `%LOCALAPPDATA%\Doubao\Application\app\Doubao.exe` | 客户端可执行文件 |
| `DOUBAO_DEBUG_PORT` / options.port | `8333` | CDP 端口 |
| `DOUBAO_BOT_ID` | `7338286299411103781` | 默认 bot（豆包主智能体） |
| `DOUBAO_CONVERSATIONS` | `~/.config/magpie/doubao-web-conversations.json` | 会话映射 |
| options.maxConcurrency | `3` | 并发上限 |

## 两种模式（都支持）

模型列表来自客户端的模型菜单（`brief_list` 的 `menu_conf.item_list`），每一项带 `default_mode`，插件据此分流：

| `default_mode` | 模式 | 请求 | 模型落在哪 |
| --- | --- | --- | --- |
| `3` | **工作模式** | `POST /chat/completion`（body：`client_meta / messages / option / chat_ability / user_context / ext`） | `option.conversation_init_ext.model_item_key` + `mode_id: "3"` + `reasoning_effort` |
| `1` | 对话模式 | `POST /samantha/chat/completion`（body：`messages / completion_option / conversation_id / bot_id`） | `bot_id`（默认 bot） |

SSE 也不同：

```
工作模式  命名事件  event: SSE_ACK / STREAM_CHUNK / CHUNK_DELTA / SSE_REPLY_END
                    CHUNK_DELTA 的 data.text 是增量；STREAM_CHUNK 的 patch_op 里
                    block_type=10000 的 text_block.text 也是增量（老会话走这条）
对话模式  data: {"event_type":2002|2010|2001|2003,"event_data":…}
```

实测（本机，2026-11-21）：

| 模型 | 模式 | 结果 |
| --- | --- | --- |
| `person-deepseek-v4-1-flash-261017`（DeepSeek V4.1 Flash） | 工作 | “你好” 3.9 s |
| `9`（工作任务 Auto） | 工作 | “你好” 3.6 s |
| `person-kimi-k3-261111`（Kimi K3，流式） | 工作 | “豆包呀” 5.7 s |
| `0`（快速） | 对话 | “你好” 3.2 s |

## 工具调用（文本协议，默认开）

豆包不接受 OpenAI 的 `tools`，所以插件用文本协议模拟：

1. 请求里带 `tools` 时，把工具清单（name / description / parameters）拼进首条 user；
2. 模型按提示输出 `<tool_call>{"name":…,"arguments":{…}}</tool_call>`；
3. 插件解析出来，还原成 OpenAI `tool_calls`（`finish_reason: "tool_calls"`），正文里的标签剥掉；
4. 下一轮 `role: "tool"` 的结果会被压成一条消息发回同一 conversation。

模型行因此声明 `tool_call: true`。想关掉：`magpie plugin options doubao '{"toolsProtocol":false}'`。

**遵循率实测**（3 模型 × 5 任务 = 15 次，含一次“不需要工具”的误触发检测）：

| 指标 | 结果 |
| --- | --- |
| 工具名命中 | 15/15 |
| 参数正确 | 15/15 |
| 坏 JSON | 0 |
| 闲聊误触发 | 0 |
| 多工具任务（读文件 + 查天气） | 两个调用都给出 |

**闭环实测**（工作模式，流式）：

```
R1 stream finish="tool_calls"  calls=[{name:"get_weather",args:'{"city":"北京"}'}]
R2 stream finish="stop"        content="北京当前气温 3℃，天气晴。"   （带 tool 结果）
```

已知限制：

- **对话模式（快速/专家）的 tool 结果轮会 400**（samantha 接口不接受这种续聊形态）；工具调用请用**工作模式模型**（`9`、`5`、`seed-lite-7b`、`person-*`）。
- 工作模式首轮偏慢：`reasoning_effort` 为 `high` 时 30 s 上下，`low/medium` 明显更快。
- 模型有时会“先答一句再调用”，正文与 `tool_calls` 会同时出现。

## 思考等级（variants）

`brief_list` 每个模型都带 `reasoning_effort_config.option_list`，名字是中文、`level` 是数字：

| 模型 | 等级 |
| --- | --- |
| 快速 / 专家 / 工作任务 Auto / Pro / 豆包 2.1 Lite | 低:3 · 中:4 · 高:5 |
| DeepSeek V4.1 Flash / V4 Pro、Kimi K3 / K3.1 Pro、Qwen 3.8 | 低:3 · 中:4 · 高:5 · 极高:6 · 最高:7 |
| GLM 5.3 / GLM 5.3 Flash | 低:3 · 高:5 · 最高:7 |
| Qwen 4 Max | 低:3 · 高:5 · 极高:6 |

插件把它们写成 magpie 模型行的 `variants`（键 `low/medium/high/xhigh/max`，值是 `{ reasoning_effort: "<level>" }`），请求时映射回来：

```
magpie 收到 reasoning_effort:"max"
  → 插件 effortOf() 取 "7"
  → 工作模式 option.conversation_init_ext.reasoning_effort = "7"
  → 对话模式 completion_option.reasoning_effort = "7"
```

实测 `{"reasoning_effort":"max"}` 的请求体里确实是 `"reasoning_effort":"7"`。

## 错误语义

| 上游表现 | 回给 magpie |
| --- | --- |
| `login invalid` / `Invalid User ID` / `7100120xx` | **401** login_invalid（magpie 会换账号/failover） |
| 无权调用该模型 / `TM.000010051` | **403** model_forbidden |
| 会话不存在 / conversation invalid | **404** conversation_lost |
| 限流 / too many requests | **429** rate_limited |
| sandbox / 云电脑未就绪 | **503** sandbox_not_ready（可重试） |
| `710010202 系统错误` 及其它 | **502** client_error |

同一段对话前缀的请求在插件内排队（`enqueue(prefixKey)`），避免同一 `conversation_id` 并发被服务端按 index 拧乱；客户端 abort 时通过 `window.__magpieDoubaoAbort[id]()` 真正取消页面里的 fetch。

## 能力与边界（实测）

| 项 | 结果 |
| --- | --- |
| 文本对话，流式 | ✅ 3–6 s，工作模式首包稍慢 |
| 多轮 | ✅ 按 messages 前缀哈希复用 `conversation_id` / `conversation_id`；匹配不上时把历史压进首条重建 |
| 并发 | ✅ 单页面并行多请求，各自独立会话 |
| 思考等级 | ✅ `variants` 已按客户端菜单生成，`reasoning_effort` 透传到两份协议 |
| `system` 指令 | ⚠️ 服务端忽略 `role: system`，插件把它拼进首条 user |
| 工具调用 | ❌ 豆包客户端工具是其自家 `tool/*` + RPA/云电脑协议，不是 OpenAI `tools`；模型行声明 `tool_call: false` |
| 工作模式的云电脑 / 工具链 | ❌ 不接（只取模型输出，不驱动它的 sandbox） |
| 图片 | ❌ 暂未实现 |
| token 用量 | ⚠️ 网关显示 0（仅估算） |
| 依赖 | 豆包客户端在跑 + 调试端口 + 已登录 |

## 与 `doubao-work` 的区别

`doubao-work` 也是 CDP，但它**点 GUI**：新建「工作任务」、切云电脑、从渲染出来的
消息里逐字抄回复，所以单并发、纯文本、约 7 次/秒读屏。本插件只把 CDP 当传输层，
在页面里直接 `fetch` 并解析 SSE 帧 —— 同样是客户端，但拿到的是增量 token、真会话
和多路并发。

## 许可

MIT。非官方用法：豆包客户端改版可能让选择器/接口失效，账号风险自负。