# Pocket Coding — 系统设计文档（MVP）

> Vibe code anywhere — 把 Claude Code / Codex 等 CLI AI 编程工具装进口袋。
> 手机 / 平板 App ↔ 用户已有的公网云主机 ↔ 主机上已安装的 CLI AI coding 工具。

---

## 1. 产品概述

### 1.1 一句话定位
一个跑在移动端的「AI 编程遥控器」：通过一个漂亮、顺畅的移动端 App，连接到**用户自己已有**的公网云主机，驱动主机上**已安装**的 Claude Code / Codex CLI 进行对话式 / Agent 式编程。

### 1.2 用户前提（必须）
- 拥有一台公网可访问的云主机（有公网 IP 或域名）
- 主机已装：Node.js 18+、tmux、git
- 主机已装至少一个 CLI AI 工具：`claude`（Claude Code）或 `codex`
- 主机上已有项目代码（用户自己的仓库）
- 用户已自行配置好 AI 工具的 API Key（Anthropic/OpenAI 等）

**pocket-agent 不负责创建环境、不负责安装 CLI 工具、不负责托管代码。** 只做连接和驱动。

### 1.3 核心场景
- 通勤/走路时用**语音**丢一句需求："给登录页加个记住密码"，Agent 在云端跑，手机收推送看结果。
- 排队时快速 review Agent 改的代码 diff，一键 Approve / Reject。
- 半夜灵感来了，打开 App 继续白天没跑完的 session（**断线续跑**）。
- 在 iPad 上左右分栏：左边对话、右边实时预览前端改动。

### 1.4 设计目标
1. **多工具、可扩展**：内置 Claude Code / Codex，通过 Tool Adapter 抽象，新增工具只写一个适配器。
2. **好看好用的移动端**：Chat 为中心 + 移动端原生交互（语音、滑动审批、底部弹层、推送），代码 diff / 文件树 / 终端全部做移动端适配。支持手机和平板（响应式双栏/三栏）。
3. **Web 预览 & 前后端联调**：AI 在云主机上生成/修改的前端代码，能一键把 dev server 跑起来，通过 App 内嵌 WebView **实时预览**；后端服务同在云主机（或可达），前端预览直接连真实后端 API，完成**前后端联调测试**。
4. **对话历史 + 检查点/回滚 + Diff Baseline**：每次 coding 对话及其对文件的修改都持久化保留；**每次改动前**自动打检查点，可回退到任意一次改动前的状态；**接受变更后**删除该次改动的检查点代码快照，只保留对话记录，同时把 Diff 的 baseline 前移。

### 1.5 非目标（明确不做）
- ❌ 帮用户创建/托管开发环境（不自建 VM、不装 claude/codex）
- ❌ Provisioning / 多租户隔离 / 计费
- ❌ 中继 / NAT 穿透（用户主机需公网 IP）
- ❌ 多主机切换（MVP 单主机）
- ❌ Web / Desktop 客户端（仅 iOS / Android，手机 + 平板）
- ❌ 多用户共享一台主机

### 1.6 核心技术挑战
| 挑战 | 方案 |
|---|---|
| CLI 工具是交互式 PTY 程序 | 后端用 PTY 托管进程，双向流式 |
| 移动网络不稳定、App 会被杀后台 | 会话跑在 tmux 持久进程里，重连后回放 scrollback |
| 不同工具输入输出格式各异 | Tool Adapter 抽象；优先用工具的结构化模式（如 stream-json） |
| 公网主机跑 Agent 高危 | 设备配对 + JWT + TLS + 工作区隔离 + 命令审批 |
| 手机屏幕小 | Chat 主界面 + 卡片化 tool call / diff + 手势交互 |
| 云端 dev server 要在手机上看到并联调 | 预览管理器托管 dev server + 鉴权反向代理（HMR/WebSocket 透传）→ App 内嵌 WebView |
| 改动可回退、接受后清理、diff 基线前移 | 影子 Git（shadow repo）打检查点 |

---

## 2. 参考竞品：AI Coding 工具前端分析

