# PTY 终端通道（双通道会话）Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 给每个会话新增一条按需拉起的交互式 PTY 终端通道，让用户在 app 里获得与电脑命令行 100% 一致的原生体验（slash 命令 `/help` `/model` `/clear` 等全部可用），同时保留 structured 通道的卡片渲染 / 审批门控 / 持久化能力。

**Architecture:** 保持现有 structured（stream-json）通道不变作为日常聊天主通道。新增独立的 PTY 通道：服务端用 `node-pty` spawn **交互式** `claude --resume <externalSessionId>`（不带 `--input-format stream-json`），app 用 `xterm` 渲染字节流。两条通道通过 CLI 自身持久化的 `externalSessionId` + `--resume` 共享同一段对话上下文——终端里执行的 `/model`、`/compact` 等变更，会在下次 structured turn 的 `--resume` 中自动继承。同一会话任意时刻只允许一个进程持有（打开终端前先中断 structured 常驻进程）。

**Tech Stack:** Node 24 + TypeScript + `node-pty@1.1` + `ws`（服务端）；Flutter + `xterm@4`（app）；测试用 `node:test` + `tsx`（服务端）、`flutter test`（app）。

---

## 背景与关键事实（执行者必读）

- **为什么现在不能用 slash 命令**：structured 通道用 `claude --input-format stream-json`（`server/src/adapters/claude-code.ts:181-198`），这是非交互程序化接口，Claude Code 已知 bug #4184 导致所有 slash 命令在该模式下返回 `isn't available in this environment`。slash 命令是交互式 TUI 专属功能。
- **状态共享机制**：claude 每条消息带 `session_id`，服务端在 `manager.ts:191-196` 捕获并持久化为 `externalSessionId`，用 `--resume <id>` 重启接回（`claude-code.ts:193-194`、`manager.ts:126-134`）。对话历史由 CLI 持久化在 `~/.claude/`，不在本项目 SQLite 里。因此**同一个 externalSessionId 可被交互式 PTY 进程 `--resume` 打开，与 structured 通道共享上下文**。
- **协议已预留**：`server/src/protocol.ts:52,54-55,66` 已定义 `ClientMessage` 的 `{t:'resize'}`/`{t:'term'}` 与 `ServerMessage` 的 `{t:'term'}`；`ToolAdapter.mode: 'structured' | 'pty'`（`protocol.ts:96`）。app 端 `pubspec.yaml:17` 已有 `xterm: ^4.0.0`，服务端 `package.json:20` 已有 `node-pty`。**无需新增依赖安装。**
- **WS 当前状态**：`server/src/gateway/ws.ts` 的 `handleClient` switch 里，`resize` 是空 stub（第 137-140 行），**没有 `term` 分支**。
- **单进程约束**：claude `--resume` 会把持久化对话载入一个新进程。为避免两个进程同时写同一会话，打开终端前必须先中断该会话的 structured 常驻进程（`sessionManager.interrupt`），终端关闭后 structured 通道在下次 `input()` 时自动 `--resume` 接回。
- **MVP 限制（需在代码注释与 docs 记录）**：仅当会话已有 `externalSessionId`（至少跑过一次 structured turn，或从桌面导入）时，终端才能 `--resume` 共享上下文。若为 null，终端会启动一个全新交互会话且**不回写** structured 通道——UI 层需对 `externalSessionId == null` 的会话禁用/提示「先发一条消息再开终端」。codex 用 `exec`（非交互），本期不支持终端，`buildTerminalCommand` 返回 null，UI 隐藏入口。

## 新增协议约定（本计划引入）

在现有 `term`/`resize` 基础上新增显式的开/关/退出消息（否则无法区分"打开终端"与"发送字节"）：

- `ClientMessage`: `| { t: 'term_open'; sessionId: string }` `| { t: 'term_close'; sessionId: string }`
- `ServerMessage`: `| { seq: number; t: 'term_exit'; sessionId: string; code: number }`

---

