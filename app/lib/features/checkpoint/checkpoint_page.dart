import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/protocol.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/theme.dart';

final checkpointsProvider =
    FutureProvider.family<List<CheckpointRecord>, String>((ref, sessionId) async {
  final api = ref.watch(apiClientProvider);
  if (api == null) return [];
  return api.listCheckpoints(sessionId);
});

class CheckpointPage extends ConsumerWidget {
  final String sessionId;
  const CheckpointPage({super.key, required this.sessionId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = ref.watch(themeProvider);
    final cps = ref.watch(checkpointsProvider(sessionId));
    return Scaffold(
      backgroundColor: t.background,
      appBar: AppBar(
        backgroundColor: t.card,
        foregroundColor: t.foreground,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.pop(),
        ),
        title: const Text('检查点', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
        actions: [
          IconButton(
            icon: Icon(Icons.refresh, color: t.sub),
            onPressed: () => ref.invalidate(checkpointsProvider(sessionId)),
          ),
        ],
      ),
      body: cps.when(
        loading: () => Center(child: CircularProgressIndicator(color: t.accent)),
        error: (e, _) => Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Text('加载失败\n$e',
                textAlign: TextAlign.center,
                style: TextStyle(color: t.sub, fontSize: 13, height: 1.5)),
          ),
        ),
        data: (list) {
          if (list.isEmpty) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(32),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.history, color: t.sub, size: 40),
                    const SizedBox(height: 10),
                    Text('还没有检查点\n发条消息让 AI 改点东西',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: t.sub, fontSize: 13, height: 1.6)),
                  ],
                ),
              ),
            );
          }
          final reversed = list.reversed.toList();
          return ListView.separated(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
            itemCount: reversed.length,
            separatorBuilder: (_, _) => const SizedBox(height: 0),
            itemBuilder: (context, i) => _TimelineNode(
              cp: reversed[i],
              isLast: i == reversed.length - 1,
              sessionId: sessionId,
            ),
          );
        },
      ),
    );
  }
}

class _TimelineNode extends ConsumerWidget {
  final CheckpointRecord cp;
  final bool isLast;
  final String sessionId;
  const _TimelineNode({required this.cp, required this.isLast, required this.sessionId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = ref.watch(themeProvider);
    final (dotColor, statusLabel, statusFg) = _statusVisual(cp.status, t);
    final totalAdded = _sumAdded(cp.files);
    final totalRemoved = _sumRemoved(cp.files);
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 32,
            child: Column(
              children: [
                Container(
                  width: 14,
                  height: 14,
                  decoration: BoxDecoration(
                    color: dotColor,
                    shape: BoxShape.circle,
                    border: Border.all(color: t.background, width: 2),
                  ),
                ),
                if (!isLast)
                  Expanded(
                    child: Container(
                      width: 2,
                      color: t.border,
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Container(
              margin: const EdgeInsets.only(bottom: 14),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: cp.status == 'rolledback' ? t.cardAlt.withValues(alpha: 0.4) : t.card,
                borderRadius: BorderRadius.circular(t.radius),
                border: Border.all(color: t.border, width: 0.5),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          color: statusFg.withValues(alpha: 0.15),
                          borderRadius: BorderRadius.circular(4),
                        ),
                        child: Text(
                          statusLabel,
                          style: TextStyle(
                            color: statusFg,
                            fontSize: 10,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                      const Spacer(),
                      Text(
                        _timeLabel(cp.createdAt),
                        style: TextStyle(
                          color: t.sub,
                          fontSize: 10,
                          fontFamily: t.fontMono,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Text(
                    cp.turnId,
                    style: TextStyle(
                      color: t.foreground,
                      fontSize: 12,
                      fontFamily: t.fontMono,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                  if (cp.files.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      children: [
                        _stat(t, '+$totalAdded', t.accent),
                        _stat(t, '-$totalRemoved', t.danger),
                        _stat(t, '${cp.files.length} 文件', t.sub),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(
                      cp.files
                          .map((f) => (f as Map<String, dynamic>)['path'] as String?)
                          .where((p) => p != null)
                          .take(3)
                          .join('\n'),
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: t.sub,
                        fontSize: 10,
                        fontFamily: t.fontMono,
                        height: 1.4,
                      ),
                    ),
                  ],
                  if (cp.status == 'pending') ...[
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton.icon(
                            onPressed: () => context.push('/diff/$sessionId?cpId=${cp.id}'),
                            icon: Icon(Icons.difference_outlined, color: t.accent, size: 14),
                            label: Text('看 Diff', style: TextStyle(color: t.accent, fontSize: 12)),
                            style: OutlinedButton.styleFrom(
                              side: BorderSide(color: t.accent),
                              padding: const EdgeInsets.symmetric(vertical: 8),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                  if (cp.status == 'accepted') ...[
                    const SizedBox(height: 6),
                    Row(
                      children: [
                        Icon(Icons.flag_outlined, color: t.sub, size: 12),
                        const SizedBox(width: 4),
                        Text(
                          'baseline 里程碑',
                          style: TextStyle(color: t.sub, fontSize: 10),
                        ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _stat(PocketTheme t, String text, Color color) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.1),
          borderRadius: BorderRadius.circular(4),
        ),
        child: Text(
          text,
          style: TextStyle(
            color: color,
            fontSize: 10,
            fontFamily: t.fontMono,
            fontWeight: FontWeight.w600,
          ),
        ),
      );

  (Color, String, Color) _statusVisual(String status, PocketTheme t) {
    switch (status) {
      case 'pending':
        return (t.accent, '待接受', t.accent);
      case 'accepted':
        return (t.sub, '已接受', t.sub);
      case 'rolledback':
        return (t.danger.withValues(alpha: 0.5), '已回退', t.danger);
      default:
        return (t.sub, status, t.sub);
    }
  }

  int _sumAdded(List<dynamic> files) => files.fold<int>(
      0, (a, f) => a + (((f as Map?)?['added'] as int?) ?? 0));
  int _sumRemoved(List<dynamic> files) => files.fold<int>(
      0, (a, f) => a + (((f as Map?)?['removed'] as int?) ?? 0));

  String _timeLabel(int ms) {
    final dt = DateTime.fromMillisecondsSinceEpoch(ms);
    String two(int n) => n.toString().padLeft(2, '0');
    return '${two(dt.month)}-${two(dt.day)} ${two(dt.hour)}:${two(dt.minute)}';
  }
}
