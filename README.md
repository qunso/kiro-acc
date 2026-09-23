# kiro-acc — Kiro 多账号服务端（无头版）

基于 [chaogei/Kiro-account-manager](https://github.com/chaogei/Kiro-account-manager)（AGPL-3.0）的代理/账号池思路，重写为 **Node.js + TypeScript 无头服务端**：

- 多账号持久化 + Token 刷新
- 账号池：round-robin / sticky + 断路器（指数退避）+ 配额冷却
- OpenAI 兼容 API（`/v1/chat/completions`，支持 SSE 流式）
- Anthropic 兼容 Messages API（`/v1/messages`，支持 SSE 流式与 `count_tokens`）
- Admin REST（账号 CRUD、OIDC/卡密导入、出口池、只读 TLS 探测）
- Docker / docker-compose

**本仓库不包含**：Electron UI、托盘、机器码/设备指纹伪装、MITM K-Proxy / 根证书注入。

算法与 Kiro 请求翻译参考了上游 `proxy/` 模块；代码为可维护的服务端重写，而非整文件照搬。

---

## 与桌面版差异

| 能力 | 桌面版 (Electron) | 本服务端 |
|------|-------------------|----------|
| UI / 托盘 | ✅ Electron | `/admin/ui`（账户管理 / 代理池 / 出口 / 导入 / TLS 探测） |
| OpenAI 兼容反代 | ✅ | ✅ |
| 多账号池 + 断路器 | ✅ | ✅ |
| Claude Messages API | ✅ | ✅ `/v1/messages` |
| MITM K-Proxy | ✅ | ❌（刻意省略） |
| 机器码伪装 | ✅ | ❌（刻意省略） |
| 无头 Docker 部署 | ❌ | ✅ |
| Admin HTTP API | 有限 | ✅ |

---

## 要求

- Node.js ≥ 18
- 合法的 Kiro / Amazon Q 账号 Token（自行获取，本项目不提供登录绕过）

## 安装与启动

```bash
cd /Volumes/work/kiro-acc   # 或本机路径
cp .env.example .env        # 修改 API_KEY / ADMIN_TOKEN
npm install
npm run build
npm start
# 开发：npm run dev
```

默认监听 `http://0.0.0.0:8787`。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `8787` | 端口 |
| `DATA_DIR` | `./data` | 持久化目录（accounts.json / config.json / usage.json） |
| `API_KEY` | `change-me-api-key` | 公共 API 密钥（Bearer 或 `x-api-key`） |
| `ADMIN_TOKEN` | `change-me-admin-token` | 管理接口令牌（`x-admin-token` 或 Bearer） |
| `ACCOUNT_STRATEGY` | `round-robin` | `round-robin` \| `sticky` |
| `BASE_COOLDOWN_MS` | `60000` | 断路器基础冷却 |
| `QUOTA_RESET_MS` | `3600000` | 配额耗尽恢复窗口 |
| `TOKEN_REFRESH_BEFORE_EXPIRY_SEC` | `300` | 提前刷新秒数 |
| `PREFERRED_ENDPOINT` | `codewhisperer` | `codewhisperer` \| `amazonq` |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` | — | 全局出站代理：`http(s)://`、`socks5://`、`socks5h://`、`ss://`（账号字段 `outboundProxyUrl` 可覆盖） |

---


## 出站代理（HTTP / SOCKS5 / 原生 Shadowsocks）

支持：

- `http://` / `https://` HTTP 代理
- `socks5://` / `socks5h://` SOCKS5（`socks5h` 由代理侧解析 DNS）
- **`ss://` 原生 Shadowsocks AEAD**（进程内实现，**不需要** `sslocal` / `ss-local` / ss-exit broker）

推荐 SS URL 形式（密码中的 `#` 需编码为 `%23`）：

```
ss://aes-256-gcm:SHARED_PASS%2317@1.2.3.4:60123
```

支持方法：`aes-256-gcm`（iqun 默认）、`chacha20-ietf-poly1305`、`aes-128-gcm`。仅 TCP；UDP 不需要。

**全局**（`.env`）：

```bash
ALL_PROXY=ss://aes-256-gcm:secret%230@ss.example.com:60123
# 或仍可用 SOCKS：ALL_PROXY=socks5h://127.0.0.1:1080
```

**单账号**（Admin 创建/更新时）：

```json
{ "outboundProxyUrl": "ss://aes-256-gcm:secret%2317@1.2.3.4:60123" }
```

仍兼容本机 `ss-local` / Clash SOCKS 端口。

## 添加账号

```bash
curl -s http://127.0.0.1:8787/admin/accounts \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "label": "main",
    "email": "you@example.com",
    "accessToken": "eyJ...",
    "refreshToken": "eyJ...",
    "authMethod": "social",
    "profileArn": "arn:aws:codewhisperer:us-east-1:699475941385:profile/...",
    "expiresAt": 1893456000000,
    "enabled": true
  }'
```

批量导入：

```bash
curl -s http://127.0.0.1:8787/admin/accounts/import \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"mode":"merge","accounts":[ /* ... */ ]}'
```

强制刷新 Token：

```bash
curl -s -X POST http://127.0.0.1:8787/admin/accounts/<id>/refresh \
  -H "x-admin-token: $ADMIN_TOKEN"
```

---

## 公共 API 示例

健康检查（无需密钥）：

```bash
curl -s http://127.0.0.1:8787/health
```

列出模型：

```bash
curl -s http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $API_KEY"
```

非流式对话：

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4.5",
    "messages": [{"role":"user","content":"你好"}],
    "stream": false
  }'