# Phase A — 服务端 PTY 通道

### Task A1: adapter 增加 `buildTerminalCommand`

**Files:**
- Modify: `server/src/protocol.ts`（`ToolAdapter` 接口，约 93-119 行）
- Modify: `server/src/adapters/claude-code.ts`（约 169-198 行 adapter 对象）
- Modify: `server/src/adapters/codebuddy.ts`
- Modify: `server/src/adapters/codex.ts`
- Test: `server/test/terminal-adapter.test.ts`（新建）

**Step 1: 写失败测试**

```ts
// server/test/terminal-adapter.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeCodeAdapter } from '../src/adapters/claude-code.js';
import { codexAdapter } from '../src/adapters/codex.js';

test('claude buildTerminalCommand: no resume when externalSessionId absent', () => {
  const c = claudeCodeAdapter.buildTerminalCommand!({ cwd: '/tmp', externalSessionId: null });
  assert.equal(c!.cmd, 'claude');
  assert.ok(!c!.args.includes('--resume'));
  assert.ok(!c!.args.includes('--input-format')); // interactive, NOT stream-json
});

test('claude buildTerminalCommand: resumes when externalSessionId present', () => {
  const c = claudeCodeAdapter.buildTerminalCommand!({ cwd: '/tmp', externalSessionId: 'sess-123' });
  assert.deepEqual(c!.args, ['--resume', 'sess-123']);
});

test('codex buildTerminalCommand: not supported → null', () => {
  const c = codexAdapter.buildTerminalCommand?.({ cwd: '/tmp', externalSessionId: null });
  assert.equal(c ?? null, null);
});
```

**Step 2: 运行确认失败**

Run: `cd server && node --import tsx --test test/terminal-adapter.test.ts`
Expected: FAIL（`buildTerminalCommand is not a function`）

**Step 3: 最小实现**

在 `server/src/protocol.ts` 的 `ToolAdapter` 接口中新增（放在 `interrupt` 之前）：

```ts
  // Build the command to launch the tool's INTERACTIVE TUI inside a pty
  // (M3 terminal channel). Unlike buildCommand (stream-json), this uses no
  // --input-format so slash commands work exactly like the desktop. Returns
  // null for tools without an interactive resume mode (codex exec). When
  // externalSessionId is set, resume that conversation so the terminal shares
  // context with the structured channel.
  buildTerminalCommand?(opts: { cwd: string; externalSessionId: string | null }):
    | { cmd: string; args: string[]; env: Record<string, string> }
    | null;
```

在 `claude-code.ts` 的 `claudeCodeAdapter` 对象里（`interrupt` 之前）新增：

```ts
  buildTerminalCommand(opts: { cwd: string; externalSessionId: string | null }) {
    const args: string[] = [];
    if (opts.externalSessionId) args.push('--resume', opts.externalSessionId);
    return { cmd: 'claude', args, env: {} };
  },
```

在 `codebuddy.ts` 同样新增（用 `codebuddy` 命令 + 该 CLI 的 resume 语法，参考 `buildResumeCommand` 里的 `codebuddy --resume=<id>`）：

```ts
  buildTerminalCommand(opts: { cwd: string; externalSessionId: string | null }) {
    const args: string[] = [];
    if (opts.externalSessionId) args.push(`--resume=${opts.externalSessionId}`);
    return { cmd: 'codebuddy', args, env: {} };
  },
```

在 `codex.ts` 新增（明确不支持）：

```ts
  buildTerminalCommand() {
    return null; // codex exec is non-interactive; no TUI to attach.
  },
```

**Step 4: 运行确认通过**

Run: `cd server && node --import tsx --test test/terminal-adapter.test.ts`
Expected: PASS（3 tests）

**Step 5: Commit**

```bash
git add server/src/protocol.ts server/src/adapters/*.ts server/test/terminal-adapter.test.ts
git commit -m "feat(server): add ToolAdapter.buildTerminalCommand for pty channel"
```

---

