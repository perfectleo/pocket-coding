import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'core/state/app_state.dart';
import 'core/theme/theme.dart';
import 'features/connect/connect_page.dart';
import 'features/home/home_page.dart';
import 'features/chat/chat_page.dart';
import 'features/diff/diff_page.dart';
import 'features/checkpoint/checkpoint_page.dart';
import 'features/files/files_page.dart';
import 'features/preview/preview_page.dart';
import 'features/theme/theme_picker_page.dart';

void main() {
  runApp(const ProviderScope(child: PocketCodingApp()));
}

final _router = GoRouter(
  initialLocation: '/',
  routes: [
    GoRoute(path: '/', builder: (_, _) => const ConnectPage()),
    GoRoute(path: '/home', builder: (_, _) => const HomePage()),
    GoRoute(path: '/theme', builder: (_, _) => const ThemePickerPage()),
    GoRoute(
      path: '/chat/:id',
      builder: (context, state) => ChatPage(sessionId: state.pathParameters['id']!),
    ),
    GoRoute(
      path: '/diff/:id',
      builder: (context, state) {
        final sid = state.pathParameters['id']!;
        final cpId = state.uri.queryParameters['cpId'];
        return DiffPage(sessionId: sid, cpId: cpId);
      },
    ),
    GoRoute(
      path: '/checkpoints/:id',
      builder: (context, state) =>
          CheckpointPage(sessionId: state.pathParameters['id']!),
    ),
    GoRoute(
      path: '/files/:id',
      builder: (context, state) => FilesPage(sessionId: state.pathParameters['id']!),
    ),
    GoRoute(
      path: '/preview/:id',
      builder: (context, state) => PreviewPage(sessionId: state.pathParameters['id']!),
    ),
  ],
  redirect: (context, state) async {
    final container = ProviderScope.containerOf(context);
    final conn = container.read(connectionProvider);
    final loc = state.matchedLocation;
    final guarded = loc == '/home' ||
        loc.startsWith('/chat/') ||
        loc.startsWith('/diff/') ||
        loc.startsWith('/checkpoints/') ||
        loc.startsWith('/files/') ||
        loc.startsWith('/preview/');
    if (conn.connected && loc == '/') {
      // Reopen into the last chat session if we have one — matches the
      // "continue where you left off" expectation. /home is still reachable
      // via the back button.
      if (conn.lastSessionId != null) return '/chat/${conn.lastSessionId}';
      return '/home';
    }
    if (!conn.connected && guarded) return '/';
    return null;
  },
);

class PocketCodingApp extends ConsumerStatefulWidget {
  const PocketCodingApp({super.key});

  @override
  ConsumerState<PocketCodingApp> createState() => _PocketCodingAppState();
}

class _PocketCodingAppState extends ConsumerState<PocketCodingApp> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(connectionProvider.notifier).load();
      ref.read(themeProvider.notifier).load();
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = ref.watch(themeProvider);
    return MaterialApp.router(
      title: 'Pocket Coding',
      theme: theme.toThemeData(),
      routerConfig: _router,
      debugShowCheckedModeBanner: false,
    );
  }
}
