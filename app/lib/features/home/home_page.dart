import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/state/app_state.dart';

class HomePage extends ConsumerWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final conn = ref.watch(connectionProvider);
    return Scaffold(
      backgroundColor: const Color(0xFF060810),
      appBar: AppBar(
        backgroundColor: const Color(0xFF11131D),
        foregroundColor: Colors.white,
        title: Text(conn.deviceId != null ? '设备 ${conn.deviceId!.substring(0, 8)}' : 'Pocket Coding'),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            tooltip: '断开连接',
            onPressed: () async {
              await ref.read(connectionProvider.notifier).disconnect();
              if (context.mounted) context.go('/');
            },
          ),
        ],
      ),
      body: const Center(
        child: Padding(
          padding: EdgeInsets.all(32),
          child: Text(
            '已连接\n\nHome / Chat 页面待实现（Phase 4 Day 3-5）',
            textAlign: TextAlign.center,
            style: TextStyle(color: Color(0xFF94A3B8), fontSize: 13, height: 1.6),
          ),
        ),
      ),
    );
  }
}
