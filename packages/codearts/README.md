# magpie-codearts-plugins

CodeArts（华为云码道）认证 provider 插件，用于 [magpie](https://usemagpie.ai) / OpenCode。

## 来源

本项目从 `magpie-community/plugins` 的 `packages/codearts`（提交 `8c7e8f66`）提取，
并包含以下经本机实践验证的改动：

- **登录指纹可配置**：OAuth 授权 URL 的 `plugin-name` / `plugin-version` / `theme`
  由写死常量改为「环境变量 → 本机 IDE 认证扩展 manifest → 兜底」三级解析，全部 URL 编码。
  运行时抓包确认真实 IDE 发送 `plugin-name=snap_AIIDE`、`plugin-version=5.4.2`。
- **X-Language 全局收敛**：所有 CodeArts snap-access 签名请求统一在 `signFor()` 签名后注入
  一个 `X-Language`（默认 `zh-cn`，环境变量 `MAGPIE_CODEARTS_LOCALE` 覆盖），跟随 IDE 语言
  而非站点。真实内核 chat 的 `[header-debug] full headers` 证实：国内/国际站中文 IDE 均为 `zh-cn`。
- **请求头对齐真实内核**：chat 请求删除 `lang` / `Chat-Id` / `Session-Id`，会话只认 `x-ot-session-id`。
- **工程清理**：日志形状改为仓库惯例的 `{ body: { service, level, message } }` 并补 `.catch`；
  删除死字段 `chatId`；版本升至 0.3.24。

## 验证状态

- 225 个单元测试中 224 通过，1 个为 Windows 临时目录清理的已知 flaky（已用未改动的 HEAD 基线复现证明与本改动无关）。
- 运行时实测：内核端口发现、`/v1/init` 配置、真实 OAuth authorize URL、真实 chat 请求头均已抓包确认。
- 详见同目录或上游归档的 `CodeArts_运行时验证报告_2026-11-17.md`。

## 安装（从本仓库）

```sh
magpie plugin add <本仓库路径或 clone URL>
magpie plugin login codearts
```

## License

MIT — 见 [LICENSE](LICENSE)。原作者与贡献者见 [README.md](README.md) 的 Credits 一节。

---

# @magpie-community/opencode-codearts-auth

Signs in to **Huawei Cloud** and serves two providers in OpenCode and magpie:

- **CodeArts** (华为云码道, the CodeArts Agent coding plans: Trial, personal and enterprise
  credit plans) — provider id `codearts`: GLM, DeepSeek, openPangu and more.
- **OfficeAce** (华为云 AgentArts / MaaS) — provider id `officeace`: GLM, DeepSeek, Qwen, Kimi
  and 盘古 models, its credit buckets and its daily check-in.

Each card signs in on its own: the two providers hold separate records with separate Huawei Cloud
refresh tokens, because an STS refresh token is spent once — two records sharing one would sign
each other out. The same Huawei Cloud IAM account works for both, and a credential issued for one
endpoint also signs the other vendor's API (measured, see below), so signing in twice costs two
clicks and nothing else. OfficeAce was its own package (`officeace-auth`) until 0.3.0; accounts
signed in there are read from where magpie already keeps them and keep working — no second
sign-in for those.

> **Unofficial.** This package is not affiliated with, authorized or endorsed by Huawei,
> Huawei Cloud or CodeArts; their names and marks belong to their owners. It talks to the
> non-public APIs the CodeArts client uses and identifies itself the way that client does
> (including claiming the daily free benefit and check-in), which may not be allowed by Huawei
> Cloud's terms of service, and those APIs may change at any time. Use it at your own risk,
> including the risk of restrictions on your account.

## Install

```sh
magpie plugin add @magpie-community/opencode-codearts-auth
magpie plugin login codearts      # CodeArts; the OfficeAce card signs in separately
```

or install it from magpie's Plugins tab and sign in there. **Coming from `officeace-auth`?**
Nothing to do: the account is stored under the same provider id (`officeace`) and in the same
credential shape, so it is read as it is. Remove the old package first (both cannot serve one
provider id: magpie asks which one if they are both installed).

## Sign-in

**Sign in with Huawei Cloud** opens Huawei Cloud's consent page. The plugin listens on a
loopback port (`127.0.0.1`, ≥ 10000) for the redirect and exchanges the code at Huawei Cloud
STS — a PKCE flow whose token requests carry an ES256 DPoP proof, as the CodeArts client does.
STS answers with temporary AK/SK/security-token credentials and a refresh token. The callback
server takes one GET to `/oauth/callback`, exactly; one that comes back without a code (the
portal's error) fails the sign-in at once.

**Where it is kept:** the whole credential (AK/SK/security token, expiry, refresh token, the
PKCE verifier and the DPoP private key) is a JSON string in the account's `access` field, in
magpie's (or OpenCode's) own account store. `auth.refresh` renews it 30 minutes before it
expires, reusing the same verifier and DPoP key; a stale credential met on a request
(`401`, `APIG.0602`) is renewed once and the request sent again. A refresh token is spent once
per account, however many loaders ask; a renewal that only fails for now (STS unreachable)
answers `503` and keeps the sign-in, and only one STS turns away for good marks it.

**The card's name:** the account is shown by its **phone number** (`138****8000`, masked the way
the other magpie cards mask theirs), read once after signing in from Huawei Cloud IAM —
`GET https://iam.cn-north-4.myhuaweicloud.com/v3.0/OS-USER/users/{principal_id}`, signed with
the same temporary credentials — and kept on the credential as `user_phone`. The refresh token
names the signer only by IAM's own ids (`hw12323`, and the URN
`iam::<domain>:user:<name>`), which read as an ID nobody can tell apart from another account's;
the account name is the fallback when the phone can't be read, and the URN never is.

