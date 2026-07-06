import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'core/state/app_state.dart';
import 'features/connect/connect_page.dart';
import 'features/home/home_page.dart';

void main() {
  runApp(const ProviderScope(child: PocketCodingApp()));
}

final _router = GoRouter(
  initialLocation: '/',
  routes: [
    GoRoute(path: '/', builder: (_, _) => const ConnectPage()),
    GoRoute(path: '/home', builder: (_, _) => const HomePage()),
  ],
  redirect: (context, state) async {
    final container = ProviderScope.containerOf(context);
    final conn = container.read(connectionProvider);
    if (conn.connected && state.matchedLocation == '/') return '/home';
    if (!conn.connected && state.matchedLocation == '/home') return '/';
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
    });
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: 'Pocket Coding',
      themeMode: ThemeMode.dark,
      theme: ThemeData(
        useMaterial3: true,
        scaffoldBackgroundColor: const Color(0xFF060810),
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF22C55E),
          brightness: Brightness.dark,
        ),
      ),
      routerConfig: _router,
      debugShowCheckedModeBanner: false,
    );
  }
}