### 2.1 共性能力
| 能力 | 说明 | 在本 App 的取舍 |
|---|---|---|
| 对话式主界面 | 与 AI 多轮对话 | ✅ 移动端第一屏，核心 |
| Agent / Plan 模式 | AI 自主规划→执行多步 | ✅ 移动端尤其需要 |
| Tool Call 可视化 | 展示 AI 调用的工具，可审批 | ✅ 卡片化 + 滑动审批 |
| 代码 Diff / Apply | 展示改动，逐块 accept/reject | ✅ 移动端 diff 查看器 |
| 文件树 / 工作区 | 浏览项目文件 | ✅ 简化版文件浏览器 |
| 内置终端 | 查看/执行命令 | ✅ 终端页（xterm 风格） |
| 上下文引用 @file | 把文件加入上下文 | ✅ @ 选择器 |
| 多会话管理 | 并行多个任务 | ✅ 会话列表 |
| Checkpoint / 回滚 | 回到某个改动前状态 | ✅ 影子 git 快照 |
| 实时预览 / 内嵌浏览器 | 运行 dev server 看效果 | ✅ 预览页 + 鉴权反代 + 联调 |
| 对话历史留存 | 会话/改动可回看 | ✅ 消息全量落库 + 检查点时间线 |

### 2.2 移动端哲学
> **不是把 IDE 搬到手机，而是做一个「AI Agent 指挥官 + 结果审阅台」。**

- 主体验 = **对话 + 审阅 + 审批**，不是手写代码。
- 用**语音**降低输入成本。
- 用**推送**把「等 Agent 跑」的时间还给用户。
- 编辑代码是低频兜底能力。

---

## 3. App 前端设计

### 3.1 技术选型
- **框架**：Flutter 3.44+（一套代码 iOS/Android，手机/平板响应式）
- **终端渲染**：`xterm.dart`
- **代码高亮**：`flutter_highlight`
- **实时通信**：`web_socket_channel`
- **推送**：FCM（Android）/ APNs（iOS）
- **状态管理**：Riverpod
- **路由**：go_router
- **本地存储**：hive

### 3.2 信息架构
```
Pocket Coding
├── 引导/连接 Onboarding
│   └── 添加云主机（IP/域名 + 配对码）
├── 首页 Home
│   └── 项目/会话列表
├── 会话 Chat（核心）
│   ├── 消息流（用户/AI/ToolCall/Diff 卡片 + 检查点标记）
│   ├── 输入区（文本 + 语音 + @引用 + 工具/模型切换）
│   └── 运行状态条
├── Diff 审阅
├── Web 预览 Preview
├── 检查点时间线 Checkpoints
├── 文件浏览器 File Explorer
├── 终端 Terminal
└── 设置 Settings
    ├── 云主机管理
    ├── AI 工具管理
    └── 通知/主题/安全
```

### 3.3 关键页面
| 页面 | 核心功能 |
|---|---|
| Connect | 主机地址 + 一次性配对码 + TLS 标识 + 工具探测 |
| Home | 项目/会话列表 + 状态点 + 新建会话 FAB |
| Chat | 卡片化消息流 + 语音输入 + 滑动审批 + 检查点标记 |
| Diff | 文件 tab + hunk 级接受/拒绝 + 接受/回退双动作 |
| Terminal | xterm PTY 直连 + 快捷键条 |
| Preview | URL 栏 + 设备宽度切换 + 内嵌 WebView + 选取元素回传 |
| Checkpoints | 时间线 + 待接受/已接受/已回退状态 + 回退操作 |

### 3.4 视觉原则
- 暗色为主，等宽字体展示代码
- 运行状态可见（思考中/执行中/等待审批 动效）
- 关键操作触觉反馈
- 任务完成推送通知
- 手机单栏 / 平板双栏（≥700px）/ 三栏（≥1024px）

---

## 4. 云主机后端架构