`accountId` is the account's identity — the URN, as before — and it never changes: magpie
keys the user's own name for the account, its proxy, model picks and a gateway key's list by
it, so a re-sign-in and a renewal give the same value back. The card's name is usage's `user`,
which shows `user_phone` once a sign-in or renewal has read it. IAM is *not* one of the hosts the plugin signs forwarded requests for
(`SIGNED_HOSTS`): the one phone read is made by the plugin itself, for that one URL.

**Sign in from the CodeArts Agent on this machine** (since 0.3.10, #998): when the CodeArts Agent
IDE is installed and signed in here, a second method takes its sign-in instead of a browser.
The IDE keeps it in its VS Code-style state database, key `huaweicloud.codearts-snap`
(`userInfoKey.originData`: AK/SK/security token, `domainId`, `expiresAt`, `stationType`):

| System | File |
|---|---|
| macOS | `~/Library/Application Support/codearts-agent/User/globalStorage/state.vscdb` |
| Windows | `%APPDATA%\codearts-agent\User\globalStorage\state.vscdb` |
| Linux | `$XDG_CONFIG_HOME/codearts-agent/User/globalStorage/state.vscdb` (else `~/.config/…`) |

`MAGPIE_CODEARTS_IDE_STATE` points it elsewhere. The plugin never opens or writes the IDE's file
with SQLite: it copies it (with its `-wal`/`-journal`) into a temporary folder, reads the copy and
removes it. A missing, unreadable or half-written file, or one without a whole credential, is
"unknown": the method isn't offered, or the sign-in fails saying why (never with a secret). The
credential is checked once (`snap-manager/v1/current/user` on its station) and kept like a
browser sign-in's, but it has no refresh token: it is renewed by reading the IDE's file again
once the IDE has renewed it, never through STS. Until then a renewal only fails for now
(`503`, the sign-in kept); signing in to another account in the IDE doesn't change this one.
The account is the IDE's `domainId`.

**The international station** (since 0.3.10, #998): a credential from the international
CodeArts (`stationType: "international"`) is sent only to
`snap-access.ap-southeast-1.myhuaweicloud.com`, and a mainland one only to the mainland hosts.
Its token package shows as one window, `usage_token_num` of `package_token_amount` from
`start_date` to `end_date`, and the plan is `package_name_en`. The international station has no
`opengw` endpoints, credit batches or daily check-in, so the plugin asks none of them there
(check-in answers "inactive"). Not tried yet with a real international account: chats go to
`/api/v2/chat/completions` there as on the mainland, and the model list falls back to the
built-in one when the station doesn't answer it.

**International browser sign-in** (since 0.3.17, #1090): "Sign in with Huawei Cloud
(International)" opens Huawei Cloud's international login (`auth.huaweicloud.com`,
`site=intl`), which goes on to the international portal's authorize page
(`codearts.ap-southeast-1.huaweicloud.com/portal/authorize`). The code is exchanged at the same
STS endpoint, and the credential is kept as an international one, through every renewal. It
skips the mainland-only phone and OfficeAce reads. Not tried yet with a real international
account.

## Models

The account's live list: CodeArts' builtin models, plus the free models of its daily benefit
once today's benefit has been claimed (`POST /api/v1/benefit/claim`, once a Beijing day, as the
client does; a `benefit not found` on a day not yet claimed claims it too). Each model's credit
rate (the client's 「消耗系数」) is reported as magpie's `rate`,
with its reasoning flag and limits, from the account's main agent (`build`) model list. Before
signing in, a short built-in catalog stands in. Since 0.3.2 each model keeps the name CodeArts
gives it: a dated model such as `deepseek-v4.1-flash-1017` is its own model (its own off-peak
rate), shown as `DeepSeek-V4.1-Flash-1017`, not folded into `DeepSeek-V4.1-Flash` (#677).

## Requests

- Every request is signed with Huawei's SDK-HMAC-SHA256 using the temporary credentials, and
  only for CodeArts' own hosts, `snap-access.cn-north-4.myhuaweicloud.com` and
  `opengw.developer.huaweicloud.com` (and, for an international credential, only
  `snap-access.ap-southeast-1.myhuaweicloud.com`): a request anywhere else (an overridden `api`) is refused
  before the credentials leave, and no signed or token request follows a redirect.
- The gateway allows 3 concurrent sessions per account and tells them apart by
  `x-ot-session-id`; the plugin sends one stable session id per account (and a fresh trace per
  request) like the client, keeps at most 3 chats in flight per account, retries
  `TM.00001041` with backoff, and waits in the gateway's own queue (`429` +
  `queue-status: queued`) the way the client does. Only then does magpie get a `429`. Since
  0.2.3, when magpie has another candidate after this request (`x-magpie-fallback: 1`), a queued
  request leaves the queue at once and answers `503` with the queue's `Retry-After`
  ("CodeArts queued the request; try again in 20s"), and magpie asks the next.
- Chats always go upstream as streams — CodeArts meters only streamed answers — and are folded
  back into one `chat.completion` when the caller asked for JSON.
- `thinking: { type: "enabled" }` is sent unless the caller set it, so the reasoning lands in
  `reasoning_content` and `content` is only the reply.
- The reasoning level a caller names in `reasoning_effort` is sent as it is, and the plugin asks
  for no thinking of its own then (`thinking: enabled` would overrule the level). A level the model
  does not take is dropped rather than left to turn the request away — one it does not take is a
  `400` ("reasoning_effort must be none or low or medium or high or xhigh or max"). "No thinking"
  (`none`, `off`) is sent as `thinking: { type: "disabled" }`, which is what actually stops it:
  `reasoning_effort: none` alone still thinks.
- The levels each model takes are declared in the model row's `variants` (measured 2026-11-04;
  they differ per model — `glm-5.3-flash` turns `medium` and `xhigh` away, and the two Kimis think
  at `none` anyway, so they take no "no thinking" level), so a host offers the levels that work
  and shows the thinking as its own row instead of as the answer.
- Errors the gateway puts inside a `200` stream (spent quota, unknown model) come back as
  `429` / `400` / `502` with the vendor's words. The `codearts/` prefix is stripped and output
  budgets are clamped to 65536.
- CodeArts takes tool names of up to 64 characters. A longer one (an MCP tool such as
  `mcp__plugin_android-emulator_android-emulator__android_discover_project`) goes as its first
  55 characters, `_` and 8 hex of its SHA-256, and the tool calls in the answer, streamed or
  not, carry the agent's own name again.
- Every model is listed as text only (`modalities.input: ["text"]`, `image: false`): CodeArts
  answers an image with `InferHub.001001020.406` "The request model is not multimodal". Since
  0.2.4 magpie is told so, and describes an image for the model or leaves it out. That refusal,
  inside a `200` or with any status, comes back as a `400`, not a `502` an agent would ask again.
- Every CodeArts snap-access signed request carries one `X-Language`, set **after** signing so it never enters
  `SignedHeaders`. Since 0.3.24 it follows the IDE's language (default `zh-cn`), not the
  station: the real kernel sends `zh-cn` on the international station too when the IDE is in
  Chinese. Override with `MAGPIE_CODEARTS_LOCALE` (e.g. `en-us`) for an English IDE. Chat sends
  no `lang`, `Chat-Id` or `Session-Id`; sessions key on `x-ot-session-id` alone.
- **The client identity** (since 0.3.25). Every chat request also carries what the real kernel
  sends about itself, measured from its own `[header-debug] full headers` on 2026-11-17:
  `x-ot-client-type: IDE`, `x-ot-client-version`, `plugin-name: codemate_vscode`,
  `plugin-version`, `ide-name: VSCode`, `ide-version`, an empty `x-ot-function`, `model-id` /
  `model-name`, a fresh `user-msg-id` and `created-time`, and the host's private IPv4 as
  `client-ip`. All are unsigned (set after signing, like the headers above), so a signature
  never covers them. The version is the IDE's own build: read from the installed IDE's
  `resources/app/product.json` when `MAGPIE_CODEARTS_IDE_DIR` is set, else
  `MAGPIE_CODEARTS_CLIENT_VERSION`, else the snapshot this release shipped with — set the env
  var, or the plugin keeps claiming that build after an IDE upgrade.
  `MAGPIE_CODEARTS_CLIENT_IP=off` leaves `client-ip` off (behind a proxy the address this host
  sees is not the one the request leaves from).
- **One conversation is one upstream session** (since 0.3.25). The real kernel sends its
  conversation id as `x-ot-session-id`, so each conversation uses one of the account's three
  sessions instead of the whole account sharing one id. An account keeps a pool of at most
  three ids: a conversation keeps its own while active and for `90s` after going quiet (the
  gateway holds a finished session for about a minute), and only then may its slot be handed
  to another conversation — so a fourth conversation never opens a session the gateway would
  refuse (`TM.00001041`).

## Usage and check-in

- Usage: the credit buckets of `snap-manager/v1/statistics/plugin` (only the package total
  pauses the account; the basic / on-demand / bonus buckets are shown aside) and the free daily
  token pool.
- When each credit batch expires is read from the CodeArts console's own calls
  (`snap-manager/v1/package/credit/page`, `v1/ops/credit/*`); when those can't be read, the
  plugin falls back to a small ledger of the check-ins it claimed,
  `~/.config/magpie/codearts-checkins.json` (or `MAGPIE_CODEARTS_LEDGER`), each check-in until
  the date its claim named. This part is still being checked against more accounts — trust the
  CodeArts console where they differ.
- A window's `runsOutAt` / `runsOut` is only credit its own remainder holds: none when the bucket
  is empty, never more than it has left, and the total's is the buckets' own. The ledger can't
  tell what was spent of a check-in, so from it the amount is the vendor's own
  `package_credit_expiring_amount` (each window's `expiring`), and with none said there is no
  lapse.
- `auth.checkin`: the client's 「限时福利 → 每日领取」 — `GET /v1/ops/delivery?channel=IDE`,
  `POST /v1/ops/claim`, then `POST /v1/ops/confirm` when the claim answers an id. A claim whose
  confirm failed is kept in that ledger for the day and confirmed at the next check-in; one the
  client leaves unconfirmed (`id: null`) never is. Every claimable campaign whose title is a
  daily one (`签到` / `每日`) is claimed: the ordinary daily check-in and a contest's daily
  check-in beside it (such as the 小红书 Skill 创新赛 daily 1000, 2026-11-11–12-05) are separate campaigns in that
  same list; a contest's one-time sign-up gift is left to the user. A contest check-in the
  account has not signed up for is not claimable, so it is skipped and the ordinary one is still
  claimed. The dates are the vendor list's own (`extra.endTime`), not hardcoded here, so the
  campaign stops being claimed when it ends. Turn on
  *Auto check-in* for CodeArts under **Settings → Usage → Plugins**.

## OfficeAce (the second provider)

**Signing in.** The officeace card offers the same 「Sign in with Huawei Cloud」 as the CodeArts
card, and it is the same account system: a CodeArts STS triple signs OfficeAce's subscription API
(V11-HMAC) and passes its CLAW permission check, and an OfficeAce triple signs CodeArts'
`snap-access` calls. But the two cards keep **separate records with separate refresh tokens** —
a sign-in writes only the card it was made on. A Huawei Cloud refresh token is spent once, so two
records holding one token would each sign the other out at its next renewal; one record per
sign-in is what keeps a CodeArts-only user from being asked to sign in again because of the
OfficeAce card. Sign in on the OfficeAce card to get an OfficeAce account.
A sign-in is the only thing that creates an OfficeAce account: a listing never adopts one from
another provider's record, so an account the user signed out of cannot come back by itself.

**From `officeace-auth`.** That package's records are read unchanged: the account is under the
same provider id and its `access` field holds the same JSON (`modelAppKey`, `securityToken`,
`dpopPrivateJwk`, `refreshToken` …). Its refresh token is still spent at the OAuth client it was
issued to (`pdp5_for_agentarts`), so those accounts keep renewing too.

**What a record is named, and what a renewal may touch.** `accountId` is the vendor's own stable
id — the IAM domain id, as the record `officeace-auth` wrote carried — and never the masked
phone: magpie hangs a user's own name for the account, its proxy and a gateway key off
`accountId`, so the phone belongs only in `usage().user` (#483, magpie#4416). A renewal never
renames an account: the stored `accountId` and `uid` stand exactly as written — the domain id, or
the phone `officeace-auth` 0.1.14 and later stored — and a value computed from the credential is
only filled in when the record has none. A new sign-in names its account by the domain id.

**A record is renewed only with its own refresh token.** The unit of coordination is the refresh
chain: the OAuth client a token was issued to plus the token's lineage (a rotation keeps its
parent's, so a record still holding the spent token is known to be on the same chain). Each card's
record holds its own refresh token, from its own sign-in, so it is a chain of its own and spends
its own token however many hooks ask.
An `officeace-auth` record beside a CodeArts record holds a token from another issuer
(`pdp5_for_agentarts` against `codearts-agent`), so it is another chain: it spends its own token,
keeps its own MaaS pair, and a renewal that fails fails — it is never handed another record's
credential. No record's renewal writes another one: a renewal writes only the record it was asked
to renew. That is deliberate — writing the new credential into the other record is exactly what
used to bring a removed account back.

**Models.** OfficeAce's catalog (`GET {maas}/v2/models`) is a registry, not a promise: 26 entries,
most of which answer `404 ModelArts.81009 Invalid model` at chat. The plugin cuts it down to the
billable list (`GET {subscription}/v1/model-token-rates`, 9 entries) and never lists three ids
measured to always 404. A rates read that fails keeps the last good table — an empty one would
put the un-callable ids back in front of the user. Before a sign-in a built-in table of 10 stands
in. Names carry the account's multiplier (`GLM-5.3 · x0.18`), and the vendor's trailing newline in
`model_name` is trimmed.

**Requests.** MaaS wants `Authorization: Basic base64(appKey:appSecret)`; the plugin rewrites the
SDK's Bearer header, strips the `officeace/` model prefix, and sends the request to the MaaS base
the account's own credential names (official direct when it names none). A `401` (or a `4xx`
naming the Basic pair) renews the credential once and sends it again — but only when the renewal
changed the pair; the same pair would get the same refusal. An account that signed in without
opening MaaS gets a `400` saying so, not an empty Basic header sent upstream.

**Usage and check-in.** `GET {subscription}/v1/subscription`: the total of all unexpired plan
buckets (`skus[].quotas`) and activity bonuses (`bonus_skus`) is the one routing window; each
bucket remains visible as an `aside` detail. A `.trial` bucket carries no expiry and gets none
invented; an expired bucket is folded away and takes no part in the active total. The total's
`runsOutAt` is the soonest still-funded bucket to expire, and `runsOut` is the remaining credit
that expires on that Beijing day. When every bucket has expired, a used-up total remains so the
account is paused instead of being routed without a limit. The check-in is
`POST {subscription}/v1/subscription/bonus/claim` once a Beijing day: a 2xx with no
`bonus_skus` is 「今日已无新增可领」 (`done`), not a failure. Turn on *Auto check-in* for OfficeAce
under **Settings → Usage → Plugins**.

**Known limits.**

- STS spends a refresh token once. Each card of this package signs in on its own and holds its own
  record and its own refresh token, so the two cards never affect each other. **A renewal writes
  only the record being renewed**, which is also why a record the user removed can never come
  back: no other record is written, whether it was listed, used, or not seen at all, and across a
  restart too. An old `officeace-auth` record likewise renews only along its own chain. Two
  separate magpie processes renewing the same account at the same moment still race; the loser
  asks again and is signed out only if the token stays spent.
- `officeace-auth` and this package cannot both serve the `officeace` provider id. Magpie asks
  which plugin serves it; remove the old one.

## Options

| Option | Default | What it does |
|---|---|---|
| `maxInflight` | `3` | chats in flight per account; it can only lower the vendor's cap of 3 sessions |
| `retryBudgetMs` | `150000` | how long to retry `TM.00001041` before answering `429` |
| `retryDelays` | `[2000,4000,6000,8000,10000]` | retry waits in ms (the last repeats) |
| `queueBudgetMs` | `300000` | how long to wait in the gateway's queue |
| `thinking` | `true` | `false` stops adding `thinking: { type: "enabled" }` |
| `sm4` | `true` | `false` stops sealing the chat body with SM4-GCM (see below) |

### SM4-GCM transport encryption (CodeArts Agent 26.11.200)

Since the 26.11.200 client, the kernel encrypts its `/api/v2/chat/completions`
body with SM4-GCM and asks for an encrypted SSE answer (measured from the
kernel: `Transport security hook enabled sm4=true`, encrypt paths
`["/api/v2/chat/completions"]`). Keys come from
`POST /api/v1/security/key-exchange`: the client sends an ECDH P-256 public key
and gets the server's back with a `keyId`; the SHA-256 head of the shared
secret is the SM4 key. A sealed request carries `X-Encrypt-Algo: sm4-gcm`,
`X-Encrypt-Key-Id`, `X-Encrypt-Iv`, `X-Encrypt-Tag` and `X-Encrypt-Ts`, sends
`application/octet-stream` (the Content-Type is part of the signature, so the
request is re-signed), and authenticates `${method}|${path}|${timestamp}` as
AAD. Each answer chunk is `iv:tag:ciphertext` (base64) with AAD
`${keyId}|${chunkIndex}`.

It is **on by default**, because it is the only path the real client takes: a
measured chat went out sealed and came back sealed, with no plaintext bypass for
`/api/v2/chat/completions`. A sealed call spends one key-exchange request (cached
for 2 hours), and a failed negotiation — or a sealed call the gateway refuses —
falls back to plaintext automatically (the client's own `fallbackOnFailure`),
retrying once after dropping the cached key. Only `/api/v2/chat/completions` is
sealed and every other signed call stays plaintext. Node's OpenSSL has no
`sm4-gcm` cipher, so GCM is built here from `sm4-ecb`/`sm4-ctr` with no
dependency added; its GHASH is verified against NIST's AES-GCM vectors and its
keystream against Node's `sm4-ctr`.

To keep the old plaintext behaviour, set `sm4: false`:

```sh
magpie plugin options codearts '{"sm4": false}'
```

The `X-Language` header is configured by the environment variable `MAGPIE_CODEARTS_LOCALE`
(default `zh-cn`, the IDE's language it follows), not by a plugin option.

### Login fingerprint (matching the installed IDE)

The portal sees `plugin-name`, `plugin-version` and `theme` on the OAuth authorize URL. The real
IDE does not pin the version: its authentication extension reads its own `package.json` version, so
a hard-coded one goes stale on the next upgrade and reads as "not the real client". Of the three
values, **only `plugin-version` is read from the IDE**; `plugin-name` and `theme` are not read from
the IDE — they are fixed (`snap_AIIDE` / `2`) unless you override them with the env vars below. The
plugin resolves each value, in order, from (1) its env var, (2) for the version only, the installed
IDE's `huaweicloud.authentication` extension manifest, (3) the historical fallback
(`snap_AIIDE` / `5.2.0` / `2`). Nothing is scanned by default — version auto-discovery happens only
when `MAGPIE_CODEARTS_IDE_DIR` is set. On startup the plugin logs the resolved value and its source
(`service: codearts`) so a mis-set directory is visible rather than a silent fallback.

| Env var | Default | What it does |
|---|---|---|
| `MAGPIE_CODEARTS_IDE_DIR` | _(unset)_ | Install root of the CodeArts Agent IDE. Only when set is `plugin-version` read from that IDE's `huaweicloud.authentication` extension `package.json` (exact id or `<id>.*`/`<id>-*` folder, under `resources/app/extensions/` or `extensions/`). Example: `D:\CodeArts Agent`. Unlike the sign-in state database, this root cannot be derived reliably, so it must be given explicitly. |
| `MAGPIE_CODEARTS_PLUGIN_NAME` | `snap_AIIDE` | Override the `plugin-name` sent on the authorize URL. |
| `MAGPIE_CODEARTS_PLUGIN_VERSION` | from the IDE when `MAGPIE_CODEARTS_IDE_DIR` is set, else `5.2.0` | Override the `plugin-version`. |
| `MAGPIE_CODEARTS_THEME` | `2` | Override `theme` (`activeColorTheme.kind`: 1 = Light, 2 = Dark). The plugin does **not** read the host's current theme; use this to match a Light-theme IDE. |
| `MAGPIE_CODEARTS_CLIENT_VERSION` | the IDE's `product.json` when `MAGPIE_CODEARTS_IDE_DIR` is set, else `26.11.100` | What chat claims as `plugin-version` / `ide-version`. Set it after an IDE upgrade if the IDE directory is not configured. |
| `MAGPIE_CODEARTS_CLIENT_IP` | _(unset)_ | `off` leaves `client-ip` off — for use behind a proxy, where the address this host sees is not the one the request leaves from. |

Resolution is cached for the life of the process, so an IDE upgrade or an env change takes effect
after a restart. To confirm what is in use, sign in once and read the `service: codearts`
`plugin-version=… (source)` line in magpie's log.

## Credits

First written by [yuweihao17](https://github.com/yuweihao17/codearts); this version carries the
fixes of [yuweihao17/codearts#8](https://github.com/yuweihao17/codearts/pull/8). It builds on the
measurements and code of [HuHong-Tao](https://github.com/yuweihao17/codearts/pull/6) and
[ReachForStar](https://github.com/ReachForStar/codearts), and on the CodeArts channel that
[iJetLi](https://gitee.com/iJetLi) wrote in
[deepseek-harness-codearts](https://gitee.com/iJetLi/deepseek-harness-codearts), as
[Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) carried it.

## 中文

用**华为云 OAuth 登录**，在 OpenCode 和 magpie 里提供两个供应商：

- **华为云码道（CodeArts Agent）**的编码套餐（体验版、个人与企业积分套餐），模型为 GLM、DeepSeek、
  openPangu 等。provider id：`codearts`。
- **OfficeAce（华为云 AgentArts / MaaS）**：GLM、DeepSeek、Qwen、Kimi、盘古等模型，分桶积分与每日签到。
  provider id：`officeace`。

两张卡各自登录：两个 provider 各持一条记录、各有一个华为云 refresh token —— STS 的 refresh token 只能用一次，
两条记录共用一个 token 会互相把对方注销。同一个华为云 IAM 账号对两家都有效，且一次登录换到的凭据对两家的接口都能用
（已实测，见下），所以「登两次」只是多点一次，不会有别的不便。OfficeAce 在 0.3.0 之前是独立的 `officeace-auth` 包：
那些账号按 magpie 原有的位置与形状读取，**不用重新登录**。

> **非官方插件**：与华为、华为云及 CodeArts（码道）没有任何关联，也未获其授权或认可。插件调用的是
> 码道客户端使用的非公开接口，并以与官方客户端相同的方式标识自己（含自动领取每日免费权益与签到），
> 这可能不符合华为云的服务条款，接口也可能随时变更。使用风险（包括账号受限）由使用者自行承担。

- **登录**：华为云 OAuth（PKCE + DPoP），本机 `127.0.0.1`（端口 ≥ 10000）接收回调，向 STS 换取临时
  AK/SK/security-token；回调只接受精确的 `/oauth/callback` GET，回调不带 code（portal 报错）时立即判定登录失败。完整凭据（含 refresh_token、PKCE verifier、DPoP 私钥）以 JSON 存在账号的
  `access` 字段里，保存在 magpie / OpenCode 自己的账号存储中；过期前 30 分钟自动续期，请求遇到临时凭据
  过期时就地续期并重发一次。同一账号的 refresh_token 只用一次；续期只是暂时失败（如 STS 连不上）时返回
  `503` 并保留登录，只有被 STS 明确拒绝才标记需要重新登录。账号标识取自 refresh_token，重复登录不会多出账号。
- **用本机的 CodeArts Agent 登录**（0.3.10 起，#998）：本机装了码道 IDE 且已登录时，多一个登录方式，直接用 IDE 的登录，
  不开浏览器。IDE 把它存在自己的 `state.vscdb`（键 `huaweicloud.codearts-snap`）里：macOS 为
  `~/Library/Application Support/codearts-agent/User/globalStorage/state.vscdb`，Windows 为
  `%APPDATA%\codearts-agent\User\globalStorage\state.vscdb`，Linux 为 `$XDG_CONFIG_HOME`（否则 `~/.config`）下的同一路径；
  `MAGPIE_CODEARTS_IDE_STATE` 可改。插件只读：先把文件（连同 `-wal`/`-journal`）拷到临时目录再读拷贝，绝不打开或写 IDE 的文件。
  文件不存在、读不了、写了一半或凭据不全都算「未知」：不提供这个方式，或登录失败并说明原因（不含任何密钥）。
  这种登录没有 refresh token，续期是等 IDE 自己续期后重新读它的文件，绝不走 STS；IDE 还没续期时续期只是暂时失败（`503`，保留登录）。
  账号标识是 IDE 的 `domainId`。
- **国际站**（0.3.10 起，#998）：国际站凭据（`stationType: "international"`）只发往
  `snap-access.ap-southeast-1.myhuaweicloud.com`，国内凭据只发往国内主机。token 套餐显示为一个窗口：
  `start_date`–`end_date` 内 `package_token_amount` 中已用的 `usage_token_num`，套餐名取 `package_name_en`。
  国际站没有 `opengw` 接口、积分批次和每日签到，插件在那里一概不请求（签到回答「未开通」）。尚未用真实国际站账号试过：
  对话仍发到 `/api/v2/chat/completions`，模型列表读不到时用内置列表。
- **国际站浏览器登录**（0.3.17 起，#1090）：「Sign in with Huawei Cloud (International)」先打开华为云国际站登录页
  （`auth.huaweicloud.com`，`site=intl`），再到国际站门户的授权页（`codearts.ap-southeast-1.huaweicloud.com/portal/authorize`）。
  授权码仍在同一个 STS 端点换取，凭据记为国际站凭据，续期后不变；不读国内站才有的手机号和 OfficeAce 信息。尚未用真实国际站账号试过。
- **模型**：账号实时的内置模型列表；领取当日免费权益成功后，再加上免费模型（每个北京自然日领一次，与
  客户端一致；当天还没领取时遇到 `benefit not found` 也会先领取再重发）。每个模型的「消耗系数」作为 magpie 的倍率上报，来自账号主智能体（`build`）的模型列表。
  0.3.2 起模型名照码道给的显示：带日期的 `deepseek-v4.1-flash-1017` 是另一个模型（错峰倍率不同），显示为
  `DeepSeek-V4.1-Flash-1017`，不再和 `DeepSeek-V4.1-Flash` 叫同一个名字（#677）。
- **请求**：SDK-HMAC-SHA256 签名，只签给码道自己的主机（`snap-access.cn-north-4.myhuaweicloud.com`、
  `opengw.developer.huaweicloud.com`；国际站凭据只签 `snap-access.ap-southeast-1.myhuaweicloud.com`），发往其他地址（如改过的 `api`）的请求在凭据发出前就被拒绝，签名请求和令牌请求都不跟随重定向；像客户端一样发送 `x-ot-session-id` 会话头（每账号一个会话），账号内
  在途请求不超过 3 个，`TM.00001041` 退避重试，网关排队时按客户端的方式等待（0.2.3 起，magpie 在这个请求之后还有别的账号、供应商或路由组成员时（`x-magpie-fallback: 1`），排队的请求立即退出队列并以 `503` 加队列的 `Retry-After` 回答，magpie 随即改问下一个）；总是以流式请求上游（码道
  只对流式回答计量积分），调用方要非流式时折叠回 JSON；默认注入 `thinking: { type: "enabled" }`，思考与
  正文分开；200 里内嵌的错误换算为 `429` / `400` / `502` 并带厂商原话；码道只接受不超过 64 个字符的工具名，
  更长的（如 MCP 工具名）发出时缩为前 55 个字符 + `_` + 8 位 SHA-256，回答（流式与非流式）里的工具调用再换回原名。
  0.2.4 起所有模型都声明为只收文本（码道对图片回 `InferHub.001001020.406`「The request model is not multimodal」），
  magpie 会替模型描述图片或把图片略去；这个拒绝不论放在 200 里还是带别的状态码，都换算为 `400`，而不是让智能体反复重试的 `502`。
- **X-Language**（0.3.24 起）：所有签名请求都带同一个 `X-Language`，在**签名之后**设置，因此不进入 `SignedHeaders`。它跟随 IDE 语言（默认 `zh-cn`），不随站点——真实内核在国际站、中文 IDE 下发的也是 `zh-cn`。英文 IDE 用环境变量 `MAGPIE_CODEARTS_LOCALE=en-us` 覆盖。对话请求不发 `lang`、`Chat-Id`、`Session-Id`，会话只认 `x-ot-session-id`。
- **客户端身份**（0.3.25 起）：每个对话请求还带上真实内核自报的身份，取自 2026-11-17 实测的 `[header-debug] full headers`：`x-ot-client-type: IDE`、`x-ot-client-version`、`plugin-name: codemate_vscode`、`plugin-version`、`ide-name: VSCode`、`ide-version`、空值 `x-ot-function`、`model-id`/`model-name`、每请求新的 `user-msg-id` 与 `created-time`，以及本机私网 IPv4 的 `client-ip`。这些都在签名之后设置，不进入 `SignedHeaders`。版本号取自本机 IDE 的 `resources/app/product.json`（设了 `MAGPIE_CODEARTS_IDE_DIR` 时），否则 `MAGPIE_CODEARTS_CLIENT_VERSION`，再否则用本版内置的快照——**不设环境变量，IDE 升级后插件仍会自报旧版本**。`MAGPIE_CODEARTS_CLIENT_IP=off` 可关掉 `client-ip`（走代理时本机看到的地址与出口地址不一致）。
- **一个对话一个上游会话**（0.3.25 起）：真实内核把对话 ID 放在 `x-ot-session-id`，所以每个对话各占账号三个会话额度中的一个，而不是全账号共用一个 id。账号维护至多三个 id 的池：对话活跃期间及静默 `90` 秒内保持自己的 id（网关会持有已结束的会话约一分钟），之后才可能把槽位让给别的对话——这样第 4 个对话也不会开出网关会拒绝的会话（`TM.00001041`）。
- **用量与签到**：总积分决定账号是否可用，其余积分桶只做明细；另有每日免费额度窗口。各批积分的到期
  时间读自码道控制台同一批接口，读不到时退回插件的签到账本 `~/.config/magpie/codearts-checkins.json`
  （这部分仍在用更多账号验证，请以控制台为准）。`auth.checkin` 与客户端「限时福利 → 每日领取」一致
  （插件领取后确认失败的，当天记在签到账本里，下次签到时补确认；客户端本就不确认的 `id: null` 领取不会被确认），
  活动列表里标题为签到/每日（`签到` / `每日`）的每一个可领活动都会领取：普通每日签到和赛事附带的
  每日签到（例如小红书 Skill 创新赛的每日 1000 积分，2026-11-11–12-05）是同一列表里的不同活动，赛事的一次性报名礼
  留给用户自己领；没报名该赛事的账号，赛事签到不可领，会被跳过，普通每日签到仍照常领取，
  日期取自服务端活动列表的 `extra.endTime`，代码里没有写死，活动结束后自然不再领取，
  在 **设置 → 用量 → Plugins** 打开「每日自动签到」即可。
- **OfficeAce（第二个供应商）**：officeace 卡片提供与 CodeArts 卡片相同的「华为云登录」，账号体系是同一套：
  码道的 STS 三元组能签 OfficeAce 的订阅接口（V11-HMAC）并通过它的 CLAW 权限校验，反之 OfficeAce 的三元组也能签
  码道的 `snap-access` 接口。但**两张卡各写各的记录、各持自己的 refresh token**——一次登录只写当前这张卡的记录。
  华为云的 refresh token 只能用一次，两条记录共用一个 token 会让 CodeArts 用户因为 OfficeAce 那条记录续期而被要求
  重新登录；一条记录一次登录才是对的。要用 OfficeAce 就在 OfficeAce 卡片上登录。记录放在
  `<provider>#<账号身份哈希>` 上，之后再登同一账号会合并，不会多出一行。**只有登录会创建 OfficeAce 账号**：
  列模型时不会从另一家的记录「带入」一个账号，用户登出的账号不会自己回来。老 `officeace-auth` 的记录原样读取：provider id 相同、`access` 里的 JSON 形状相同，
  续期仍走它签发时的 OAuth 客户端（`pdp5_for_agentarts`）。
- **账号名与续期边界**：`accountId` 用厂商自己的稳定 id（IAM 域名 id，与老 `officeace-auth` 记录里的一致），
  **绝不是打码手机号**（#483、magpie#4416；magpie 把用户给账号起的名字、代理、网关 key 都挂在 `accountId` 上，
  手机号只出现在 `usage().user`）。续期不会重命名账号：记录里已有的 `accountId`/`uid` 原样保留（域名 id，或
  `officeace-auth` 0.1.14 存下的手机号），只在该值为空时才补一个。新登录写的 `accountId` 是域名 id。
  续期只花**这条记录自己的 refresh token**：协调单位是「refresh chain = 签发它的 OAuth 客户端 + token 的血缘」
  （轮换后的新 token 记在父 token 同一血缘上，仍算同一条链）。
  每条记录都有自己的 token：码道记录由 `codearts-agent` 签发，OfficeAce 记录由 `pdp5_for_agentarts` 签发，各花各的，
  各自保留自己的 MaaS 凭据；**续期只写被续的那条记录，绝不写另一条**（`auth.set` 会把不存在的账号创建出来），
  续期失败就是失败，绝不借用另一条链的凭据。
- **OfficeAce 的模型**：目录 `/v2/models` 是注册表（26 条，多数对话时回 `404 ModelArts.81009 Invalid model`），
  插件只保留计费清单（`/v1/model-token-rates`，9 条）里的，并永不列出三个实测必 404 的 id；倍率表读取失败时保留上
  一份好表（空表会让不可调的 id 全部回到用户面前）；未登录时用 10 个内置模型兜底。模型名带上倍率（`GLM-5.3 · x0.18`），
  上游 `model_name` 的尾部换行会去掉。
- **OfficeAce 的请求**：MaaS 要 `Authorization: Basic base64(appKey:appSecret)`，插件把 SDK 的 Bearer 改写掉，
  去掉 `officeace/` 前缀，发到凭据里自带的 MaaS 地址（为空时用官方直连）。`401`（或 4xx 但报文点名这对 Basic 凭据）
  会先续期一次再重发，**但只有续期真的换了这对凭据时才重发**。已登录但没开通 MaaS 的账号会得到一条说清原因的 `400`，
  不会把空的 Basic 头发给上游。
- **OfficeAce 的用量与签到**：`/v1/subscription` 中所有未过期套餐桶（`skus[].quotas`）和活动桶（`bonus_skus`）
  汇总成唯一参与路由的「总积分」窗口，各桶只作为 `aside` 明细展示；`.trial` 桶没有到期时间就不显示；
  已过期的桶收进折叠区且不参与有效余额汇总。「总积分」用仍有余额的桶里最早到期者作为 `runsOutAt`，
  并把同一北京自然日到期的余额合为 `runsOut`；如果所有桶都已过期，仍保留一个已用尽的总积分窗口来暂停账号。签到是每个北京自然日一次
  `POST /v1/subscription/bonus/claim`：2xx 但 `bonus_skus` 为空是「今日已无新增可领」（`done`），不是失败。
- **已知限制**：STS 的 refresh_token 只能用一次。本包的每张卡各自登录、各自持有一条记录与一个 token，所以两张卡
  互不影响；**续期只写被续的那条记录**，因此用户删掉的账号永远不会被写回来（无论它此前有没有被列出/使用过、
  有没有重启）。老 `officeace-auth` 记录同样只按自己的链续期。两个 magpie 进程同时续期同一个账号仍可能撞车，
  输的一方重试，只有 token 一直是被消费状态才标记需重新登录。
  另外，`officeace-auth` 与本包不能同时服务 `officeace` 这个 provider id，magpie 会让你选一个，装之前先卸掉旧的。
- **登录指纹跟随本机 IDE**：OAuth 授权 URL 上的 `plugin-name`/`plugin-version`/`theme` 是客户端身份指纹。真实 IDE 不写死版本——它发的是认证扩展自己 `package.json` 的版本；写死（如 5.2.0）会在 IDE 升级后过时。**三项里只有 `plugin-version` 会从 IDE 读取**，`plugin-name`/`theme` 固定为 `snap_AIIDE`/`2`（可用环境变量覆盖；插件不读取宿主当前主题）。取值顺序：① 对应环境变量；② **仅 `plugin-version`**，且**仅在设置 `MAGPIE_CODEARTS_IDE_DIR` 时**才从本机 IDE 的 `huaweicloud.authentication` 扩展 `package.json` 读；③ 历史兜底值。默认不扫描磁盘——把 `MAGPIE_CODEARTS_IDE_DIR` 指向 IDE 安装根目录（含 `resources` 的那层，例如 `D:\CodeArts Agent`）才会启用版本自动读取，跟随 IDE 升级。与登录状态数据库不同，安装根目录无法可靠推导，必须手动指定。解析结果（值+来源）会在启动时写进 `service: codearts` 日志，便于自查；结果按进程缓存，IDE 升级或改环境变量需重启生效。可用 `MAGPIE_CODEARTS_PLUGIN_NAME`、`MAGPIE_CODEARTS_PLUGIN_VERSION`、`MAGPIE_CODEARTS_THEME`（1=浅色，2=深色）单独覆盖任一项。
- **致谢**：原作者 [yuweihao17](https://github.com/yuweihao17/codearts)；HuHong-Tao、ReachForStar 的
  实测与实现；CodeArts 渠道的原作者 [iJetLi](https://gitee.com/iJetLi)（[deepseek-harness-codearts](https://gitee.com/iJetLi/deepseek-harness-codearts)），
  以及转载它的 [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)。

## License

MIT — see [LICENSE](./LICENSE).

