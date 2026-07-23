# 自动化测试方案

覆盖三块：**服务端（Node/TS + Fastify）**、**手机端（Flutter）**、**真机 / 端到端**。
目标是形成一个可在本地一键跑、也能在 CI 里跑的测试金字塔，并为真机联调提供固定流程。

```
        /\        少量  真机 / E2E（真实 CLI + 真实设备，手动或专用 job）
       /  \
      /----\      适量  集成测试（Fastify inject、SQLite 临时库、Flutter widget）
     /      \
    /--------\    大量  单元测试（纯函数：协议、解析、resume 命令、权限模式）
```

核心原则与代码一致：**AI 工具自己的会话文件是唯一事实源，SQLite 只是索引/缓存**。
因此解析层（`transcript-loader`）与回填层（`backfill`）是回归重点。

---

## 一、服务端（`server/`）

技术栈：TypeScript（ESM / NodeNext）、Fastify、better-sqlite3、node-pty。
测试运行器采用 **Node 内置 `node:test` + `tsx`**，零额外依赖（`tsx` 已在 devDependencies）。

### 命令

```bash
cd server
npm run typecheck     # tsc --noEmit，类型即第一道测试
npm test              # node --import tsx --test test/*.test.ts
npm run test:watch    # 监听模式
```

### 分层

1. **单元测试（已落地）**
   - `test/protocol.test.ts` — `buildResumeCommand` 三种工具的 resume 命令。
   - `test/transcript-loader.test.ts` — 用临时 `.jsonl` fixture 验证：
     - claude：`sessionId` / `cwd` / user+assistant 条目 / 摘要；
     - codex：`session_meta` 读取、合成 user 消息（`<environment_context>` 等）被过滤。

2. **集成测试（已落地）**
   - `test/sqlite.test.ts` — `mkdtempSync` 临时 db（含嵌套路径以走一遍
     `mkdirSync(dirname)` 与迁移/`ensureColumn`），验证
     `appendMessage`（`source` 默认 `app`、显式 `external`/`external_turn_ref`）、
     `hasExternalRef` **跨会话隔离**去重、`countMessages`/`maxSeq`（空为 0、取最大 seq）、
     `listMessages`（`afterSeq` 排他、按 seq 升序）、`getSessionByExternalId`、
     `deleteSessionCascade`（级联删子表消息）。共 8 用例。
   - `test/backfill.test.ts` — 临时 `HOME` 造 `~/.claude` transcript + 临时 SQLite，
     验证 `backfillSession` 首次导入 2 条（`source:external`、`ref` 取 transcript uuid）、
     **二次调用幂等返回 0**（`hasExternalRef` 跳过、消息数不翻倍）、
     `reconcileSession` 委派并幂等、无 `external_session_id` 返回 null、
     transcript 缺失返回 null。共 5 用例。
   - `test/session-scanner.test.ts` — 临时 `HOME` 造 `~/.claude/projects/...` 与
     `~/.codex/sessions/YYYY/MM/DD/...`，用 `utimesSync` 钉住 mtime，验证
     **按 mtime 最近优先排序**、tool/cwd 过滤、`limit` 只全读最近 N 个、
     `findHostSession` 跨工具按 id 命中/未命中返回 null。共 6 用例。
     ```ts
     // 关键：scanner/backfill 在 import 时用 homedir() 解析 CLAUDE_DIR/CODEX_DIR，
     // 故必须在动态 import 前设好 HOME（node --test 每个文件独立进程，隔离成立）。
     process.env.HOME = mkdtempSync(...);
     const { scanHostSessions } = await import('../src/hosts/session-scanner.js');
     ```

3. **API 端到端（已落地，免端口）**
   `test/http.e2e.test.ts` — Fastify `app.inject()`，无需真实监听即可打接口。
   关键点：`config.ts` 与 host scanner 在 **import 时**从 `homedir()`/env 解析路径，
   故测试在导入 app 模块前先设好 `HOME` / `POCKET_DATA_DIR` / `POCKET_JWT_SECRET`
   （指向临时目录），再用**动态 import** 加载 `buildHttpServer`，实现完全隔离
   （假 `~/.claude` transcript + 全新临时 SQLite）。
   ```ts
   process.env.HOME = tmpHome;
   process.env.POCKET_DATA_DIR = join(tmpHome, '.pocket');
   process.env.POCKET_JWT_SECRET = 'e2e-test-secret';
   const { buildHttpServer } = await import('../src/gateway/http.js');
   const app = await buildHttpServer();
   const res = await app.inject({ method: 'POST', url: '/api/pair/code' });
   ```
   覆盖的闭环：配对（`/api/pair/code` → `/api/pair` 取 token）→ 鉴权（缺 token 401）→
   `/api/hosts/sessions` 发现 seeded transcript（`imported:false`）→
   `/api/hosts/sessions/import` 回填 2 条 → `/api/sessions` 列出并带
   `externalSessionId`/`cwd` → `/api/sessions/:id` 返回 `resumeCommand` →
   `/api/sessions/:id/messages` 返回 `source:'external'` 消息 →
   **二次导入幂等**（`alreadyImported:true`、`backfilled:0`、消息数不翻倍）→
   发现列表标记 `imported:true`。