### Task A2: `TerminalManager` — node-pty 生命周期

**Files:**
- Create: `server/src/session/terminal.ts`
- Test: `server/test/terminal-manager.test.ts`（新建）

**Step 1: 写失败测试**（用 `cat` 作为可确定性回显的 pty 替身，macOS/Linux 都有）

```ts
// server/test/terminal-manager.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalManager } from '../src/session/terminal.js';

test('open → write echoes back via onData → close fires onExit', async () => {
  const tm = new TerminalManager();
  const chunks: string[] = [];
  let exited = false;
  tm.open({
    sessionId: 's1',
    cmd: 'cat', args: [], cwd: process.cwd(),
    onData: (d) => chunks.push(d),
    onExit: () => { exited = true; },
  });
  tm.write('s1', 'hello\n');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(chunks.join('').includes('hello'), 'cat should echo input');
  tm.close('s1');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(exited, true);
  assert.equal(tm.has('s1'), false);
});

test('resize does not throw on a live pty', async () => {
  const tm = new TerminalManager();
  tm.open({ sessionId: 's2', cmd: 'cat', args: [], cwd: process.cwd(), onData: () => {}, onExit: () => {} });
  assert.doesNotThrow(() => tm.resize('s2', 100, 30));
  tm.close('s2');
});
```

**Step 2: 运行确认失败**

Run: `cd server && node --import tsx --test test/terminal-manager.test.ts`
Expected: FAIL（模块不存在）

**Step 3: 最小实现**

```ts
// server/src/session/terminal.ts
import * as pty from 'node-pty';

interface Handle {
  proc: pty.IPty;
  onData: (data: string) => void;
  onExit: (code: number) => void;
}

/**
 * Manages interactive pseudo-terminal processes, one per session id. Separate
 * from SessionManager's structured (stream-json) child processes — this is the
 * M3 terminal channel that runs the CLI's real TUI so slash commands work.
 */
export class TerminalManager {
  private handles = new Map<string, Handle>();

  open(opts: {
    sessionId: string;
    cmd: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
    cols?: number;
    rows?: number;
    onData: (data: string) => void;
    onExit: (code: number) => void;
  }): void {
    // One terminal per session — replace any stale handle.
    this.close(opts.sessionId);
    const proc = pty.spawn(opts.cmd, opts.args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
    });
    const handle: Handle = { proc, onData: opts.onData, onExit: opts.onExit };
    proc.onData((d) => handle.onData(d));
    proc.onExit(({ exitCode }) => {
      this.handles.delete(opts.sessionId);
      handle.onExit(exitCode);
    });
    this.handles.set(opts.sessionId, handle);
  }

  write(sessionId: string, data: string): void {
    this.handles.get(sessionId)?.proc.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const h = this.handles.get(sessionId);
    if (!h) return;
    try { h.proc.resize(Math.max(1, cols), Math.max(1, rows)); } catch { /* pty gone */ }
  }

  has(sessionId: string): boolean {
    return this.handles.has(sessionId);
  }

  close(sessionId: string): void {
    const h = this.handles.get(sessionId);
    if (!h) return;
    this.handles.delete(sessionId);
    try { h.proc.kill(); } catch { /* already dead */ }
  }
}

export const terminalManager = new TerminalManager();
```

**Step 4: 运行确认通过**

Run: `cd server && node --import tsx --test test/terminal-manager.test.ts`
Expected: PASS（2 tests）。若 node-pty 原生模块报错，先 `cd server && npm rebuild node-pty`。

**Step 5: Commit**

```bash
git add server/src/session/terminal.ts server/test/terminal-manager.test.ts
git commit -m "feat(server): add TerminalManager for node-pty lifecycle"
```

---

### Task A3: 协议新增 term_open/term_close/term_exit

**Files:**
- Modify: `server/src/protocol.ts`（`ClientMessage` 约 47-56 行、`ServerMessage` 约 58-68 行）
- Test: 复用 Task A4 的 WS 测试（本任务只是类型，无独立运行时行为）

