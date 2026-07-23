# Pocket Coding 重构与补齐开发计划

> 目标：让 App 能「像在电脑命令行一样」使用 Claude Code / Codex / CodeBuddy，尽量复刻全部功能；
> 且**同一个 session 在 App 与电脑命令行之间双向保持历史记忆**。
>
> 本计划基于对现有代码的逐行核对编写，所有改动都标注了具体文件与函数。

---

## 1. 现状根因（为什么现在做不到）

| 现象 | 根因（代码证据） |
|---|---|
| 无法复刻 TUI / 斜杠命令 / 交互 | 走非交互 `--output-format stream-json`，每回合 `spawn` 一次性进程（`manager.ts:122-253 spawnProcess`、`377-410 input`），`stdin.end()` 关闭输入 |
| 实时审批不生效 | `maybeGateApproval` 想写回 stdin，但 stdin 已被 `input()` 关闭，写入静默失败，只落库审计（`manager.ts:358-371`）；codex `encodeApproval` 直接返回空 |
| `resize` / 真终端缺失 | 进程是裸 `child_process.spawn` 而非 pty；`interrupt` 给不存在的 tmux pane 发 `C-c`（`claude-code.ts:265-275`），实际靠 `SIGINT`（`manager.ts:419-425`） |
| 命令行开的会话 App 看不到 | session 只能由 `POST /api/sessions` 创建（`http.ts:145`），没有扫描/导入主机已有会话的接口 |
| App 开的会话命令行接不上 | `external_session_id` 不对外暴露（`GET /api/sessions` 返回里没有，`http.ts:125-143`） |
| 历史双源分叉 | App 历史来自 SQLite `messages`（`manager.ts:468-485`），工具真实记忆在 `~/.claude/projects` / `~/.codex/sessions`，两者不是同一份 |
| App 推送不送达 | 后端 APNs/FCM 发送侧完整（`push/manager.ts`），但 App 从不调用 `POST /api/devices/push/register`，设备拿不到 token |

---

## 2. 目标架构（重构后）

**核心转变：一次性结构化进程 → 双通道常驻会话 + 单一事实源**

```
                    ┌─────────────────────────────────────────┐
   App              │              Server (Node)                │
 ┌──────┐   WS      │  ┌────────────────┐   ┌────────────────┐  │
 │ Chat │◀────────▶│  │ Structured 通道 │   │  PTY 通道       │  │
 │ 卡片 │  events   │  │ stream-json     │   │  node-pty       │  │
 ├──────┤           │  │ 常驻·stdin常开  │   │  真 TTY·xterm   │  │
 │ Term │◀────────▶│  │ diff/审批/工具  │   │  斜杠命令/TUI/  │  │
 │xterm │  bytes    │  └───────┬────────┘   │  任意 shell     │  │
 └──────┘           │          │            └───────┬────────┘  │
                    │          └──────┬─────────────┘           │
                    │        同一 cwd · 同一 external_session_id  │
                    │                 │                          │
                    │        ┌────────▼─────────┐                │
                    │        │  单一事实源       │                │
                    │        │ 工具原生会话文件   │◀── 电脑命令行   │
                    │        │ ~/.claude/projects│    claude/codex │
                    │        │ ~/.codex/sessions │    --resume     │
                    │        └──────────────────┘                │
                    │        SQLite = 索引/缓存/审计层            │
                    └─────────────────────────────────────────┘
```

关键原则：
1. **单一事实源 = 工具原生会话文件**。SQLite 从「历史真相」降级为「索引 + UI 缓存 + 审计」。App 展示历史时以工具文件为准做对账，命令行侧新增回合能回流。
2. **双通道共存**：Structured 通道保留现有结构化体验（消息/思考/工具卡片/diff/检查点/审批）；PTY 通道提供真终端（斜杠命令、TUI、任意 shell）。两通道共享同一 `cwd` 与同一 `external_session_id`。
3. **同一时刻单端写**：对一个 `external_session_id` 加活跃租约，避免 App 与命令行同时 resume 导致会话文件竞态。

---

## 3. 里程碑与任务拆解

按依赖顺序排列。每个里程碑可独立验收、独立合并。

### M1 — 会话记忆打通（诉求②，风险最低，先做）

不改内核，先把「记忆共享」的读写两端补齐。

**M1.1 暴露 external_session_id + resume 引导**
- 改 `server/src/gateway/http.ts` `GET /api/sessions` 与新增 `GET /api/sessions/:id`：返回 `externalSessionId`、`toolId`、`cwd`。
- 改 `server/src/protocol.ts` `SessionSummary` / `SessionDetail` 增加 `externalSessionId?: string`、`cwd?: string`。
- App `features/home` / 会话详情增加「在电脑继续」入口：展示可复制命令
  `claude --resume <id>` / `codex exec resume <id>` / `codebuddy --resume=<id>`。