```

流式（SSE）：

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4.5",
    "messages": [{"role":"user","content":"写一首短诗"}],
    "stream": true
  }'
```

占位/无效 Token 时，上游会返回明确错误（如 HTTP 403），服务会按断路器策略切号或将错误透传给客户端。

### Claude Messages API

与 OpenAI 聊天走同一账号池、Token 刷新、断路器和粘性 SS 出站。路径与桌面版一致：

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`（按请求体长度估算，不打上游）
- 别名：`POST /anthropic/v1/messages` 与 `POST /anthropic/v1/messages/count_tokens`

认证与 `/v1/chat/completions` 相同：`Authorization: Bearer $API_KEY` 或 `x-api-key`。

```bash
curl -s http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4.5",
    "max_tokens": 256,
    "messages": [{"role":"user","content":"你好"}]
  }'
```

流式：把 `"stream": true` 加上，响应为 Anthropic SSE（`message_start` / `content_block_delta` / `message_delta` / `message_stop`）。

```bash
curl -s http://127.0.0.1:8787/v1/messages/count_tokens \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"你好"}]}'
```

Claude Code 可将 `ANTHROPIC_BASE_URL` 指到 `http://127.0.0.1:8787`，`ANTHROPIC_API_KEY` 填 `API_KEY`。本接口转发文本、图片（base64）、tools / tool_result；不改写 TLS 指纹。

---

## Admin API 摘要

均需 `x-admin-token` 或 `Authorization: Bearer <ADMIN_TOKEN>`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/admin/accounts` | 列表 / 创建 |
| GET/PATCH/DELETE | `/admin/accounts/:id` | 读 / 改 / 删 |
| POST | `/admin/accounts/:id/enable` | 启用 |
| POST | `/admin/accounts/:id/disable` | 禁用 |
| POST | `/admin/accounts/:id/refresh` | 强制刷新 Token |
| POST | `/admin/accounts/:id/unsuspend` | 解除封禁标记 |
| POST | `/admin/accounts/import` | 导入账号 JSON / OIDC / 卡密文本（`{"text":"..."}`） |
| GET | `/admin/accounts/export` | 导出 |
| POST | `/admin/accounts/:id/bind-pool` | 绑定代理池并分配出口（`{"poolId":"..."}`） |
| POST | `/admin/accounts/:id/unbind-pool` | 解除池绑定 |
| POST | `/admin/tls-probe` | 只读 JA3/JA4/ALPN/出口 IP 对比 |
| GET | `/admin/pool/stats` | 池统计 |
| PATCH | `/admin/pool/config` | 改策略/冷却等 |
| POST | `/admin/pool/reset` | 重置断路器状态 |
| GET | `/admin/usage` | 用量 |
| GET | `/admin/exits` | 出口列表 |
| POST | `/admin/exits/import` | 导入 SS catalog / 遗留 broker |
| POST | `/admin/exits/assign` | sticky / rr 分配到账号（非池） |
| GET/POST | `/admin/pools` | 列出 / upsert 出口池 |
| GET/DELETE | `/admin/pools/:id` | 获取 / 删除池 |
| PUT | `/admin/pools/:id/exits` | 设置池成员 exitIds |
| POST | `/admin/pools/:id/assign` | stats 策略分配（useCount→banCount→hash） |
| POST | `/admin/pools/:id/disable` / `enable` | 停用 / 启用池 |
| POST | `/admin/accounts/:id/rebind-exit` | ban 当前 exit 并换绑同池 |
| POST | `/admin/exits/probe` | 可选 egress 探测（非主路径） |
| POST | `/admin/exits/:id/disable` / `enable` | 禁用 / 启用 exit |

---


## 出口隔离（原生 Shadowsocks，推荐）

iqun 开启 `SS_PASS_SELECT=1`，密码约定 `SS_PASS#index` / `SS_PASS#exitIp` / `SS_PASS#tag`（见下）。kiro-acc **进程内**直连 SS AEAD，不再依赖 ss-exit broker / sslocal。