**Step 1: 修改类型**

在 `ClientMessage` union 里，紧跟 `{ t: 'term'; ... }` 之后加：

```ts
  // Open/close the interactive pty terminal channel for a session (M3).
  | { t: 'term_open'; sessionId: string }
  | { t: 'term_close'; sessionId: string }
```

在 `ServerMessage` union 里，紧跟 `{ t: 'term'; ... }` 之后加：

```ts
  // The pty exited (user typed `exit`, or process died). code = exit status.
  | { seq: number; t: 'term_exit'; sessionId: string; code: number }
```

**Step 2: 类型检查**

Run: `cd server && npm run typecheck`
Expected: PASS（新增 union 分支不破坏现有代码；`ws.ts` 的 switch 会有未处理分支但 TS 不强制 exhaustive，除非有 `never` 检查——若报错，在 A4 补齐分支后再跑）

**Step 3: Commit**

```bash
git add server/src/protocol.ts
git commit -m "feat(protocol): add term_open/term_close/term_exit messages"
```

---

### Task A4: `SessionManager.openTerminal/closeTerminal` + WS 路由

**Files:**
- Modify: `server/src/session/manager.ts`（新增方法，import `terminalManager`）
- Modify: `server/src/gateway/ws.ts`（`handleClient` switch，约 68-142 行）
- Test: `server/test/ws-terminal.e2e.test.ts`（新建）

**Step 1: 写失败测试**（用真实 WS + 一个把 adapter.buildTerminalCommand 指向 `cat` 的会话；e2e 风格参考现有 `test/http.e2e.test.ts` 的临时 HOME/JWT 自建）

```ts
// server/test/ws-terminal.e2e.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
// NOTE: follow the existing e2e harness in test/http.e2e.test.ts to set
// process.env.HOME / POCKET_DATA_DIR / POCKET_JWT_SECRET BEFORE importing the
// app, build a Fastify server on an ephemeral port, pair to get a token, and
// create a session. Then connect a ws client to /ws?token=...
//
// Because spawning the real `claude` TUI in CI is impossible, monkey-patch the
// claude adapter's buildTerminalCommand to return { cmd: 'cat', args: [], env: {} }
// for this test so the pty echoes deterministically.

test('term_open → term data echoes → term_close emits term_exit', async () => {
  // 1. pair + create session (see http.e2e.test.ts helpers)
  // 2. ws.send({ t: 'term_open', sessionId })
  // 3. ws.send({ t: 'term', sessionId, data: 'ping\n' })
  // 4. expect a ServerMessage { t: 'term', data } containing 'ping'
  // 5. ws.send({ t: 'term_close', sessionId })
  // 6. expect { t: 'term_exit', sessionId }
  assert.ok(true, 'implement using http.e2e harness + cat stand-in');
});
```

> 执行者：先照搬 `test/http.e2e.test.ts` 顶部的隔离环境搭建，再填充上面 6 步的真实断言。

**Step 2: 运行确认失败**

Run: `cd server && node --import tsx --test test/ws-terminal.e2e.test.ts`
Expected: FAIL（`term_open` 无处理 → 无 term 回包）

**Step 3: 实现 — manager.ts**

在 `manager.ts` 顶部 import：

```ts
import { terminalManager } from './terminal.js';
```

在 `SessionManager` 类里新增方法（放在 `interrupt` 附近）：