### 4.1 架构总览
```
┌─────────────────────────────────────────────────────────────┐
│                    手机 / 平板 App (Flutter)                  │
└───────────────┬───────────────────────────┬─────────────────┘
        WSS (实时流)                    HTTPS (管理 API)
                │                             │
┌───────────────▼─────────────────────────────▼─────────────────┐
│                    用户云主机后端 (公网 IP)                     │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  API Gateway  (TLS 终止 / JWT 认证 / 限流 / 路由)          │ │
│  └───────┬───────────────────────────────┬──────────────────┘ │
│          │                                │                    │
│  ┌────────────┐ ┌──────────┐ ┌────────────┐ ┌──────────────┐  │
│  │ Auth Service│ │ REST API │ │ WS Sess Hub│ │ Preview Proxy│  │
│  │ 配对/JWT    │ │项目/文件/git│ │ 实时消息网关│ │ 鉴权反代 dev  │  │
│  └────────────┘ └────┬─────┘ └─────┬──────┘ └──────┬───────┘  │
│                      │             │                   │       │
│                       ┌─────▼─────────────────────▼────┐       │
│                       │      Session Manager           │       │
│                       │  会话生命周期 / 路由 / 重连恢复 │       │
│                       └──────────────┬─────────────────┘       │
│                                      │                         │
│                       ┌──────────────▼─────────────────┐       │
│                       │       Tool Adapter Layer        │       │
│                       │ ClaudeCode │ Codex │ ...        │       │
│                       └──────────────┬─────────────────┘       │
│                                      │                         │
│              ┌───────────────────────┼──────────────────────┐ │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────┐ ┌──────────┐ │ │
│  │ PTY/Proc Mgr │ │ tmux 持久会话 │ │File/Git  │ │ Checkpoint│ │ │
│  │ (node-pty)   │ │ (断线续跑)    │ │ Service  │ │ 影子git快照│ │ │
│  └──────────────┘ └──────────────┘ └──────────┘ └──────────┘ │ │
│  ┌────────────────────────────────────────────────────────┐ │ │
│  │  Preview/Dev Server Mgr (托管 vite/next/... + 端口探测) │ │ │
│  └────────────────────────────────────────────────────────┘ │ │
│  ┌────────────────────────────────────────────────────────┐ │ │
│  │  Workspace (用户已有的项目目录，pocket 不创建只读)        │ │ │
│  │  $ claude / codex          $ npm run dev                │ │ │
│  │  .pocket/shadow.git (检查点影子仓库, 与用户 .git 隔离)   │ │ │
│  └────────────────────────────────────────────────────────┘ │ │
│                                                              │
│  存储: SQLite(元数据/对话历史) · FS(代码/影子git)            │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 技术选型
- **语言/运行时**：Node.js 18+ (TypeScript)
- **Web 框架**：Fastify
- **实时**：`ws`
- **PTY**：`node-pty`
- **会话持久**：`tmux`（每会话一个 tmux session）
- **存储**：SQLite（better-sqlite3）
- **JWT**：`jose`
- **校验**：`zod`
- **Git**：`simple-git`
- **TLS**：Caddy 反代自动签 Let's Encrypt

### 4.3 核心：Tool Adapter Layer
所有工具差异收敛到统一接口。新增工具 = 新增一个 Adapter 文件。

```typescript
type AgentEvent =
  | { type: 'message'; role: 'assistant'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown; danger?: boolean }
  | { type: 'tool_result'; id: string; output: string }
  | { type: 'diff'; file: string; patch: string }
  | { type: 'plan'; steps: string[] }
  | { type: 'status'; state: 'running'|'waiting_approval'|'done'|'error' }
  | { type: 'raw'; data: string };

interface ToolAdapter {
  id: 'claude-code' | 'codex';
  displayName: string;
  mode: 'structured' | 'pty';
  detect(): Promise<{ installed: boolean; version?: string }>;
  buildCommand(opts: LaunchOptions): { cmd: string; args: string[]; env: Record<string,string> };
  parseChunk?(chunk: Buffer): AgentEvent[];
  encodeInput(text: string): Buffer;
  encodeApproval?(callId: string, approve: boolean): Buffer;
  interrupt(session: Session): void;
}
```

各工具落地：
| 工具 | 推荐模式 | 集成方式 |
|---|---|---|
| Claude Code | structured | `claude --output-format stream-json --input-format stream-json`，逐行 JSON 解析 |
| Codex | structured / pty | 优先 JSON 输出模式，不支持时降级 pty |

### 4.4 会话管理 + 断线续跑
**会话与连接解耦**：
1. 每个会话在云端跑在一个 tmux session 里，进程生命周期独立于 WebSocket。
2. 后端为每个会话维护环形输出缓冲区（scrollback，最近 256KB + 事件 seq 号）。
3. App 重连时带 `lastSeq`，后端回放差量。
4. Agent 跑完即使 App 离线 → 结果落库 + 推送通知。

```
会话状态机:
 CREATED → RUNNING ⇄ WAITING_APPROVAL → DONE
                ↘ ERROR
      (重连不改变状态，只是重新 attach + 回放)
