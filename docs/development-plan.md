# Pocket Coding — 开发计划

> 配套设计文档：`system-design.md`、`frontend-pages.md`、`brand-guidelines.md`
> 范围：MVP，仅手机 + 平板，用户自带主机 + 已装 claude/codex。

---

## 时间表总览

| 阶段 | 工作日 | 累计 | 产出 |
|---|---|---|---|
| Phase 0 · 骨架 | 2 | 2 | 仓库可起、协议契约敲定 |
| Phase 1 · 后端基础 | 4 | 6 | 配对 + Session + WS 流式 + 持久化 |
| Phase 2 · 检查点/Diff/审批 | 4 | 10 | 影子 git + baseline + 回退 |
| Phase 3 · Web 预览 | 3 | 13 | dev server 托管 + 鉴权反代 + 联调 |
| Phase 4 · App 基础 | 5 | 18 | 配对 + Home + Chat 流式 |
| Phase 5 · App coding UI | 5 | 23 | Diff/检查点/终端/文件 |
| Phase 6 · App 预览/手势/语音/推送 | 4 | 27 | 完整体验 |
| Phase 7 · 端到端测试 | 2 | 29 | 真机联调通过 |
| Phase 8 · 平板适配 | 1 | 30 | 双栏/三栏响应式 |
| Phase 9 · 打包发布 | 3 | 33 | TestFlight + Play Internal |

约 6-7 周，单人节奏。

---

## Phase 0 · 骨架（2 天）

### 后端
- `npm init` + 装 fastify / ws / node-pty / better-sqlite3 / jose / zod / simple-git
- TS 配置 + esbuild dev server
- `protocol.ts` 定义完整 `AgentEvent` 联合类型 + WS 信封

### App
- `flutter create pocket_coding`
- 装 riverpod / web_socket_channel / xterm / go_router / hive / flutter_highlight / speech_to_text / flutter_local_notifications
- iOS ATS 例外（dev 允许 localhost）+ Android cleartext

### 验收
- 后端 `npm run dev` 起在 :8080
- App `flutter run` 在模拟器起空白页

---

## Phase 1 · 后端 · 配对 + 会话 + WS 流式（4 天）

### Day 1 · 配对 + JWT
- `POST /api/pair/code` 生成 6 位码，10 分钟 TTL，落 SQLite
- `POST /api/pair` 验码换 JWT（RS256，30 天）
- WSS 握手校验 JWT
- 表：`devices / sessions / messages / approvals`

### Day 2 · Adapter + PTY
- `ToolAdapter` 接口（detect / buildCommand / parseChunk / encodeInput / encodeApproval / interrupt）
- `claude-code.ts`：`claude --output-format stream-json --input-format stream-json`，逐行 JSON → AgentEvent
- `codex.ts`：先 pty 兜底
- Session 启动：tmux session + spawn 进程，node-pty 接管

### Day 3 · WS + Scrollback
- C→S：`attach / input / approve / interrupt / resize`
- S→C：带 `seq` 的 `event`
- 环形缓冲 256KB + 最后 seq
- `attach(lastSeq)` → 回放差量

### Day 4 · REST + 持久化
- `GET /api/sessions`、`GET /api/sessions/:id/messages`
- 消息全量落库（turnId 关联）
- 工具探测 `GET /api/hosts/tools`

### 验收
- `wscat` 连本地 WSS，发 `input`，看到 stream-json 解析成 AgentEvent 流回
- 断开重连 seq 回放

---

## Phase 2 · 后端 · 检查点 + Diff + 审批（4 天）

### Day 1 · 影子 git
- 初始化 `.pocket/shadow.git`（`git --git-dir` 隔离用户 .git）
- 回合开始 → `git add -A && git commit` 打改动前快照
- `baseline` ref 维护

### Day 2 · Diff
- `GET /api/sessions/:id/diff` → 工作树 vs baseline，按文件分组返回 hunks
- `POST /api/sessions/:id/accept` → baseline 前移 + prune 该回合快照
- `POST /api/checkpoints/:cpId/rollback` → restore 工作树

### Day 3 · 部分接受
- `POST /api/sessions/:id/accept` 支持 `files[]` 或 `hunks[]`
- 部分接受 → baseline 只前移已接受部分

### Day 4 · 审批 + 检查点列表
- 危险命令检测（rm/push/curl|sh 等正则）→ `waiting_approval`
- `POST /api/sessions/:id/approve` 决议
- `GET /api/sessions/:id/checkpoints` 时间线

### 验收
- 跑一个回合 → 看 diff → 接受 → baseline 前移、快照清理
- 回退 → 工作树还原

---

## Phase 3 · 后端 · Web 预览 + 联调（3 天）

### Day 1 · Dev Server Manager
- `POST /api/preview/start`：spawn `npm run dev`（读 package.json 嗅探）
- 端口探测：正则匹配 stdout `localhost:PORT`
- 进程跑 tmux detached，崩溃上报