```ts
  /**
   * Open the interactive pty terminal channel for a session. Kills the
   * structured resident process first so only one process holds the
   * conversation (they share externalSessionId via --resume). Terminal output
   * bytes are broadcast to subscribers as { t:'term' } (transient, not
   * persisted, not seq-tracked). Returns false if the tool has no TUI.
   */
  openTerminal(session: Session, store: Store): boolean {
    const adapter = getAdapter(session.toolId);
    if (!adapter?.buildTerminalCommand) return false;
    const spec = adapter.buildTerminalCommand({
      cwd: session.cwd,
      externalSessionId: session.externalSessionId,
    });
    if (!spec) return false;

    // Single-writer rule: stop the structured process before the TUI resumes
    // the same conversation. It will --resume again on the next input().
    if (session.proc) {
      try { session.proc.kill('SIGINT'); } catch { /* already dead */ }
      session.proc = null;
    }

    terminalManager.open({
      sessionId: session.id,
      cmd: spec.cmd,
      args: spec.args,
      cwd: session.cwd,
      env: spec.env,
      onData: (data) => {
        const msg: ServerMessage = { seq: 0, t: 'term', sessionId: session.id, data };
        for (const sub of session.subscribers) sub(msg);
      },
      onExit: (code) => {
        const msg: ServerMessage = { seq: 0, t: 'term_exit', sessionId: session.id, code };
        for (const sub of session.subscribers) sub(msg);
      },
    });
    store.audit(session.id, 'term_open', session.toolId);
    return true;
  }

  writeTerminal(session: Session, data: string): void {
    terminalManager.write(session.id, data);
  }

  resizeTerminal(session: Session, cols: number, rows: number): void {
    terminalManager.resize(session.id, cols, rows);
  }

  closeTerminal(session: Session, store: Store): void {
    terminalManager.close(session.id);
    store.audit(session.id, 'term_close', session.toolId);
  }
```

> 注意：`ServerMessage` 的 `term`/`term_exit` 需要 `data`/`code` 字段——它们已在 protocol.ts 定义。若 TS 报 `seq:0` 之外字段缺失，按 union 定义补全。同时确保 `deleteSession` 里也调用 `terminalManager.close(session.id)`（在 `session.proc.kill` 附近加一行），避免泄漏。

**Step 3b: 实现 — ws.ts**

在 `handleClient` 的 switch 里，把 `resize` 空 stub 替换，并新增三个分支：

```ts
    case 'term_open': {
      const session = sessionManager.get(msg.sessionId)
        ?? rehydrateOr404(ws, msg.sessionId, store);
      if (!session) return;
      const ok = sessionManager.openTerminal(session, store);
      if (!ok) send(ws, { seq: 0, t: 'error', sessionId: msg.sessionId, message: 'terminal_unsupported' });
      return;
    }
    case 'term': {
      const session = sessionManager.get(msg.sessionId);
      if (session) sessionManager.writeTerminal(session, msg.data);
      return;
    }
    case 'resize': {
      const session = sessionManager.get(msg.sessionId);
      if (session) sessionManager.resizeTerminal(session, msg.cols, msg.rows);
      return;
    }
    case 'term_close': {
      const session = sessionManager.get(msg.sessionId);
      if (session) sessionManager.closeTerminal(session, store);
      return;
    }
```

> `rehydrateOr404` 是可选小重构：把 `attach`/`input`/`mode` 里重复的「get 不到就从 DB rehydrate，否则回 404」逻辑抽成一个本地 helper。若不想重构，`term_open` 里内联同样的 rehydrate 逻辑即可（参考第 74-98 行）。

**Step 4: 运行确认通过**

Run: `cd server && node --import tsx --test test/ws-terminal.e2e.test.ts && npm run typecheck`
Expected: PASS

**Step 5: 全量回归 + Commit**

```bash
cd server && npm test          # 确认既有 46 项全绿
git add server/src/session/manager.ts server/src/gateway/ws.ts server/test/ws-terminal.e2e.test.ts
git commit -m "feat(server): wire pty terminal channel into SessionManager + WS"
```

---

# Phase B — App xterm 终端页

### Task B1: protocol.dart 解析 term / term_exit

**Files:**
- Modify: `app/lib/core/protocol.dart`（`ServerMessage` 约 77-119 行）
- Test: `app/test/protocol_test.dart`（追加用例；文件已存在）

**Step 1: 写失败测试**

