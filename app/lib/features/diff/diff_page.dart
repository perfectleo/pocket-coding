import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/protocol.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/theme.dart';

final diffProvider = FutureProvider.family<List<DiffHunk>, DiffArgs>((ref, args) async {
  final api = ref.watch(apiClientProvider);
  if (api == null) return [];
  return api.getDiff(args.sessionId, cpId: args.cpId);
});

class DiffArgs {
  final String sessionId;
  final String? cpId;
  const DiffArgs({required this.sessionId, this.cpId});
}

class DiffPage extends ConsumerStatefulWidget {
  final String sessionId;
  final String? cpId;
  const DiffPage({super.key, required this.sessionId, this.cpId});

  @override
  ConsumerState<DiffPage> createState() => _DiffPageState();
}

class _DiffPageState extends ConsumerState<DiffPage> {
  String? _selectedFile;
  final Set<int> _rejectedHunks = {}; // hunk block indices within the selected file

  @override
  Widget build(BuildContext context) {
    final t = ref.watch(themeProvider);
    final args = DiffArgs(sessionId: widget.sessionId, cpId: widget.cpId);
    final diff = ref.watch(diffProvider(args));
    return Scaffold(
      backgroundColor: t.background,
      appBar: AppBar(
        backgroundColor: t.card,
        foregroundColor: t.foreground,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.pop(),
        ),
        title: const Text('Diff 审阅', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
      ),
      body: diff.when(
        loading: () => Center(child: CircularProgressIndicator(color: t.accent)),
        error: (e, _) => Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Text('加载失败\n$e',
                textAlign: TextAlign.center,
                style: TextStyle(color: t.sub, fontSize: 13, height: 1.5)),
          ),
        ),
        data: (hunks) {
          if (hunks.isEmpty) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(32),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.check_circle_outline, color: t.sub, size: 40),
                    const SizedBox(height: 10),
                    Text('没有改动', style: TextStyle(color: t.sub, fontSize: 13)),
                  ],
                ),
              ),
            );
          }
          final files = hunks.map((h) => h.file).toList();
          _selectedFile ??= files.first;
          final selected = hunks.firstWhere((h) => h.file == _selectedFile);
          return Column(
            children: [
              _FileTabs(
                t: t,
                files: files,
                selected: _selectedFile!,
                hunks: hunks,
                onSelect: (f) => setState(() {
                  _selectedFile = f;
                  _rejectedHunks.clear();
                }),
              ),
              Expanded(child: _HunkList(t: t, hunk: selected, rejected: _rejectedHunks, onToggle: (i) => setState(() {
                if (_rejectedHunks.contains(i)) {
                  _rejectedHunks.remove(i);
                } else {
                  _rejectedHunks.add(i);
                }
              }))),
              _ActionBar(
                t: t,
                hasContent: hunks.isNotEmpty,
                onAccept: () => _accept(context, t, hunks),
                onRollback: () => _rollbackConfirm(context, t),
              ),
            ],
          );
        },
      ),
    );
  }

  Future<void> _accept(BuildContext context, PocketTheme t, List<DiffHunk> hunks) async {
    final api = ref.read(apiClientProvider);
    if (api == null) return;
    final cpId = widget.cpId;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: t.card,
        title: Text('接受改动？', style: TextStyle(color: t.foreground)),
        content: Text(
          cpId != null
              ? '将 baseline 前移到该检查点，后续可回退到此之前。'
              : '将接受当前所有改动。',
          style: TextStyle(color: t.sub, fontSize: 13),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('接受')),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      if (cpId != null) {
        await api.acceptCheckpoint(widget.sessionId, cpId);
      }
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: const Text('已接受'), backgroundColor: t.accent),
        );
        ref.invalidate(diffProvider(DiffArgs(sessionId: widget.sessionId, cpId: widget.cpId)));
        context.pop();
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('失败：$e'), backgroundColor: t.danger),
        );
      }
    }
  }

  Future<void> _rollbackConfirm(BuildContext context, PocketTheme t) async {
    final cpId = widget.cpId;
    if (cpId == null) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: t.card,
        title: Text('回退到此检查点？', style: TextStyle(color: t.danger)),
        content: Text(
          '工作树将恢复到该快照，之后的改动会丢失。对话历史保留。',
          style: TextStyle(color: t.sub, fontSize: 13),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: t.danger),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('回退'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    final api = ref.read(apiClientProvider);
    if (api == null) return;
    try {
      await api.rollbackCheckpoint(widget.sessionId, cpId);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: const Text('已回退'), backgroundColor: t.danger),
        );
        ref.invalidate(diffProvider(DiffArgs(sessionId: widget.sessionId, cpId: widget.cpId)));
        context.pop();
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('失败：$e'), backgroundColor: t.danger),
        );
      }
    }
  }
}