### 1) 生成 catalog

```bash
export SS_PASS='your-shared-pass'
export SS_METHOD=aes-256-gcm
export SS_PORT=60123
npm run gen-ss-exits -- --host YOUR_SS_HOST --ip-count 245 --id-prefix ss1
# → data/ss-exits.json（含密码，已 gitignore）+ data/ss-exits.meta.json
```

### 2) 导入出口（SS 字段）

```bash
# 读取 catalog 后 POST（示例形状）
curl -s http://127.0.0.1:8787/admin/exits/import \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "exits": [
      {
        "id": "ss1-0",
        "server": "1.2.3.4",
        "port": 60123,
        "method": "aes-256-gcm",
        "password": "SHARED_PASS#0",
        "index": 0
      },
      {
        "id": "ss1-17",
        "server": "1.2.3.4",
        "port": 60123,
        "method": "aes-256-gcm",
        "password": "SHARED_PASS#17",
        "index": 17,
        "exitIp": "203.0.113.17"
      }
    ]
  }'
```

导入时会预计算 `outboundProxyUrl` 为 `ss://aes-256-gcm:SHARED_PASS%23N@host:port`。

也可直接：

```bash
jq '{exits: .}' data/ss-exits.json | curl -s http://127.0.0.1:8787/admin/exits/import \
  -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' -d @-
```

### 3) sticky / round-robin 分配

```bash
curl -s http://127.0.0.1:8787/admin/exits/assign \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"strategy":"sticky"}'
```

会把选中的 exit 的 `ss://` URL 写入账号的 `outboundProxyUrl`（以及 `outboundExitId`）。**不会**调用任何 broker。

账号字段：

- `outboundProxyUrl` — `ss://` / `socks5(h)://` / `http(s)://`
- `outboundExitId` — catalog id（可选）

持久化：`data/exits.json`（可含 SS 字段与密码；请勿提交到 git）。

### 4) Proxy pools（推荐：账号绑定出口池）

账号绑定到 **pool**（可互换 SS exits），而不是单个永远固定的 URL。池内 exit 可混用：

- `SS_PASS#<index>` — `index % len(IP_LIST)`
- `SS_PASS#<exitIp>` — sticky bindto 该 IP（须在 host `IP_LIST`）
- `SS_PASS#<tag>` — 既非十进制 index 也非 `IP_LIST` 内 IP 时，iqun 用 `hash(suffix)%N`（与 kiro-acc 共享 normalize-before-KDF）

**选择策略**（`POST /admin/pools/:id/assign`）：`useCount` 升序 → `banCount` 升序 → `hash(accountId + '\0' + exitId)` 升序（同分粘滞）。

```bash
# 创建 / upsert 池
curl -s http://127.0.0.1:8787/admin/pools \
  -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"id":"pool-a","name":"main","exitIds":["ss1-0","ss1-203.0.113.9"]}'

# 或批量
curl -s http://127.0.0.1:8787/admin/pools \
  -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"pools":[{"id":"pool-a","exitIds":["e0","e1"]}]}'

# 设置成员
curl -s -X PUT http://127.0.0.1:8787/admin/pools/pool-a/exits \
  -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"exitIds":["e0","e1","e2"]}'

# 按 stats 策略分配账号（写入 outboundPoolId / outboundExitId / outboundProxyUrl，并 bump useCount）
curl -s http://127.0.0.1:8787/admin/pools/pool-a/assign \
  -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"accountIds":[]}'

# 手动 rebind（默认对当前 exit bumpBan + 短 cooldown，再选下一出口）
curl -s http://127.0.0.1:8787/admin/accounts/ACCOUNT_ID/rebind-exit \
  -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{}'
```