### Day 2 · 鉴权反代
- `ANY /preview/{token}/*` → `http://127.0.0.1:{port}/*`
- token：JWT 派生短时令牌，可撤销
- WebSocket Upgrade 透传（HMR）
- Host/Origin 头改写

### Day 3 · 元素选取 + 控制
- `POST /api/preview/element` 接收选择器/截图 → Agent 消息
- `GET /api/preview/status`、`POST /api/preview/stop`
- `GET /api/preview/logs` tail

### 验收
- App WebView 加载预览 URL，看到 vite dev server，HMR 改文件实时刷新

---

## Phase 4 · App · 配对 + Home + Chat 流式（5 天）

### Day 1 · Connect 页
- 主机地址 + 配对码输入
- 调 `/api/pair` 存 JWT 到 Hive
- 已配对直连

### Day 2 · WSS Client
- 单例：连接、心跳 30s、自动重连（指数退避 max 30s）
- `attach(sessionId, lastSeq)`
- 事件 → Riverpod state
- `connectivity_plus` 监听网络

### Day 3 · Home 页
- 会话列表（REST 拉取）
- 新建会话：选项目目录 + 选工具 + 选模型
- 会话卡片：项目名 + 工具徽标 + 状态点 + 最后消息预览

### Day 4 · Chat 页 · 消息流
- 用户消息气泡（靠右）
- AI 文本：Markdown + 代码块高亮
- Plan 卡片：步骤列表
- ToolCall 卡片：折叠/展开 + 危险命令红色
- 命令输出卡片：嵌入 xterm view
- 状态卡片：完成/失败/中断 + 重试

### Day 5 · Chat 页 · 输入 + 重连
- 文本输入 + 发送
- `@` 引用文件
- 快捷指令 chips：/plan /fix /test /explain
- 工具&模型切换弹层
- 停止按钮（interrupt）
- 重连 seq 回放 + 骨架屏

### 验收
- 模拟器完成 配对 → 建会话 → 发消息 → 看流式卡片 → 杀 App 重开看到历史

---

## Phase 5 · App · Diff + 检查点 + 终端 + 文件（5 天）

### Day 1 · Diff 审阅页
- 文件 tab 切换
- Hunks：等宽字体 + 语法高亮 + 行号 tabular-nums
- 逐 hunk ✔/✗ + 全部接受
- 底部双动作：接受（二次确认）/ 回退改动前（红色）
- 双指缩放

### Day 2 · 检查点时间线
- 纵向时间线节点：摘要 + 文件 +X -Y + 状态
- 待接受 → 可回退
- 已接受 → baseline 里程碑 + "不可回退到此之前"
- 已回退 → 灰显
- 回退二次确认

### Day 3 · 终端页
- xterm.dart PTY 直连
- 快捷键条：Esc/Tab/Ctrl/方向键
- 复制 + 安全区适配

### Day 4 · 文件浏览器
- 树形浏览工作区
- 读取 + 语法高亮
- 简单编辑（单行）
- 分享

### Day 5 · 联动
- Chat 检查点标记点击 → 跳检查点页
- Diff 卡片点击 → 跳 Diff 审阅
- 命令输出卡片点击 → 跳终端

### 验收
- 完整 coding 闭环：发需求 → 看 plan → 审批 tool call → 看 diff → 接受 → 检查点更新

---

## Phase 6 · App · 预览 + 审批手势 + 语音 + 推送（4 天）

### Day 1 · Web 预览页
- URL 栏 + 设备宽度切换
- 内嵌 WebView 加载 `/preview/{token}/`
- 启动/重启 dev server 按钮
- 控制台日志面板
- 选取元素模式 → 点选节点 → 回传 Agent

### Day 2 · 审批手势
- ToolCall 卡片左滑 Approve / 右滑 Reject
- 滑动 affordance + 可见按钮兜底
- 触觉反馈
- 危险命令红色分离

### Day 3 · 语音输入
- 长按麦克风 → `speech_to_text` 转写
- 转写后可编辑再发送
- 权限请求 + 错误态

### Day 4 · 推送通知
- iOS APNs + Android FCM
- 配对时注册 token
- 后端任务完成 → 推送 "✅ 任务完成，改了 N 个文件"
- 点击通知 → 跳对应会话

### 验收
- 完整体验：语音发需求 → 后台 → 收推送 → 回来看结果 → 审阅 diff → 接受

---

## Phase 7 · 端到端测试（2 天）

### 真机联调
用 Tailscale 把 Mac 暴露给手机：
```bash
# Mac 装 Tailscale，拿 100.x.x.x
# Mac 跑 Caddy + TLS
cat > Caddyfile <<EOF
100.x.x.x:8443 { reverse_proxy localhost:8080 }
EOF
caddy run
# 手机装 Tailscale，登同账号
# App 填 wss://100.x.x.x:8443
```

