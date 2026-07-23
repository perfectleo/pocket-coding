// Widget tests for HomePage + its bottom sheets, driven by a fake ApiClient.
//
// These are pure widget tests (no server / no device). We inject a
// FakeApiClient by overriding apiClientProvider, and mount HomePage inside a
// self-contained GoRouter so the navigation calls it makes (context.go to
// '/chat/:id', context.push to '/theme') land on assertable placeholder pages.
//
// Covered:
//  - session list rendering (project ids, tool labels, last message)
//  - empty / error states
//  - delete flow: tap trash → confirm dialog → deleteSession called + row gone
//  - import sheet: lists host sessions, marks already-imported, and tapping an
//    un-imported one calls importHostSession + navigates to the local chat.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:app/core/api/client.dart';
import 'package:app/core/protocol.dart';
import 'package:app/core/state/app_state.dart';
import 'package:app/features/home/home_page.dart';

/// Fake ApiClient — overrides only the methods HomePage touches. Records calls
/// and mutates its own session list so provider invalidation reflects reality.
class FakeApiClient extends ApiClient {
  List<SessionSummary> sessions;
  List<HostSession> hostSessions;
  final bool throwOnListSessions;
  final List<String> deleteCalls = [];
  final List<Map<String, String>> importCalls = [];

  FakeApiClient({
    List<SessionSummary>? sessions,
    List<HostSession>? hostSessions,
    this.throwOnListSessions = false,
  })  : sessions = sessions ?? [],
        hostSessions = hostSessions ?? [],
        super(baseUrl: 'http://test');

  @override
  Future<List<SessionSummary>> listSessions() async {
    if (throwOnListSessions) throw Exception('boom');
    return List.of(sessions);
  }

  @override
  Future<List<HostSession>> listHostSessions({String? tool, String? cwd}) async =>
      List.of(hostSessions);

  @override
  Future<({String id, int backfilled})> importHostSession({
    required String toolId,
    required String externalSessionId,
    required String cwd,
  }) async {
    importCalls.add({
      'toolId': toolId,
      'externalSessionId': externalSessionId,
      'cwd': cwd,
    });
    return (id: 'local-imported', backfilled: 2);
  }

  @override
  Future<void> deleteSession(String sessionId) async {
    deleteCalls.add(sessionId);
    sessions = sessions.where((s) => s.id != sessionId).toList();
  }
}

/// Notifier that seeds apiClientProvider with our fake up front.
class _FakeApiClientNotifier extends ApiClientNotifier {
  _FakeApiClientNotifier(ApiClient client) {
    state = client;
  }
}

SessionSummary _session({
  String id = 's1',
  String projectId = 'proj-a',
  String toolId = 'claude-code',
  String? lastMessage,
  String? externalSessionId,
}) =>
    SessionSummary(
      id: id,
      projectId: projectId,
      toolId: toolId,
      state: 'idle',
      lastSeq: 0,
      createdAt: 0,
      lastMessage: lastMessage,
      externalSessionId: externalSessionId,
    );

HostSession _host({
  String toolId = 'codex',
  String externalSessionId = 'ext-1',
  String cwd = '/home/me/proj',
  int messageCount = 3,
  String summary = '修复登录 bug',
  bool imported = false,
}) =>
    HostSession(
      toolId: toolId,
      externalSessionId: externalSessionId,
      cwd: cwd,
      updatedAt: 0,
      messageCount: messageCount,
      summary: summary,
      filePath: '/tmp/$externalSessionId.jsonl',
      imported: imported,
    );

/// Mount HomePage in a self-contained router exposing placeholder targets for
/// the navigations it can trigger, with the fake ApiClient injected.
Widget _harness(FakeApiClient fake) {
  final router = GoRouter(
    initialLocation: '/',
    routes: [
      GoRoute(path: '/', builder: (_, _) => const HomePage()),
      GoRoute(path: '/theme', builder: (_, _) => const Scaffold(body: Text('THEME_PAGE'))),
      GoRoute(
        path: '/chat/:id',
        builder: (_, s) => Scaffold(body: Text('CHAT_${s.pathParameters['id']}')),
      ),
    ],
  );
  return ProviderScope(
    overrides: [
      apiClientProvider.overrideWith((ref) => _FakeApiClientNotifier(fake)),
    ],
    child: MaterialApp.router(routerConfig: router),
  );
}