```dart
// 追加到 app/test/protocol_test.dart
test('ServerMessage parses term data', () {
  final m = ServerMessage.fromJson({'seq': 0, 't': 'term', 'sessionId': 's1', 'data': 'abc'});
  expect(m.t, 'term');
  expect(m.data, 'abc');
});

test('ServerMessage parses term_exit code', () {
  final m = ServerMessage.fromJson({'seq': 0, 't': 'term_exit', 'sessionId': 's1', 'code': 0});
  expect(m.t, 'term_exit');
  expect(m.exitCode, 0);
});
```

**Step 2: 运行确认失败**

Run: `cd app && flutter test test/protocol_test.dart`
Expected: FAIL（`ServerMessage` 无 `data`/`exitCode` 字段）

**Step 3: 实现**

在 `ServerMessage` 类加两个字段 + 构造 + fromJson：

```dart
  final String? data;      // raw terminal bytes (t == 'term')
  final int? exitCode;     // pty exit status (t == 'term_exit')
```

构造函数参数表加 `this.data, this.exitCode,`；`fromJson` 加：

```dart
        data: j['data'] as String?,
        exitCode: (j['code'] as num?)?.toInt(),
```

**Step 4: 运行确认通过**

Run: `cd app && flutter test test/protocol_test.dart`
Expected: PASS

**Step 5: Commit**

```bash
git add app/lib/core/protocol.dart app/test/protocol_test.dart
git commit -m "feat(app): parse term/term_exit server messages"
```

---

### Task B2: WsClient 增加 term 相关发送方法

**Files:**
- Modify: `app/lib/core/ws/client.dart`（约 105-115 行的 send helpers）
- Test: `app/test/ws_client_test.dart`（新建，若无 mock 基建则用一个可注入的 send 记录器；否则跳过并在 B4 手动验证）

**Step 1: 实现**（这些是薄封装，测试价值低——直接实现，B4 端到端验证）

在 `WsClient` 里 `interrupt` 之后加：

```dart
  void termOpen(String sessionId) => send({'t': 'term_open', 'sessionId': sessionId});
  void termClose(String sessionId) => send({'t': 'term_close', 'sessionId': sessionId});
  void termData(String sessionId, String data) =>
      send({'t': 'term', 'sessionId': sessionId, 'data': data});
  void resize(String sessionId, int cols, int rows) =>
      send({'t': 'resize', 'sessionId': sessionId, 'cols': cols, 'rows': rows});
```

**Step 2: analyze**

Run: `cd app && flutter analyze lib/core/ws/client.dart`
Expected: No error

**Step 3: Commit**

```bash
git add app/lib/core/ws/client.dart
git commit -m "feat(app): add WsClient term_open/term_close/term_data/resize"
```

---

### Task B3: TerminalPage（xterm 视图）

**Files:**
- Create: `app/lib/features/terminal/terminal_page.dart`
- Test: `app/test/terminal_page_test.dart`（widget smoke：能构建、能把 term 数据写入 Terminal、onOutput 触发 termData 回调）

**Step 1: 写失败测试**（smoke）

```dart
// app/test/terminal_page_test.dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket/features/terminal/terminal_page.dart';

void main() {
  testWidgets('TerminalPage builds and shows a terminal view', (tester) async {
    final sent = <String>[];
    await tester.pumpWidget(MaterialApp(
      home: TerminalPage(
        sessionId: 's1',
        // Inject seams so the widget doesn't need a live WsClient:
        onOpen: () {},
        onClose: () {},
        onInput: (d) => sent.add(d),
        onResize: (c, r) {},
        incoming: const Stream.empty(),
      ),
    ));
    await tester.pump();
    expect(find.byType(TerminalPage), findsOneWidget);
  });
}
```

> 设计要点：`TerminalPage` 用回调/Stream 注入依赖（`onInput/onResize/onOpen/onClose` + `Stream<String> incoming`），**不直接依赖 WsClient**，便于测试与复用。真正接线在 B4。

**Step 2: 运行确认失败**

Run: `cd app && flutter test test/terminal_page_test.dart`
Expected: FAIL（文件不存在）

