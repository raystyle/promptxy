# PromptXY

<div align="center">

<img src="https://raw.githubusercontent.com/BeGild/promptxy/master/frontend/public/favicon.svg" alt="PromptXY Logo" width="128" height="128">

![PromptXY Logo](https://img.shields.io/badge/PromptXY-v2.1.7-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)

**AI 工具本地 HTTP 代理规则管理器**

拦截、修改、可视化 AI 服务请求 | 支持 Anthropic、OpenAI、Gemini

[功能特性](#-核心功能) • [快速开始](#-快速开始) • [客户端接入](#-客户端接入透传代理) • [配置说明](#-配置文件)

</div>

## ✨ 核心功能

- **透明代理**: 客户端只改一个 Base URL，KEY/TOKEN 原样透传，零侵入接入
- **规则引擎**: 7 种文本操作（set/append/prepend/replace/delete/insert_before/insert_after），支持正则
- **请求拦截与修改**: 请求侧（如 system 注入）与响应侧（如 thinking 改写）均可配置规则
- **多客户端支持**: Claude Code、Codex CLI、OpenAI Chat 客户端、Gemini CLI
- **模型映射**: 按入站模型粒度路由到不同供应商，可覆盖出站模型名
- **请求历史**: SQLite 存储、自动清理、SSE 实时推送、Web UI 可视化与差异对比

## 🏗️ 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                    前端 Web UI (React + HeroUI)               │
│        规则管理  •  请求监控  •  预览测试  •  配置管理          │
└──────────────────────────┬──────────────────────────────────┘
                           │ /_promptxy/*  (API + SSE)
                           ↓
┌─────────────────────────────────────────────────────────────┐
│              PromptXY 统一服务器 (默认 127.0.0.1:7070)         │
│                                                              │
│   代理路由: /claude/*  /codex/*  /chat/*  /gemini/*          │
│   管理路由: /_promptxy/*                                      │
│                                                              │
│   规则引擎 → 请求改写 → 上游转发 → 响应改写 → 记录存储        │
└──────────────┬───────────────────────────────┬───────────────┘
               │                               │
      ┌────────▼─────────┐            ┌────────▼─────────┐
      │  SQLite 请求历史  │            │  上游 AI 供应商   │
      │  ~/.local/promptxy│            │  Anthropic/GLM/  │
      └──────────────────┘            │  OpenAI/Gemini…   │
                                      └──────────────────┘
```

## 🚀 快速开始

### 安装与启动

**方式一：npm 全局安装（推荐）**

```bash
npm install -g promptxy
promptxy                  # 启动（端口可用 --port 指定）
```

**方式二：从源码运行**

```bash
git clone https://github.com/BeGild/promptxy.git
cd promptxy
npm install

npm run dev               # 开发模式（后端 + 配置自动发现）
# 或
./scripts/dev.sh          # 同时启动后端和前端 (5173)

npm run build && npm start   # 生产模式
```

启动后：

- 后端服务: `http://127.0.0.1:7070`（端口由配置或 `--port` 决定，未指定时按用户名哈希自动分配 8000-9000）
- Web UI: `http://127.0.0.1:7070/_promptxy/`（开发模式下为 `http://localhost:5173`）

### 命令行参数

```bash
promptxy --port 7070          # 指定端口
promptxy --host 0.0.0.0       # 绑定所有网卡
promptxy --debug              # 启用调试模式
```

## 🔌 客户端接入（透传代理）

PromptXY 是**透明代理**：客户端只需把 Base URL 指向本地服务并带上路径前缀（`/claude`、`/codex`、`/chat`、`/gemini`），原有的 KEY/TOKEN 配置保持不变，鉴权头会原样转发到上游。

### Claude Code：项目目录生效（推荐）

在**目标项目根目录**下创建 `.claude/settings.json`：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:7070/claude"
  }
}
```

在该目录里启动 `claude`，所有请求即经过 PromptXY；其他项目不受影响。

> - 把 `7070` 替换为实际运行端口，路径前缀 `/claude` 必须保留
> - 个人配置可放在 `.claude/settings.local.json`（同样格式，适合不提交到 git 的场景）
> - 需要全局生效时，改用下面的环境变量方式

### 环境变量方式（全局）

```bash
# Claude Code
export ANTHROPIC_BASE_URL="http://127.0.0.1:7070/claude"

# Codex CLI
export OPENAI_BASE_URL="http://127.0.0.1:7070/codex"

# OpenAI Chat 客户端
export OPENAI_BASE_URL="http://127.0.0.1:7070/chat"

# Gemini CLI
export GOOGLE_GEMINI_BASE_URL="http://127.0.0.1:7070/gemini"
```

> KEY/TOKEN 的配置保持原样即可（透明代理，完美转发）。

## 🧩 按模型粒度映射到供应商 + 模型

当 `/claude` 路由对接 OpenAI/Codex 协议供应商时，Claude Code 发送的 `model`（如 `*-sonnet-*`）上游通常无法识别。通过"模型映射规则"解决：

1. **路由默认上游**：为 `/claude` 路由选择 `defaultSupplierId`（未命中规则时使用，透传 model）
2. **规则级选择**：每条规则配置 `inboundModel` / `targetSupplierId` / `outboundModel?`
   - `outboundModel` 未填写时透传入站 `model`；填写则覆盖

### Claude → OpenAI 示例

- `defaultSupplierId=openai-official`
- 规则：`inboundModel=*-sonnet-*` → `targetSupplierId=openai-official` / `outboundModel=gpt-4o-mini`
- 规则：`inboundModel=*-haiku-*` → `targetSupplierId=openai-official` / `outboundModel` 留空（透传）

> 入口协议约束：`/codex` 仅允许 `protocol=openai-codex` 供应商，`/chat` 仅允许 `protocol=openai-chat`，`/gemini` 仅允许 `protocol=gemini`。
> transformer 不作为配置字段保存，运行时按入口与目标供应商协议自动推断。

### OpenAI ModelSpec（reasoning effort）

`supportedModels` 支持形如 `<base>-<effort>` 的 modelSpec（如 `gpt-5.2-codex-high`）：

- `<effort>` 命中 `low/medium/high/xhigh` 时，出站自动拆解为 `model=<base>` + `reasoning.effort=<effort>`
- 未命中时不报错，直接透传 modelSpec

## 🛠️ 规则引擎

规则 = 匹配条件（`when`）+ 操作序列（`ops`）。匹配维度：`client` / `field` / `method` / `pathRegex` / `modelRegex`。

| 操作类型         | 描述         | 参数                           |
| ---------------- | ------------ | ------------------------------ |
| `set`            | 完全替换     | `text`                         |
| `append`         | 追加到末尾   | `text`                         |
| `prepend`        | 插入到开头   | `text`                         |
| `replace`        | 替换匹配内容 | `match`/`regex`, `replacement` |
| `delete`         | 删除匹配内容 | `match`/`regex`                |
| `insert_before`  | 在匹配前插入 | `match`/`regex`, `text`        |
| `insert_after`   | 在匹配后插入 | `match`/`regex`, `text`        |

两条典型规则：

- **系统提示词修改**（请求侧，`field: system`）：在客户端原始系统提示词的基础上追加注入内容，原文保留不变
- **思维链注入**（响应侧，`field: thinking`）：在模型思维链开始处注入内容，模型原生思考过程完整保留

所有规则可在 Web UI 中可视化编辑并用沙盒预览测试。

## 📝 配置文件

配置发现顺序（后者覆盖前者）：

1. 全局配置: `~/.config/promptxy/config.json`
2. 项目配置: 从工作目录向上最多 3 级查找 `promptxy.config.json`
3. 环境变量: `PROMPTXY_CONFIG` 直接指定配置文件路径（优先级最高）

环境变量覆盖：`PROMPTXY_PORT`（端口）、`PROMPTXY_HOST`（主机）、`PROMPTXY_DEBUG`（调试）、`PROMPTXY_MAX_HISTORY`（历史保留条数）。

### 最小配置示例

```json
{
  "listen": { "host": "127.0.0.1", "port": 7070 },
  "suppliers": [
    {
      "id": "claude-anthropic",
      "name": "claude-anthropic",
      "displayName": "Claude (Anthropic)",
      "baseUrl": "https://api.anthropic.com",
      "protocol": "anthropic",
      "enabled": true,
      "auth": { "type": "none" },
      "supportedModels": []
    }
  ],
  "routes": [
    {
      "id": "route-claude-default",
      "localService": "claude",
      "defaultSupplierId": "claude-anthropic",
      "enabled": true
    }
  ],
  "rules": [],
  "storage": { "maxHistory": 1000 },
  "debug": false
}
```

> 💡 完整字段说明参考 [配置参考文档](docs/configuration.md)。供应商 `auth.type=none` 表示透明转发客户端鉴权头。

## 📚 API 端点

所有管理 API 在统一服务器上，前缀 `/_promptxy/`：

- `GET /_promptxy/health` - 健康检查
- `GET /_promptxy/events` - SSE 实时推送
- `GET /_promptxy/requests` - 请求历史列表
- `GET /_promptxy/requests/:id` / `DELETE /_promptxy/requests/:id` - 请求详情/删除
- `GET /_promptxy/config` / `POST /_promptxy/config/sync` - 配置获取/同步
- `POST /_promptxy/rules` / `PUT /_promptxy/rules/:id` / `DELETE /_promptxy/rules/:id` - 规则 CRUD
- `GET/POST/PUT/DELETE /_promptxy/suppliers...` - 供应商管理（含 `/:id/toggle`）
- `POST /_promptxy/preview` - 规则沙盒预览
- `POST /_promptxy/requests/cleanup` - 清理数据
- `GET/POST /_promptxy/settings` - 设置
- `GET /_promptxy/stats` / `GET /_promptxy/database` - 统计/数据库信息

## 🛠️ 常见问题排查

### 400: route_invalid / 路由协议不合法

`/codex`、`/gemini`、`/chat` 入口选择了不匹配协议的供应商，或模型映射规则的 `targetSupplierId` 协议不符。按上文"入口协议约束"修正。

### 400: 模型映射配置无效

常见原因：`targetSupplierId` 不存在；`outboundModel` 不在目标供应商 `supportedModels` 中（当其非空时）。检查供应商列表与规则字段。

### 迁移旧配置

```bash
tsx scripts/migrate-config.ts ~/.config/promptxy/config.json
```

自动完成：`supplierId` → `defaultSupplierId`、移除 `transformer`、`claudeModelMap` → `modelMapping.rules[]`、`modelMapping.rules[].target` → `outboundModel`（会自动备份原文件）。

## 📚 文档

- **[配置参考](docs/configuration.md)** - 完整的配置文件说明，包括所有配置项和环境变量
- **[使用指南](docs/usage.md)** - CLI 配置详解、规则引擎语法和常见用例
- **[架构设计](docs/architecture.md)** - 项目架构、技术栈和数据流设计
- **[项目背景](docs/origin_and_requirements.md)** - 项目初衷、需求溯源和设计决策

## 🛠️ 开发

```
promptxy/
├── backend/src/promptxy/     # 后端核心
│   ├── gateway.ts            #   统一网关（代理 + 规则 + 转发）
│   ├── config.ts             #   配置管理
│   ├── database.ts           #   SQLite 存储
│   ├── api-handlers.ts       #   管理 API
│   ├── rules/engine.ts       #   规则引擎
│   └── adapters/             #   各协议适配器 (claude/codex/gemini)
├── frontend/                 # Web UI (React + HeroUI + Zustand + Vite)
├── scripts/                  # 开发/构建脚本
├── docs/                     # 文档
└── openspec/                 # OpenSpec 规范
```

**技术栈** — 后端：Node.js + TypeScript + SQLite（原生 HTTP Server）；前端：React 18 + HeroUI + Tailwind CSS + TanStack Query + Vite

**测试** — `npm test`（后端 vitest）、`npm run test:frontend`

## 🔒 安全性

- 默认绑定 `127.0.0.1`，仅本机可访问
- 不存储 API 密钥（透明转发，不落盘）
- 请求历史自动清理（默认保留最近 1000 条，可配置）

## 📄 许可

MIT License

---

**PromptXY** - 让规则管理变得简单而强大