class _FileTabs extends StatelessWidget {
  final PocketTheme t;
  final List<String> files;
  final String selected;
  final List<DiffHunk> hunks;
  final ValueChanged<String> onSelect;
  const _FileTabs({required this.t, required this.files, required this.selected, required this.hunks, required this.onSelect});

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 40,
      color: t.card,
      child: ListView.builder(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        itemCount: files.length,
        itemBuilder: (context, i) {
          final f = files[i];
          final sel = f == selected;
          final h = hunks.firstWhere((h) => h.file == f);
          return Padding(
            padding: const EdgeInsets.only(right: 6),
            child: GestureDetector(
              onTap: () => onSelect(f),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                decoration: BoxDecoration(
                  color: sel ? t.accent : t.cardAlt,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: sel ? t.accent : t.border, width: 0.5),
                ),
                child: Row(
                  children: [
                    Text(
                      f.split('/').last,
                      style: TextStyle(
                        color: sel ? t.accentForeground : t.foreground,
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        fontFamily: t.fontMono,
                      ),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      '+${h.added} -${h.removed}',
                      style: TextStyle(
                        color: sel ? t.accentForeground.withValues(alpha: 0.7) : t.sub,
                        fontSize: 10,
                        fontFamily: t.fontMono,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

class _HunkList extends StatelessWidget {
  final PocketTheme t;
  final DiffHunk hunk;
  final Set<int> rejected;
  final ValueChanged<int> onToggle;
  const _HunkList({required this.t, required this.hunk, required this.rejected, required this.onToggle});

  @override
  Widget build(BuildContext context) {
    return ListView.builder(
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 80),
      itemCount: hunk.hunks.length,
      itemBuilder: (context, i) {
        final block = hunk.hunks[i];
        final isRejected = rejected.contains(i);
        return Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Container(
            decoration: BoxDecoration(
              color: t.card,
              borderRadius: BorderRadius.circular(t.radius),
              border: Border.all(
                color: isRejected ? t.danger : t.border,
                width: isRejected ? 1 : 0.5,
              ),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          block.header,
                          style: TextStyle(
                            color: t.sub,
                            fontSize: 10,
                            fontFamily: t.fontMono,
                          ),
                        ),
                      ),
                      GestureDetector(
                        onTap: () => onToggle(i),
                        child: Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                          decoration: BoxDecoration(
                            color: isRejected ? t.danger : t.accent,
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: Text(
                            isRejected ? '已拒' : '接受',
                            style: TextStyle(
                              color: isRejected ? Colors.white : t.accentForeground,
                              fontSize: 10,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                Divider(height: 1, color: t.border),
                ...block.lines.map((line) => _DiffLine(line: line, t: t)),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _DiffLine extends StatelessWidget {
  final DiffHunkLine line;
  final PocketTheme t;
  const _DiffLine({required this.line, required this.t});

  @override
  Widget build(BuildContext context) {
    final (bg, fg, prefix) = switch (line.type) {
      'add' => (t.accent.withValues(alpha: 0.12), t.accent, '+'),
      'del' => (t.danger.withValues(alpha: 0.12), t.dangerFg, '-'),
      _ => (Colors.transparent, t.foreground, ' '),
    };
    final no = line.type == 'add'
        ? (line.newNo?.toString() ?? '')
        : line.type == 'del'
            ? (line.oldNo?.toString() ?? '')
            : (line.oldNo?.toString() ?? '');
    return Container(
      color: bg,
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 1),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 36,
            child: Text(
              no,
              style: TextStyle(
                color: t.sub.withValues(alpha: 0.6),
                fontSize: 10,
                fontFamily: t.fontMono,
              ),
            ),
          ),
          Text(
            prefix,
            style: TextStyle(color: fg, fontSize: 11, fontFamily: t.fontMono),
          ),
          const SizedBox(width: 4),
          Expanded(
            child: Text(
              line.text,
              style: TextStyle(color: fg, fontSize: 11, fontFamily: t.fontMono, height: 1.45),
              softWrap: true,
            ),
          ),
        ],
      ),
    );
  }
}

class _ActionBar extends StatelessWidget {
  final PocketTheme t;
  final bool hasContent;
  final VoidCallback onAccept;
  final VoidCallback onRollback;
  const _ActionBar({required this.t, required this.hasContent, required this.onAccept, required this.onRollback});

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Container(
        decoration: BoxDecoration(
          color: t.card,
          border: Border(top: BorderSide(color: t.border, width: 0.5)),
        ),
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
        child: Row(
          children: [
            Expanded(
              child: OutlinedButton.icon(
                onPressed: onRollback,
                icon: Icon(Icons.undo, color: t.danger, size: 16),
                label: Text('回退改动前', style: TextStyle(color: t.danger)),
                style: OutlinedButton.styleFrom(
                  side: BorderSide(color: t.danger),
                  padding: const EdgeInsets.symmetric(vertical: 12),
                ),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: FilledButton.icon(
                onPressed: hasContent ? onAccept : null,
                icon: const Icon(Icons.check, size: 16),
                label: const Text('全部接受'),
                style: FilledButton.styleFrom(
                  backgroundColor: t.accent,
                  foregroundColor: t.accentForeground,
                  disabledBackgroundColor: t.cardAlt,
                  padding: const EdgeInsets.symmetric(vertical: 12),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