**Step 3: 实现**

```dart
// app/lib/features/terminal/terminal_page.dart
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';

/// Interactive terminal view (M3 pty channel). Renders raw bytes from the
/// server's pty and forwards user keystrokes back. Dependency-injected via
/// callbacks/stream so it stays decoupled from WsClient (see ChatPage wiring).
class TerminalPage extends StatefulWidget {
  final String sessionId;
  final VoidCallback onOpen;
  final VoidCallback onClose;
  final ValueChanged<String> onInput;
  final void Function(int cols, int rows) onResize;
  final Stream<String> incoming; // term data bytes from server

  const TerminalPage({
    super.key,
    required this.sessionId,
    required this.onOpen,
    required this.onClose,
    required this.onInput,
    required this.onResize,
    required this.incoming,
  });

  @override
  State<TerminalPage> createState() => _TerminalPageState();
}

class _TerminalPageState extends State<TerminalPage> {
  late final Terminal _terminal;
  StreamSubscription<String>? _sub;

  @override
  void initState() {
    super.initState();
    _terminal = Terminal(maxLines: 10000);
    // User keystrokes → server pty stdin.
    _terminal.onOutput = (data) => widget.onInput(data);
    // Terminal geometry change → server pty resize.
    _terminal.onResize = (w, h, pw, ph) => widget.onResize(w, h);
    // Server pty stdout → render.
    _sub = widget.incoming.listen(_terminal.write);
    widget.onOpen();
  }

  @override
  void dispose() {
    _sub?.cancel();
    widget.onClose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('终端')),
      backgroundColor: Colors.black,
      body: SafeArea(
        child: TerminalView(_terminal),
      ),
    );
  }
}
```

> 执行者：`xterm ^4.0.0` 的确切 API 以本地 `flutter pub deps`/包源为准。v4 中 `Terminal(maxLines:)`、`terminal.onOutput`、`terminal.onResize`、`terminal.write(String)`、`TerminalView(terminal)` 均可用；若签名不符按实际调整（例如 `TerminalView(terminal: _terminal)`）。

**Step 4: 运行确认通过**

Run: `cd app && flutter test test/terminal_page_test.dart`
Expected: PASS

**Step 5: Commit**

```bash
git add app/lib/features/terminal/terminal_page.dart app/test/terminal_page_test.dart
git commit -m "feat(app): add TerminalPage xterm view (decoupled via callbacks)"
```

---

### Task B4: ChatPage 接入终端入口 + 接线

**Files:**
- Modify: `app/lib/features/chat/chat_page.dart`（AppBar/菜单加「终端」入口；用 ChatPage 持有的 WsClient 把 TerminalPage 的回调/Stream 接到 WS）
- Test: 手动（真机/浏览器）验证；无独立单测

**Step 1: 定位接入点**

- 找到 ChatPage 里持有的 `WsClient` 实例、当前 `sessionId`、以及 `chat.toolId`/`chat.externalSessionId`（用于判断是否显示终端入口）。搜索锚点：`grep -n "WsClient\|_ws\|externalSessionId\|toolId\|AppBar(" app/lib/features/chat/chat_page.dart`。
- 从 WS 事件流里筛出本会话的 `t == 'term'` 消息构造 `Stream<String>`：将 ChatPage 已有的 `WsClient.events` 用 `.where((m) => m.t == 'term' && m.sessionId == sessionId).map((m) => m.data ?? '')` 派生给 TerminalPage 的 `incoming`。

**Step 2: 实现入口**

在 AppBar `actions` 或长按菜单加一个「终端」按钮，仅当 `chat.toolId != 'codex' && chat.externalSessionId != null` 时可用（否则置灰并提示「先发一条消息再打开终端」）：