- 验收：App 建会话跑一轮后，能拿到 id，电脑上 `--resume` 能接上同一对话。

**M1.2 主机已有会话发现接口**
- 新增 `server/src/hosts/session-scanner.ts`：
  - 扫 `~/.claude/projects/**/*.jsonl`（claude 每 project 一个目录，内含会话 jsonl）
  - 扫 `~/.codex/sessions/**/*.json`（codex thread）
  - 解析出 `{ toolId, externalSessionId, cwd, updatedAt, summary(首条/末条摘要), messageCount }`
- 新增路由 `GET /api/hosts/sessions?tool=&cwd=`：返回可导入列表（按 updatedAt 倒序）。
- 验收：电脑上用 claude 开一个会话，调该接口能列出它。

**M1.3 导入已有会话**
- 新增 `POST /api/hosts/sessions/import`：入参 `{ toolId, externalSessionId, cwd }`；
  在 SQLite 建一条 session（`has_run_once=1`、`external_session_id=<id>`、`state='idle'`），
  并**回填历史**（见 M1.4）。
- App `features/home` 增加「导入电脑会话」入口：列表选择 → 建卡片 → 进入 chat。
- 验收：命令行开的会话能在 App 里出现并继续对话（诉求②「命令行→App」打通）。

**M1.4 历史对账 / 回流（单一事实源）**
- 新增 `server/src/hosts/transcript-loader.ts`：把工具会话文件解析成 `AgentEvent[]`
  （复用各 adapter 的 `parseJsonLine`），映射进 `messages` 表；带 `source` 标记（`app`/`external`）。
- session `attach`（`ws.ts`）或 `GET /messages` 前，做增量对账：
  比对工具文件与 SQLite 的回合数，把命令行侧新增回合补录，避免 App 端历史缺失/分叉。
- store 改造：`messages` 增加 `source TEXT`、`external_turn_ref TEXT`（`sqlite.ts` migrate 加 `ensureColumn`）。
- 验收：App↔命令行交替对话，两端看到的历史一致。

---

### M2 — PTY 常驻会话内核（诉求①③地基，重构核心）

把「一次性 spawn」换成「常驻 pty 进程」，这是复刻交互能力和实时审批的前提。

**M2.1 引入 node-pty，改造会话进程模型**
- `server/package.json` 增加依赖 `node-pty`。
- 改 `server/src/session/manager.ts`：
  - `Session.proc` 类型换成 `IPty | null`；进程**常驻**，不再每回合 spawn+end。
  - `input()`：进程不存在才 spawn；已存在则直接向 pty 写入本回合输入，**不关闭 stdin**。
  - `resize(cols, rows)`：调用 `pty.resize()`（真实现，替换现 no-op）。
  - `interrupt()`：`pty.write('\x03')`（真 Ctrl-C），删除 tmux 伪逻辑。
  - `close`/退出：进程真正退出才置 `idle`；崩溃重启用 `--resume`。
- 验收：一个进程内连续多轮对话不再冷启动；resize/中断真实生效。

**M2.2 adapter 支持交互式启动 + 实时审批**
- `protocol.ts` `ToolAdapter` 已有 `mode: 'structured' | 'pty'`；为每个 adapter 落实：
  - claude/codebuddy：保留 stream-json（结构化通道），但**保持 stdin 常开**跨回合；
    `encodeApproval` 改为真正的 control/permission 响应帧（按 CLI 当前协议），实时回传决策。
  - `maybeGateApproval`（`manager.ts:314-375`）：改为在 stdin 常开前提下真正写回决策，
    审批不再只是审计。
- 验收：危险命令触发 App 审批卡片 → 滑动同意/拒绝 → 工具行为实时受控。

**M2.3 codex 审批与 sandbox**
- `adapters/codex.ts`：接入 codex 的交互审批协议（若 CLI 支持）；不支持则保留静态
  `--sandbox` + `--ask-for-approval` 映射，并在 App 明示「codex 为静态沙箱模式」。
- 验收：codex 会话的权限模式行为与 App 显示一致。

---

### M3 — App 真终端与斜杠命令（诉求①）

**M3.1 后端 PTY 终端通道**
- 复用 `raw` 事件或新增 WS 帧 `{ t: 'term'; sessionId; data }`（`protocol.ts`）承载 pty 字节流。
- `ws.ts`：客户端 `input`/`resize` 直投 pty；服务端 pty `onData` 广播 `term` 帧。
- 斜杠命令（`/clear` `/model` `/mcp` `/agents` 等）通过 pty 通道直投，天然支持。