4. **内核 E2E（真实 CLI，慢，可选）**
   打开 `POCKET_RESIDENT_PROCESS=true`，对真实安装的 `claude` / `codex` /
   `codebuddy` 跑一轮最小对话，断言会话文件生成、`--resume` 可续、审批写回生效。
   标记为 slow，仅在本机或专用 job 运行（CI 默认跳过）。

---

## 二、手机端（`app/`）

技术栈：Flutter + Riverpod + go_router。

### 命令

```bash
cd app
flutter analyze       # 静态分析（lints）
flutter test          # 单元 + widget 测试（test/ 目录）
```

### 分层

1. **单元测试（已落地）**
   - `test/protocol_test.dart` — `SessionSummary.resumeCommand()`、
     `nextPermissionMode` 循环、`SessionSummary`/`MessageRecord`/`HostSession`
     的 `fromJson`（含 `source` 默认值、`cwd` 默认值）。

2. **Widget 测试（已落地）**
   - `test/widget_test.dart` — 最小 smoke（保证 CI 绿）。
   - `test/chat_render_test.dart` — 用真实 CLI stream-json fixture 驱动
     `ChatNotifier._onMessage`，验证渲染管线与去重。
   - `test/home_page_test.dart` — 用 `ProviderScope(overrides: [...])` 注入
     **假 `ApiClient`**（覆写 `listSessions`/`listHostSessions`/`importHostSession`/
     `deleteSession`），并把 `HomePage` 挂到**自建 `GoRouter`**（`/`、`/theme`、
     `/chat/:id` 占位页），从而对 `context.go('/chat/:id')` 导航做断言。覆盖：
     会话列表渲染（projectId / 工具标签 / lastMessage）、空态、错误态、
     删除流程（确认弹窗 → `deleteSession` 被调 → provider 失效重取 → 行消失）、
     取消删除不触发、导入 sheet 列出 host 会话 + "已导入"标记、
     点击未导入项 → `importHostSession` 带正确入参 → 跳转 `CHAT_local-imported`、
     无 host 会话时的空提示。共 8 用例。
     ```dart
     class FakeApiClient extends ApiClient {
       FakeApiClient() : super(baseUrl: 'http://test');
       @override Future<List<SessionSummary>> listSessions() async => sessions;
       // ...覆写 listHostSessions / importHostSession / deleteSession
     }
     // 注入：apiClientProvider.overrideWith((ref) => _FakeApiClientNotifier(fake))
     ```

3. **集成测试（骨架已落地）**
   - `integration_test/app_boot_test.dart` — 启动真实 app，断言渲染到连接页。
   - 依赖：`pubspec.yaml` 已加 `integration_test`（Flutter SDK 自带）。

---

## 三、真机 / 端到端

### 设备准备

```bash
flutter devices                       # 列出已连接设备
```

- **Android**：USB 调试打开，或模拟器。
- **iOS**：真机需在 Xcode 配好签名（team + provisioning）；也可用模拟器。

### 在真机上跑集成测试

```bash
cd app
flutter test integration_test/app_boot_test.dart -d <device-id>
# 或跑整个目录
flutter test integration_test -d <device-id>
```

### 真机 + 真实服务端联调

1. 电脑启动服务端：
   ```bash
   cd server && npm run dev        # 监听 config.host:config.port
   ```
2. 让手机能访问电脑：
   - **同一局域网**：手机 App 里填 `http(s)://<电脑内网IP>:<port>`；
   - **Android USB 反向代理**：`adb reverse tcp:<port> tcp:<port>`，App 填
     `http://localhost:<port>`；
   - **iOS**：走局域网 IP（USB 无 adb reverse 等价物）。
3. 端到端手测/自动化脚本覆盖关键闭环：
   - 配对 → 新建会话 → 发消息 → 收到流式回复；
   - 长按会话 →「在电脑继续」→ 复制 resume 命令，电脑 `--resume` 接续；
   - 电脑命令行开会话 → App「导入电脑会话」→ 历史回填 → 继续对话（双向记忆）。
4. 把上面第 3 步逐条写成 `integration_test/*.dart`，通过环境变量传入
   `SERVER_URL`，仅当服务端可达时执行（否则 skip）。