```

### 4.5 通信协议
**HTTPS REST（管理面）**：
```
POST /api/pair                 设备配对（一次性码换 JWT）
GET  /api/hosts/tools          探测已安装的 AI 工具
GET  /api/projects             工作区列表（扫用户已有目录）
GET  /api/files?path=          浏览/读取文件
PUT  /api/files                写文件
GET  /api/sessions             会话列表
POST /api/sessions             新建会话（选 tool/project/model）
GET  /api/sessions/{id}/messages   对话历史

# Web 预览 / 前后端联调
POST /api/preview/start        启动/重启 dev server
GET  /api/preview/status       dev server 状态 + 预览 URL + 日志尾部
POST /api/preview/stop         停止 dev server
ANY  /preview/{token}/*        鉴权反向代理 → dev server（含 HMR WS 升级）

# 检查点 / 回滚 / baseline
GET  /api/sessions/{id}/checkpoints
POST /api/checkpoints/{cpId}/rollback
POST /api/sessions/{id}/accept
GET  /api/sessions/{id}/diff
```

**WSS（实时面）**——统一信封：
```jsonc
// Client → Server
{ "t": "attach", "sessionId": "...", "lastSeq": 128 }
{ "t": "input",  "sessionId": "...", "text": "给登录页加记住密码" }
{ "t": "approve","sessionId": "...", "callId": "c1", "approve": true }
{ "t": "interrupt", "sessionId": "..." }
{ "t": "resize", "cols": 80, "rows": 24 }

// Server → Client (每条带 seq)
{ "seq": 129, "t": "event", "sessionId": "...", "event": { /* AgentEvent */ } }
{ "seq": 130, "t": "status","sessionId": "...", "state": "waiting_approval" }
{ "seq": 131, "t": "checkpoint", "sessionId": "...", "cpId": "cp7", "kind": "created" }
{ "seq": 132, "t": "preview", "sessionId": "...", "state": "ready", "url": "/preview/tok/" }
```

### 4.6 安全
- **传输**：全链路 TLS（WSS/HTTPS），Caddy 自动签 Let's Encrypt
- **认证**：设备配对码（一次性，6 位，10 分钟 TTL）换 JWT（RS256，30 天）
- **授权**：所有 REST/WS 校验 JWT
- **命令审批**：危险操作（rm/push/curl|sh 等）触发 `waiting_approval`，App 端确认
- **密钥管理**：AI 工具的 API Key 由用户自行配置在主机，pocket-agent 不接触
- **审计日志**：所有命令与文件写操作落 SQLite
- **限流**：配对接口 5 分钟 3 次失败 → 限流 15 分钟

### 4.7 部署形态
**单机模式（MVP）**：用户在自己的云主机上跑 pocket-agent，`docker compose up` 即用。App 直连该主机公网 IP/域名。

### 4.8 Web 预览 & 前后端联调
**Preview / Dev-Server Manager**
1. 托管 dev server：`POST /api/preview/start` 在项目目录下跑 `npm run dev`，命令可配置/自动嗅探 `package.json` scripts。
2. 端口探测：从进程 stdout 解析监听端口，或注入 `--port`。
3. 进程生命周期：跑在 tmux detached，崩溃上报，支持一键重启。

**Preview Proxy（带鉴权反向代理）**
- dev server 只监听 `127.0.0.1`，不直接对公网开放。
- 网关提供 `ANY /preview/{token}/*`，反代到 `http://127.0.0.1:{devPort}/*`：
  - 鉴权：`token` 为短时预览令牌（JWT 派生、可撤销）
  - WebSocket 升级透传：HMR / Vite websocket 走 `Upgrade` 透传
  - 路径/host 改写：处理 base path、Host/Origin 头
- App 内 WebView 直接加载 `https://host/preview/{token}/`

**前后端联调**：前端与后端 API 同在这台云主机，预览页里的 `fetch('/api')` 经反代或直连打到真实后端。

**移动端体验**：设备宽度切换、刷新、控制台/网络日志、**选取元素 → 发送到对话**。

### 4.9 对话历史 + 检查点 / 回滚 + Diff Baseline
**存储分层**
- **对话历史**：`Message` 全量落 SQLite，永不因回滚删除。
- **代码快照**：影子 Git 仓库 `.pocket/shadow.git`（`git --git-dir` 指向它、`--work-tree` 指向项目），与用户自己的 `.git` 完全隔离。

**核心机制**
```
baseline = B0 (初始/上次接受态)

回合1: 用户消息 → [改动前打检查点 C1 = 快照(B0)] → Agent 改文件 → 工作树 W1
        Diff = W1 vs baseline(B0)
        · 回退 C1 ⇒ 工作树恢复到 B0
        · 接受   ⇒ baseline 前移到 W1；prune 掉 C1 快照；保留回合1对话

回合2: 用户消息 → [C2 = 快照(当前 baseline)] → 改文件 → W2  … 以此类推
```

要点：
1. 检查点 = 改动前快照，在 Agent 真正落盘前触发。
2. 回退：影子 git 把工作树 restore 到该检查点 commit。
3. 接受变更：baseline ref 前移；prune 掉不再需要的改动前快照（`git update-ref -d` + `git gc`）；此后 diff 以新 baseline 为基准。
4. Diff baseline：始终维护 `baseline` ref；`GET /diff` = 工作树 vs baseline。
5. 支持整体接受与按 hunk/文件接受。

---

## 5. 数据模型（SQLite）
```
Device       { id, name, publicKey, pairedAt, lastSeenAt }
Session      { id, projectId, toolId, model, state, tmuxName, lastSeq, baselineRef, createdAt }
Message      { id, sessionId, seq, role, type, payload(json), turnId, createdAt }
Approval     { id, sessionId, callId, command, decision, decidedAt }
Checkpoint   { id, sessionId, turnId, shadowCommit, status('pending'|'accepted'|'rolledback'),
               files(json), createdAt }
Preview      { id, sessionId, projectId, cmd, port, token, state, createdAt }
AuditLog     { id, sessionId, action, target, meta(json), at }
```

---

## 6. MVP 范围

### 6.1 必须有
- 配对 + JWT 鉴权
- 多会话管理
- Chat 卡片化：Plan / ToolCall / Diff / 命令输出 / 状态
- Tool Adapter：Claude Code + Codex（structured + pty 双模式）
- Diff 审阅：hunk 级 + 全量接受 + 回退改动前
- 检查点 + 回滚：影子 git、baseline 前移、接受后 prune
- Web 预览 + 前后端联调：dev server 托管 + 鉴权反代 + HMR + 选取元素回传
- 文件浏览器（读 + 简单编辑）
- 终端页（PTY 直连 + 快捷键条）
- 危险命令审批
- 语音输入
- 推送通知
- 断线续跑（tmux + seq 回放）
- 手机 + 平板响应式

### 6.2 明确不做
- 托管环境 / Provisioning
- 多租户隔离 / 计费
- 中继 / NAT 穿透
- 多主机切换
- Web / Desktop 客户端

---

## 7. 目录结构
```
pocket-coding/
├── docs/                     # 设计文档
├── mockups/                  # 视觉稿
├── server/                   # 用户主机后端 (Node + TS)
│   ├── src/
│   │   ├── gateway/          # HTTP/WS 网关 + 认证
│   │   ├── session/          # Session Manager + tmux/pty
│   │   ├── adapters/         # ClaudeCode/Codex 适配器
│   │   ├── checkpoint/       # 影子 git 快照/回滚/baseline
│   │   ├── preview/          # dev server 托管 + 鉴权反代
│   │   ├── files/            # 文件/git 服务
│   │   ├── push/             # APNs/FCM
│   │   ├── store/            # SQLite
│   │   └── protocol.ts       # AgentEvent / WS 信封（前后端共享）
│   ├── Caddyfile.example
│   ├── docker-compose.yml
│   └── package.json
└── app/                      # Flutter 移动端
    └── lib/
        ├── features/{connect,home,chat,diff,checkpoints,preview,files,terminal,settings}
        ├── core/{ws,api,push,state}
        └── widgets/
```