### 测试矩阵
| 场景 | 预期 |
|---|---|
| 配对码过期 | 报错"码已失效" |
| 发"加登录页记住密码" | Plan → ToolCall → Diff 卡片 |
| 审批 rm 命令 | 红色高亮 + 滑动审批 |
| Diff 接受 | baseline 前移、快照清理 |
| Diff 回退 | 工作树还原、对话保留 |
| 检查点回退到 N 回合前 | 工作树还原 |
| Web 预览 vite | HMR 生效、元素选取回传 |
| 杀 App 重开 | 历史 + seq 回放 |
| 切 WiFi | 自动重连、无重复 |
| 后台 30 分钟 | 重连 + 推送收到 |
| 语音发需求 | 转写正确 |
| 中文输入 | PTY UTF-8 正确 |
| 长任务 30s | 流式不卡、可中断 |
| 平板双栏 | 会话列表 + Chat 并排 |

---

## Phase 8 · 平板适配（1 天）

- `LayoutBuilder` ≥ 700px 双栏（会话列表 + Chat）
- ≥ 1024px 三栏（列表 + Chat + 终端/预览侧拉）
- 横屏适配
- 输入框更大、快捷指令常驻

---

## Phase 9 · 打包发布（3 天）

### 后端打包

`docker-compose.yml`：
```yaml
services:
  pocket-agent:
    image: pocket/agent:latest
    init: true
    ports: ["8080:8080"]
    volumes:
      - ./data:/data
      - ./workspaces:/workspaces
    env:
      - JWT_SECRET=${JWT_SECRET}
  caddy:
    image: caddy:2
    ports: ["443:443"]
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile", "caddy_data:/data"]
volumes: { caddy_data: {} }
```

安装脚本 `get.pocket.dev`：
```bash
curl -fsSL https://get.pocket.dev | bash
# 检测 docker → 拉 compose → 生成 JWT_SECRET →
# 检测 claude/codex → 显示配对码 → 提示下载 App
```

### App 打包

iOS TestFlight：
```bash
flutter build ipa --release --export-options-plist=ios/ExportOptions.plist
xcrun altool --upload-app -f build/ios/ipa/pocket.ipa \
  --type ios --apiKey XXX --apiIssuer YYY
```

Android Play Internal：
```bash
flutter build appbundle --release
```

### 发布物料
- TestFlight + Play Internal Testing 邀请链接
- README 三步走：装 agent → 扫码配对 → 开用
- 30s 演示视频

---

## 关键技术坑预防

### 1. Claude Code stream-json 解析
每行一个 JSON 对象，但行内可能有嵌套换行。用 `readline` 按行读，每行 `JSON.parse`，失败就缓冲到下一行。事件类型映射：
- `assistant` → `message`
- `tool_use` → `tool_call`
- `tool_result` → `tool_result`
- `command` → 提取危险命令触发 `waiting_approval`

### 2. 影子 git 不污染用户仓库
关键：`git --git-dir=.pocket/shadow.git --work-tree=.`。所有 git 命令都带这两个参数，绝不用 `git -C`。提交时用 `git -c user.name=pocket -c user.email=pocket@local`，不写全局 user.name/email。

### 3. 预览反代 HMR WebSocket
Vite HMR 走 WS。反代要：
- `Upgrade: websocket` 头透传
- `Connection: upgrade`
- Host 头改写成 `127.0.0.1:PORT`
- Origin 也改写

### 4. node-pty 在 Docker
容器 PID 1 不是 init → 僵尸进程。`docker-compose` 加 `init: true`（用 tini）。

### 5. iOS 推送 + WSS 后台
iOS App 后台 WSS 会被系统杀。策略：
- Background mode: `remote-notification`
- 任务完成 → 后端发 APNs push
- App 收到 push → 唤醒 → 主动 WSS attach(lastSeq) 回放
- **不要**靠 background task 保活 WSS

### 6. 平板双栏状态管理
`go_router` 用 ShellRoute 维护双栏共享状态。右栏 push 路由不影响左栏选中项。状态用 Riverpod `AsyncNotifier`。

### 7. xterm.dart 嵌入 Chat
Chat 页 AI 输出不要全用 xterm——纯文本消息用 Markdown，只有命令输出/终端片段用 xterm view。判断：AgentEvent 类型为 `raw` 或 `tool_result` 含 ANSI → xterm；其余 → Markdown。

### 8. 配对码安全
- 后端生成，6 位数字，10 分钟 TTL，落 SQLite
- 一次有效，配对成功即删
- 同 IP 5 分钟内最多 3 次失败 → 限流 15 分钟

### 9. WS 重连不丢不重
- 每条 server 事件带 `seq`（单调递增）
- App 本地存 `lastSeq`
- 重连时 `attach(lastSeq)` → server 回放差量
- seq 重复 → App 去重
- seq 跳号且超 scrollback → App 全量拉 REST 历史

### 10. tmux 必须装
后端依赖 `tmux`。Dockerfile 里 `apt install tmux`，安装脚本检测主机是否装了。tmux session 名规范：`pocket-${sessionId}`。