```dart
IconButton(
  icon: const Icon(Icons.terminal),
  tooltip: '终端',
  onPressed: (chat.toolId == 'codex' || chat.externalSessionId == null)
      ? null
      : () {
          final ws = _ws; // ChatPage 的 WsClient
          Navigator.of(context).push(MaterialPageRoute(
            builder: (_) => TerminalPage(
              sessionId: sessionId,
              onOpen: () => ws.termOpen(sessionId),
              onClose: () => ws.termClose(sessionId),
              onInput: (d) => ws.termData(sessionId, d),
              onResize: (c, r) => ws.resize(sessionId, c, r),
              incoming: ws.events
                  .where((m) => m.t == 'term' && m.sessionId == sessionId)
                  .map((m) => m.data ?? ''),
            ),
          ));
        },
),
```

同时 import `package:pocket/features/terminal/terminal_page.dart`（按项目包名调整前缀）。

**Step 3: analyze + 全量测试**

Run: `cd app && flutter analyze && flutter test`
Expected: 0 error；既有 25 + 新增用例全绿

**Step 4: Commit**

```bash
git add app/lib/features/chat/chat_page.dart
git commit -m "feat(app): open TerminalPage from chat, wired to WS term channel"
```

---

# Phase C — 联调与文档

### Task C1: 端到端手测 + 文档

**Files:**
- Modify: `docs/system-design.md`（补 M3 终端通道章节：双通道架构、单进程约束、externalSessionId 共享、MVP 限制）
- Modify: `docs/testing-plan.md`（补终端通道手测清单）

**Step 1: 端到端手测**

1. `cd server && npm run dev`；`cd app && flutter run -d chrome`（或真机）
2. 配对 → 新建 claude 会话 → **先发一条普通消息**（让 `externalSessionId` 生成）
3. 点 AppBar「终端」→ 应看到黑色终端，claude TUI 启动
4. 输入 `/help` → **应正常显示帮助**（不再是 "isn't available in this environment"）
5. 试 `/model`、`/clear`、`/compact` → 均按真实 CLI 行为响应
6. 退出终端 → 回聊天页发消息 → 上下文延续（structured `--resume` 接回终端里的变更）
7. 验证单进程约束：开终端时 structured 进程被中断，无双进程冲突

**Step 2: 更新文档**（按实际实现补写，记录 MVP 限制：externalSessionId==null 不共享、codex 不支持、term 字节流不持久化不回放）

**Step 3: Commit**

```bash
git add docs/system-design.md docs/testing-plan.md
git commit -m "docs: document M3 pty terminal channel"
```

---

## 验收标准（Definition of Done）

- [ ] `cd server && npm run typecheck && npm test` 全绿（含新增 terminal-adapter / terminal-manager / ws-terminal 测试）
- [ ] `cd app && flutter analyze` 0 error；`flutter test` 全绿（含 protocol/terminal_page 新增用例）
- [ ] 浏览器/真机手测：终端里 `/help` `/model` `/clear` 全部按真实 CLI 行为工作
- [ ] 开终端会中断 structured 进程；关终端后聊天上下文延续
- [ ] codex 会话与 `externalSessionId == null` 的会话，终端入口正确禁用/隐藏
- [ ] `docs/system-design.md`、`docs/testing-plan.md` 已更新

## 风险与注意事项

- **node-pty 原生编译**：Node 版本变化后可能需 `npm rebuild node-pty`。CI 若无原生构建能力，terminal-manager 测试用 `cat` 仍需 node-pty 可加载——必要时用 `POCKET_KERNEL_E2E` 式的 skip 门控。
- **Flutter web 下的 xterm**：`xterm.dart` 在 web 可渲染，但物理键盘/输入法行为可能与原生有差异；终端体验以真机为准，web 仅作快速验证。
- **单进程约束**：务必在 `openTerminal` 里中断 structured 进程，并在 `deleteSession` 里 `terminalManager.close`，否则会残留 pty 或双进程写同一会话。
- **term 字节流不持久化**：符合 protocol.ts:64-66 注释；重连后终端历史不回放（xterm 的 scrollback 是客户端内存态）。这是设计取舍，非缺陷。