### 一键联调脚本（已落地）

`scripts/e2e.sh` 把这条链路封成一条命令，并用 `trap` 兜底清理，避免端口占用：

1. 后台起 `server` 的 `npm run dev`（若 `SERVER_URL` 已指向外部实例则复用，跳过起服务）；
2. 轮询 `GET /api/health` 等端口就绪（`HEALTH_TIMEOUT` 秒；进程早退则打印日志并失败）；
3. `flutter test <TARGET>`，用 `--dart-define=SERVER_URL=...` 把地址透传给 Dart 侧；
4. 退出/中断时关闭服务端。

```bash
./scripts/e2e.sh                                              # 默认 8080 + 默认设备
DEVICE=emulator-5554 ./scripts/e2e.sh                         # 指定真机/模拟器
TARGET=integration_test/e2e_flow_test.dart ./scripts/e2e.sh   # 只跑主链路闭环
SERVER_URL=http://192.168.1.10:8080 ./scripts/e2e.sh          # 连已在跑的服务端
```

被驱动的 `app/integration_test/e2e_flow_test.dart` 覆盖真实用户主链路
（pair → tools → browse → create → list → detail → WS ping/pong → 清理），
**不依赖真实 CLI**；`SERVER_URL` 不可达时整组 `skip`，可安全混入普通
`flutter test` 运行。发消息拿 AI 回复那段属"内核 e2e"（需真实 CLI，见下）。

---

## 四、CI

`.github/workflows/ci.yml` 已配置两个 job（push / PR 触发）：

| Job | 步骤 |
|-----|------|
| `server` | `npm install` → `npm run typecheck` → `npm test` |
| `app` | `flutter pub get` → `flutter analyze` → `flutter test` |

真机 / 集成测试**不在主 CI**跑（需设备或 Firebase Test Lab / 自托管 runner）。
如需接入，可加独立 workflow：Android 用模拟器 runner 或 Firebase Test Lab，
iOS 用 macOS runner + 模拟器。

---

## 五、命令速查

```bash
# 服务端
cd server && npm run typecheck && npm test

# 手机端（静态 + 单元/widget）
cd app && flutter analyze && flutter test

# 真机集成
cd app && flutter test integration_test -d <device-id>
```

## 六、落地状态

- [x] 服务端测试运行器（`node:test` + `tsx`）与 `test`/`test:watch` 脚本
- [x] 服务端单测：`protocol` / `transcript-loader`（5 用例通过）
- [x] 服务端 API e2e：`test/http.e2e.test.ts`（`app.inject()` 覆盖 pair / sessions / hosts import 幂等闭环，8 用例通过）
- [x] 服务端单元级集成测试：`sqlite.test.ts`（8）/ `backfill.test.ts`（5，含幂等）/ `session-scanner.test.ts`（6，含 mtime 排序/限流/过滤/`findHostSession`）
- [x] 服务端 WS 通道 e2e：`test/ws.e2e.test.ts`（真实端口，覆盖发消息唯一通道——无 token/无效 token 拒绝、握手、ping/pong、input 未知会话结构化 error、attach 未知会话容错，5 用例）
- [x] 服务端 REST 主链路遗漏 e2e：`test/http-flows.e2e.test.ts`（配对失败 401/400 与暴力破解限流 429、新建会话+校验+删除、workspace 浏览与路径越权/绝对路径拒绝，9 用例）
- [x] 服务端套件共 **45 用例**通过（typecheck 通过、无 lint）
- [x] App 单测：`protocol_test.dart`（10 用例）+ 修复 `widget_test.dart`（共 11 通过）
- [x] App widget 测试：`home_page_test.dart`（注入假 `ApiClient` + 自建 `GoRouter`，覆盖首页列表/空态/错误态/删除流程/导入 sheet 交互与导航，8 用例通过；App 套件共 25 通过）
- [x] App 集成测试骨架 `integration_test/app_boot_test.dart` + `integration_test` 依赖
- [x] App 真机主链路集成测试 `integration_test/e2e_flow_test.dart`（`SERVER_URL` 驱动，不可达 skip；analyze 通过）
- [x] 一键联调脚本 `scripts/e2e.sh`（起服务→等 `/api/health`→跑集成测试透传 `SERVER_URL`→`trap` 清理）
- [x] 清理：删除错放在 `server/test/` 下的 Flutter 计数器模板 `widget_test.dart`
- [x] CI 工作流 `.github/workflows/ci.yml`
- [ ] 内核 e2e（真实 CLI，slow，可选）：`POCKET_RESIDENT_PROCESS=true` 下对真实 `claude`/`codex`/`codebuddy` 发消息拿流式回复、`--resume` 续接、审批写回
```
