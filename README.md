# kiro-acc — Kiro 多账号服务端（无头版）

基于 [chaogei/Kiro-account-manager](https://github.com/chaogei/Kiro-account-manager)（AGPL-3.0）的代理/账号池思路，重写为 **Node.js + TypeScript 无头服务端**：

- 多账号持久化 + Token 刷新
- 账号池：round-robin / sticky + 断路器（指数退避）+ 配额冷却
- OpenAI 兼容 API（`/v1/chat/completions`，支持 SSE 流式）
- Admin REST（账号 CRUD、导入导出、池配置/统计）
- Docker / docker-compose

**本仓库不包含**：Electron UI、托盘、机器码/设备指纹伪装、MITM K-Proxy / 根证书注入。

算法与 Kiro 请求翻译参考了上游 `proxy/` 模块；代码为可维护的服务端重写，而非整文件照搬。

---

## 与桌面版差异

| 能力 | 桌面版 (Electron) | 本服务端 |
|------|-------------------|----------|
| UI / 托盘 | ✅ | ❌ |
| OpenAI 兼容反代 | ✅ | ✅ |
| 多账号池 + 断路器 | ✅ | ✅ |
| Claude Messages API | ✅ | ❌（可后续扩展） |
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
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` | — | 全局出站代理：`http(s)://`、`socks5://`、`socks5h://`（账号字段 `outboundProxyUrl` 可覆盖） |

---


## 出站代理（含 Shadowsocks / ss-local）

支持：

- `http://` / `https://` HTTP 代理
- `socks5://` / `socks5h://` SOCKS5（`socks5h` 由代理侧解析 DNS，配合 `ss-local` 更合适）

**全局**（`.env`）：

```bash
ALL_PROXY=socks5h://127.0.0.1:1080
# 或 HTTPS_PROXY=socks5h://127.0.0.1:1080
```

**单账号**（Admin 创建/更新时）：

```json
{ "outboundProxyUrl": "socks5h://127.0.0.1:1080" }
```

典型接法：本机先跑 `ss-local`（或 Clash/sing-box 的 SOCKS 端口），再把本地 SOCKS 地址填进上面配置。不支持直接填 `ss://` 节点链接。

带用户名密码时：

```bash
ALL_PROXY=socks5h://user:pass@127.0.0.1:1080
```

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
| POST | `/admin/accounts/import` | 导入 JSON |
| GET | `/admin/accounts/export` | 导出 |
| GET | `/admin/pool/stats` | 池统计 |
| PATCH | `/admin/pool/config` | 改策略/冷却等 |
| POST | `/admin/pool/reset` | 重置断路器状态 |
| GET | `/admin/usage` | 用量 |

---

## Docker

```bash
export API_KEY=your-api-key
export ADMIN_TOKEN=your-admin-token
docker compose up -d --build
```

数据卷：`kiro-acc-data` → 容器内 `/data`。

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
