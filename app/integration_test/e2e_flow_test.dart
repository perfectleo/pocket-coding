// Real-server end-to-end flow, driven by a --dart-define=SERVER_URL pointing
// at a running Pocket server. This mirrors what a user does the first time
// they open the app: pair → discover tools → pick a project folder → create a
// session → see it in the list → open its detail → connect the realtime WS →
// then clean up.
//
// It deliberately does NOT send `input` / assert an AI reply, because that
// needs a real installed CLI (claude/codex) — that "kernel e2e" path is slow
// and optional. Everything here works against a bare server with no CLI.
//
// Run via the one-shot harness (starts a server, waits for /api/health, then
// runs this and tears down):
//   ./scripts/e2e.sh TARGET=integration_test/e2e_flow_test.dart
// or point at an already-running server:
//   cd app && flutter test integration_test/e2e_flow_test.dart \
//       --dart-define=SERVER_URL=http://127.0.0.1:8080
//
// With no reachable SERVER_URL the whole group is SKIPPED (not failed), so it
// is safe to include in `flutter test` runs on machines without a server.

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:app/core/api/client.dart';
import 'package:app/core/protocol.dart';
import 'package:app/core/ws/client.dart';
import 'package:app/core/state/app_state.dart';

const serverUrl = String.fromEnvironment('SERVER_URL');

Future<bool> _reachable(String base) async {
  if (base.isEmpty) return false;
  try {
    final j = await ApiClient(baseUrl: base).get('/api/health');
    return j['ok'] == true;
  } catch (_) {
    return false;
  }
}

Future<void> main() async {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  final reachable = await _reachable(serverUrl);
  final skip = reachable
      ? false
      : 'SERVER_URL 未设置或服务端不可达，跳过真机联调。用 scripts/e2e.sh 或 '
          '--dart-define=SERVER_URL=http://<host>:8080 运行。';

  group('真机主链路：pair → tools → browse → create → list → detail → ws', () {
    test('端到端闭环（无需真实 CLI）', () async {
      final client = ApiClient(baseUrl: serverUrl);

      // 1) 配对：请求配对码 → 换取设备 token。
      final code = await client.requestPairCode();
      expect(code.length, 6);
      final paired = await client.pair(code, 'e2e-integration');
      expect(paired.token.isNotEmpty, true);
      client.token = paired.token;

      // 2) 工具发现（真机上可能一个都没装，只断言结构）。
      final tools = await client.listTools();
      expect(tools, isA<List<ToolInfo>>());

      // 3) 浏览 workspace 根，挑一个项目目录。
      final root = await client.workspaceRoot();
      expect(root.isNotEmpty, true);
      final entries = await client.browseRoots();
      expect(entries, isA<List<RootEntry>>());

      String? createdId;
      try {
        // 4) 新建会话（懒启动，不 spawn CLI）。
        final created = await client.createSession(
          projectId: 'e2e-integration',
          toolId: 'claude-code',
          cwd: root,
        );
        createdId = created.id;
        expect(created.id.isNotEmpty, true);

        // 5) 会话出现在列表里。
        final sessions = await client.listSessions();
        expect(sessions.any((s) => s.id == createdId), true);

        // 6) 详情可取。
        final detail = await client.getSession(createdId);
        expect(detail.id, createdId);
        expect(detail.toolId, 'claude-code');

        // 7) 实时 WS：能连上并完成一次 ping/pong 心跳。
        await _assertWsPingPong(serverUrl, paired.token);
      } finally {
        // 8) 清理新建的会话，保持服务端状态干净、可重复运行。
        if (createdId != null) {
          await client.deleteSession(createdId);
        }
      }
    }, timeout: const Timeout(Duration(seconds: 45)));
  }, skip: skip);
}

Future<void> _assertWsPingPong(String base, String token) async {
  final ws = WsClient(wsUrl: resolveWsUrl(base), token: token);
  final connected = Completer<void>();
  final pong = Completer<void>();
  final statusSub = ws.status.listen((s) {
    if (s == WsStatus.connected && !connected.isCompleted) connected.complete();
  });
  final eventSub = ws.events.listen((m) {
    if (m.t == 'pong' && !pong.isCompleted) pong.complete();
  });
  try {
    await ws.connect();
    await connected.future.timeout(const Duration(seconds: 8));
    ws.send({'t': 'ping'});
    await pong.future.timeout(const Duration(seconds: 8));
  } finally {
    await statusSub.cancel();
    await eventSub.cancel();
    await ws.close();
  }
}