**M3.2 App xterm 终端页**
- App 增加依赖 `xterm.dart`（或等价终端渲染库）。
- 新增 `app/lib/features/terminal/terminal_page.dart`：
  - 连接 WS `term` 帧渲染 ANSI；键盘输入回传；`resize` 上报 cols/rows。
  - chat 页「命令输出」卡片增加「在终端打开」跳转。
- `app/lib/core/ws` / `core/state` 增加 term 通道的收发与状态。
- 验收：App 终端里能敲 `git status`/`npm test`，能跑 `/model` 等斜杠命令并看到 TUI 输出。

---

### M4 — 推送闭环（补 P6 最大缺口）

**M4.1 App 集成 FCM/APNs**
- `app/pubspec.yaml` 增加 `firebase_messaging`（Android/iOS）。
- iOS：配 APNs（`app/ios` 增 capability + `GoogleService-Info.plist`）；Android：`google-services.json`。
- 新增 `app/lib/core/push/push_service.dart`：申请权限 → 取 token → 调
  `POST /api/devices/push/register`（后端已实现，`http.ts:381-388`）。
- App 启动/配对成功后注册；退出登录时 `unregister`。

**M4.2 通知点击深链**
- 收到 `{ sessionId, state }`（后端 `manager.ts:506-535 maybePush` 已发）→ 点击跳转对应 session。
- 验收：App 退后台，触发 `waiting_approval`/`done`/`error` 时真机收到推送并可点进会话。

---

### M5 — 并发安全与健壮性

**M5.1 会话活跃租约**
- store 增加 `session_leases`（`external_session_id` → `holder`(app/cli), `heartbeat_at`）。
- attach/input 前检查租约：同一 `external_session_id` 同时仅一端活跃，另一端置只读并提示。
- 验收：App 与命令行同时操作同一会话时不会互相覆盖会话文件。

**M5.2 rehydrate 与崩溃恢复**
- `manager.ts:568 rehydrate` 后，pty 进程按需 `--resume` 拉起；对账历史（复用 M1.4）。

---

### M6 — 平板适配与发布（P8 / P9）

**M6.1 响应式双栏/三栏**
- App 用 `LayoutBuilder`：宽屏左会话列表 / 中聊天 / 右 diff·预览·终端。

**M6.2 打包与部署**
- server：Dockerfile + 启动脚本；App：iOS/Android release 构建流程文档化。

---

## 4. 涉及文件清单（速查）

**Server**
- `src/session/manager.ts`（M2 核心重构：常驻 pty、input、interrupt、resize、审批）
- `src/adapters/*.ts`（M2 交互启动 + 真实 encodeApproval）
- `src/protocol.ts`（M1 REST 字段、M3 term 帧、审批帧）
- `src/gateway/http.ts`（M1 会话发现/导入/暴露 id）
- `src/gateway/ws.ts`（M3 term 通道、M5 租约）
- `src/store/sqlite.ts`（M1.4 messages.source、M5 session_leases）
- `src/hosts/session-scanner.ts`、`src/hosts/transcript-loader.ts`（M1 新增）
- `package.json`（node-pty）

**App**
- `lib/features/terminal/terminal_page.dart`（M3 新增）
- `lib/features/home/*`（M1 导入/继续入口）
- `lib/core/ws`、`lib/core/state`（M3 term 通道）
- `lib/core/push/push_service.dart`（M4 新增）
- `lib/core/protocol.dart`（同步 protocol.ts 变更）
- `pubspec.yaml`（xterm、firebase_messaging）

---

## 5. 执行顺序与验收总表

| 里程碑 | 诉求 | 依赖 | 关键验收 |
|---|---|---|---|
| M1 会话记忆打通 | ② | 无 | 命令行↔App 会话互见、历史一致 |
| M2 PTY 常驻内核 | ①③ | 无（可与 M1 并行） | 常驻进程、实时审批生效 |
| M3 App 终端 | ① | M2 | 终端跑命令/斜杠命令/TUI |
| M4 推送闭环 | — | 无 | 真机收推送并深链 |
| M5 并发安全 | ② | M1、M2 | 双端不冲突 |
| M6 平板/发布 | — | 全部 | 双栏布局、可打包 |

建议先做 **M1（记忆共享，价值最高、风险最低）**，随后 **M2（内核重构）**，二者可并行推进。

## 6. 风险与回退
- **node-pty 原生编译**：需匹配 Node 版本，CI 里预编译；失败时回退结构化通道（保留现功能）。
- **工具会话文件格式变更**：scanner/loader 对未知字段容错，解析失败降级为「仅索引不回流」。
- **实时审批协议差异**：各 CLI 的 permission 协议不稳定；封装在 adapter 内，协议变更只改 adapter。
- **重构期间保持可用**：M2 用 feature flag（`config.ptyMode`）切换新旧内核，灰度验证后再默认开启。