void main() {
  testWidgets('renders session list from ApiClient', (tester) async {
    final fake = FakeApiClient(sessions: [
      _session(id: 's1', projectId: 'proj-a', toolId: 'claude-code', lastMessage: '你好世界'),
      _session(id: 's2', projectId: 'proj-b', toolId: 'codex'),
    ]);
    await tester.pumpWidget(_harness(fake));
    await tester.pumpAndSettle();

    expect(find.text('proj-a'), findsOneWidget);
    expect(find.text('proj-b'), findsOneWidget);
    expect(find.text('你好世界'), findsOneWidget);
    // Tool labels in the subtitle.
    expect(find.text('claude'), findsOneWidget);
    expect(find.text('codex'), findsOneWidget);
  });

  testWidgets('empty state when no sessions', (tester) async {
    final fake = FakeApiClient(sessions: const []);
    await tester.pumpWidget(_harness(fake));
    await tester.pumpAndSettle();

    expect(find.textContaining('还没有会话'), findsOneWidget);
  });

  testWidgets('error state when listSessions throws', (tester) async {
    final fake = FakeApiClient(throwOnListSessions: true);
    await tester.pumpWidget(_harness(fake));
    await tester.pumpAndSettle();

    expect(find.textContaining('加载会话失败'), findsOneWidget);
  });

  testWidgets('delete flow: confirm dialog → deleteSession + row removed', (tester) async {
    final fake = FakeApiClient(sessions: [_session(id: 's1', projectId: 'proj-a')]);
    await tester.pumpWidget(_harness(fake));
    await tester.pumpAndSettle();

    expect(find.text('proj-a'), findsOneWidget);

    // Tap the trailing trash icon on the tile.
    await tester.tap(find.byTooltip('删除'));
    await tester.pumpAndSettle();

    // Confirm dialog.
    expect(find.text('删除会话？'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, '删除'));
    await tester.pumpAndSettle();

    expect(fake.deleteCalls, ['s1']);
    // Provider invalidated → re-fetched empty → row gone, empty state shown.
    expect(find.text('proj-a'), findsNothing);
    expect(find.textContaining('还没有会话'), findsOneWidget);
  });

  testWidgets('delete flow: cancel does not call deleteSession', (tester) async {
    final fake = FakeApiClient(sessions: [_session(id: 's1', projectId: 'proj-a')]);
    await tester.pumpWidget(_harness(fake));
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('删除'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, '取消'));
    await tester.pumpAndSettle();

    expect(fake.deleteCalls, isEmpty);
    expect(find.text('proj-a'), findsOneWidget);
  });

  testWidgets('import sheet lists host sessions and marks imported', (tester) async {
    final fake = FakeApiClient(
      sessions: const [],
      hostSessions: [
        _host(externalSessionId: 'ext-1', summary: '修复登录 bug', imported: false),
        _host(externalSessionId: 'ext-2', summary: '写单元测试', imported: true),
      ],
    );
    await tester.pumpWidget(_harness(fake));
    await tester.pumpAndSettle();

    // Open the import sheet via the appbar action.
    await tester.tap(find.byTooltip('导入电脑会话'));
    await tester.pumpAndSettle();

    expect(find.text('导入电脑会话'), findsOneWidget);
    expect(find.text('修复登录 bug'), findsOneWidget);
    expect(find.text('写单元测试'), findsOneWidget);
    // The already-imported one is badged.
    expect(find.text('已导入'), findsOneWidget);
  });

  testWidgets('import tap calls importHostSession and navigates to chat', (tester) async {
    final fake = FakeApiClient(
      sessions: const [],
      hostSessions: [_host(toolId: 'codex', externalSessionId: 'ext-1', summary: '修复登录 bug')],
    );
    await tester.pumpWidget(_harness(fake));
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('导入电脑会话'));
    await tester.pumpAndSettle();

    // Tap the (un-imported) host session tile.
    await tester.tap(find.text('修复登录 bug'));
    await tester.pumpAndSettle();

    expect(fake.importCalls, hasLength(1));
    expect(fake.importCalls.first, {
      'toolId': 'codex',
      'externalSessionId': 'ext-1',
      'cwd': '/home/me/proj',
    });
    // Navigated to the returned local session's chat page.
    expect(find.text('CHAT_local-imported'), findsOneWidget);
  });

  testWidgets('import sheet shows empty hint when no host sessions', (tester) async {
    final fake = FakeApiClient(sessions: const [], hostSessions: const []);
    await tester.pumpWidget(_harness(fake));
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('导入电脑会话'));
    await tester.pumpAndSettle();

    expect(find.textContaining('没有发现电脑会话'), findsOneWidget);
  });
}