**封禁自动换绑**：上游返回 `TEMPORARILY_SUSPENDED` 时，若账号有 `outboundPoolId` + `outboundExitId`，会 `banCount++`（默认 cooldown 10min），再在同池选下一合格 exit。rebind 失败只打日志，不阻断 suspend 路径。

**可选** `POST /admin/exits/probe`：egress IP 探测，**不是**分配主路径（catalog / gen 应自带 `#ip` / `#index`）。

账号字段新增：`outboundPoolId`。持久化：`data/pools.json`。

非池分配仍可用 `POST /admin/exits/assign`（sticky / round-robin）。

### 遗留：ss-exit broker（可选）

同机 [`ss-exit`](../ss-exit) broker 仍可通过 `brokerBase` 导入 / `ensure`（拉起本机 sslocal → socks5h）。**已不推荐**；优先原生 `ss://`。

**说明**：sticky 出口隔离 ≠ 完整反封禁；本仓库仍不做设备指纹 / MITM。


## Docker

```bash
cp .env.example .env
# 编辑 .env：至少改掉 API_KEY / ADMIN_TOKEN
docker compose up -d --build
```

- 管理 UI：http://localhost:8787/admin/ui （页面里填 `ADMIN_TOKEN`）
  - **账户管理**：选代理池并绑定；行上只读显示已分配的出口 ID / 出口 IP
  - **代理池**：勾选 SS 出口，创建、编辑成员、停用、把账号分配进池
  - **出口**：查看 use/ban，启用或禁用单条出口
  - **导入**：OIDC / 账号 JSON / 卡密，以及 exits JSON
  - **TLS 探测**：选账号后一键对比粘性出站与直连的 JA4 / JA3 / ALPN / 出口 IP（只观测，不伪装）
- 健康检查：http://localhost:8787/health
- 数据卷：`kiro-acc-data` → 容器内 `/data`

---

## 管理界面

打开 `http://127.0.0.1:8787/admin/ui`，在页头填入 `ADMIN_TOKEN`。侧栏沿用桌面版的信息架构（账户管理、代理池、导入），并保留出口列表和只读 TLS 探测。本页不提供机器码修改，也不提供用于模仿官方客户端指纹的 MITM。

导入账号示例（OIDC，仅有 refresh token 时会在下次请求前刷新 access token）：

```bash
curl -s http://127.0.0.1:8787/admin/accounts/import \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"accounts":[{"email":"you@example.com","refreshToken":"...","clientId":"...","clientSecret":"...","provider":"BuilderId"}]}'
```

卡密文本（密码字段会被忽略）：

```bash
curl -s http://127.0.0.1:8787/admin/accounts/import \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"mode":"merge","text":"you@example.com----no_password----REFRESH----CLIENT_ID----CLIENT_SECRET----BuilderId"}'
```

把账号绑到池上（响应里的 `assignedExit.exitId` / `exitIp` 就是界面上的只读提示）：

```bash
curl -s http://127.0.0.1:8787/admin/accounts/ACCOUNT_ID/bind-pool \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"poolId":"pool-a"}'
```

### 如何测试 JA4 按钮

1. 导入至少一条带 `ss://` 字段的出口，创建代理池，在「账户管理」里把账号绑定到该池（行上应出现出口 ID 和出口 IP）。
2. 打开「TLS 探测」，选中该账号，勾选「对比直连」，点「开始探测」。
3. 服务会用该账号当前的粘性出站 Dispatcher **原样**请求 `https://tls.peet.ws/api/all`，再直连一次。页面分列展示 JA4、JA3、ALPN、HTTP 版本和出口 IP。
4. 等价 API：

```bash
curl -s http://127.0.0.1:8787/admin/tls-probe \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"accountId":"ACCOUNT_ID","compareDirect":true}'
```

`sticky.ja4` 是经账号出站看到的指纹，`direct.ja4` 是本进程直连基线。两者不同只说明路径不同，服务不会去对齐或伪造任何一方。

---

## 开发与测试

```bash
npm test          # vitest：错误分类 + 账号池选择
npm run build
npm run dev
```

---

## 许可证

AGPL-3.0。致谢上游：[chaogei/Kiro-account-manager](https://github.com/chaogei/Kiro-account-manager)。

使用本软件向 AWS/Kiro 发起请求时，请遵守其服务条款；本项目仅作自用账号管理与 API 兼容层。
