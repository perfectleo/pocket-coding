import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/api/client.dart';
import '../../core/protocol.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/theme.dart';
import '../chat/chat_state.dart';

class HomePage extends ConsumerWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final conn = ref.watch(connectionProvider);
    final t = ref.watch(themeProvider);
    final sessions = ref.watch(sessionsProvider);
    return Scaffold(
      backgroundColor: t.background,
      appBar: AppBar(
        backgroundColor: t.card,
        foregroundColor: t.foreground,
        elevation: 0,
        title: Text(
          conn.deviceId != null ? '设备 ${conn.deviceId!.substring(0, 8)}' : 'Pocket Coding',
          style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
        actions: [
          IconButton(
            icon: Icon(Icons.refresh, color: t.sub),
            tooltip: '刷新',
            onPressed: () => ref.refresh(sessionsProvider),
          ),
          IconButton(
            icon: Icon(Icons.palette_outlined, color: t.sub),
            tooltip: '主题',
            onPressed: () => context.push('/theme'),
          ),
          IconButton(
            icon: Icon(Icons.logout, color: t.foreground),
            tooltip: '断开连接',
            onPressed: () async {
              await ref.read(connectionProvider.notifier).disconnect();
              if (context.mounted) context.go('/');
            },
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton(
        backgroundColor: t.accent,
        foregroundColor: t.accentForeground,
        onPressed: () => _showNewSessionSheet(context, ref, t),
        child: const Icon(Icons.add),
      ),
      body: sessions.when(
        loading: () => Center(child: CircularProgressIndicator(color: t.accent)),
        error: (e, _) => Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Text(
              '加载会话失败\n$e',
              textAlign: TextAlign.center,
              style: TextStyle(color: t.sub, fontSize: 13),
            ),
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
                    Icon(Icons.chat_bubble_outline, color: t.sub, size: 48),
                    const SizedBox(height: 12),
                    Text(
                      '还没有会话\n点右下角 + 新建',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: t.sub, fontSize: 13, height: 1.6),
                    ),
                  ],
                ),
              ),
            );
          }
          return RefreshIndicator(
            color: t.accent,
            onRefresh: () async => ref.refresh(sessionsProvider),
            child: ListView.separated(
              padding: const EdgeInsets.symmetric(vertical: 12),
              itemCount: list.length,
              separatorBuilder: (_, _) => Divider(height: 1, color: t.border, indent: 16, endIndent: 16),
              itemBuilder: (context, i) => _SessionTile(
                session: list[i],
                onTap: () => context.go('/chat/${list[i].id}'),
                onDelete: () => _confirmDelete(context, ref, t, list[i]),
              ),
            ),
          );
        },
      ),
    );
  }

  void _showNewSessionSheet(BuildContext context, WidgetRef ref, PocketTheme t) {
    showModalBottomSheet(
      context: context,
      backgroundColor: t.card,
      isScrollControlled: true,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(t.radius + 4)),
      ),
      builder: (ctx) => const _NewSessionSheet(),
    );
  }

  Future<void> _confirmDelete(
    BuildContext context,
    WidgetRef ref,
    PocketTheme t,
    SessionSummary session,
  ) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: t.card,
        title: Text('删除会话？', style: TextStyle(color: t.foreground, fontSize: 16)),
        content: Text(
          '将永久删除「${session.projectId}」的对话记录与检查点，不可恢复。',
          style: TextStyle(color: t.sub, fontSize: 13, height: 1.5),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text('取消', style: TextStyle(color: t.sub)),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: t.danger,
              foregroundColor: t.dangerFg,
            ),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    final api = ref.read(apiClientProvider);
    if (api == null) return;
    try {
      await api.deleteSession(session.id);
      ref.invalidate(sessionsProvider);
    } catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('删除失败：$e'), backgroundColor: t.danger),
      );
    }
  }
}

class _SessionTile extends ConsumerWidget {
  final SessionSummary session;
  final VoidCallback onTap;
  final VoidCallback onDelete;
  const _SessionTile({
    required this.session,
    required this.onTap,
    required this.onDelete,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = ref.watch(themeProvider);
    final stateColor = _stateColor(session.state, t);
    return ListTile(
      onTap: onTap,
      onLongPress: () => _showActions(context, t),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      leading: Container(
        width: 40,
        height: 40,
        decoration: BoxDecoration(
          color: t.cardAlt,
          borderRadius: BorderRadius.circular(t.radius),
        ),
        alignment: Alignment.center,
        child: Icon(_toolIcon(session.toolId), color: t.accent, size: 20),
      ),
      title: Row(
        children: [
          Expanded(
            child: Text(
              session.projectId,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: t.foreground,
                fontSize: 14,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          const SizedBox(width: 8),
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(color: stateColor, shape: BoxShape.circle),
          ),
        ],
      ),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const SizedBox(height: 2),
          Row(
            children: [
              Text(
                _toolLabel(session.toolId),
                style: TextStyle(
                  color: t.sub,
                  fontSize: 11,
                  fontFamily: t.fontMono,
                ),
              ),
              if (session.model != null) ...[
                const SizedBox(width: 6),
                Text(
                  '· ${session.model}',
                  style: TextStyle(color: t.sub, fontSize: 11, fontFamily: t.fontMono),
                ),
              ],
            ],
          ),
          if (session.lastMessage != null) ...[
            const SizedBox(height: 2),
            Text(
              session.lastMessage!,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: t.sub, fontSize: 12),
            ),
          ],
        ],
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          IconButton(
            icon: Icon(Icons.delete_outline, color: t.sub, size: 18),
            tooltip: '删除',
            onPressed: onDelete,
          ),
          Icon(Icons.chevron_right, color: t.sub, size: 20),
        ],
      ),
    );
  }

  void _showActions(BuildContext context, PocketTheme t) {
    showModalBottomSheet(
      context: context,
      backgroundColor: t.card,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(t.radius + 4)),
      ),
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: Icon(Icons.delete_outline, color: t.danger),
              title: Text('删除会话', style: TextStyle(color: t.danger)),
              onTap: () {
                Navigator.pop(ctx);
                onDelete();
              },
            ),
          ],
        ),
      ),
    );
  }

  Color _stateColor(String state, PocketTheme t) {
    switch (state) {
      case 'running':
        return t.accent;
      case 'waiting_approval':
        return const Color(0xFFF59E0B);
      case 'done':
        return t.sub;
      case 'error':
        return t.danger;
      default:
        return t.sub.withValues(alpha: 0.5);
    }
  }

  IconData _toolIcon(String toolId) {
    switch (toolId) {
      case 'claude-code':
      case 'codebuddy':
        return Icons.smart_toy_outlined;
      default:
        return Icons.code;
    }
  }

  String _toolLabel(String toolId) {
    switch (toolId) {
      case 'claude-code':
        return 'claude';
      case 'codebuddy':
        return 'codebuddy';
      default:
        return 'codex';
    }
  }
}

class _NewSessionSheet extends ConsumerStatefulWidget {
  const _NewSessionSheet();

  @override
  ConsumerState<_NewSessionSheet> createState() => _NewSessionSheetState();
}

class _NewSessionSheetState extends ConsumerState<_NewSessionSheet> {
  final _projectCtl = TextEditingController(text: 'my-project');
  final _modelCtl = TextEditingController();
  String _toolId = 'claude-code';
  // Relative path under the server's workspace root. Empty = use the root
  // itself as the cwd. The picker enforces confinement — server will reject
  // anything escaping the root via safeJoin.
  String _selectedRelPath = '';
  String? _root;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _projectCtl.dispose();
    _modelCtl.dispose();
    super.dispose();
  }

  Future<String> _ensureRoot() async {
    if (_root != null) return _root!;
    final api = ref.read(apiClientProvider);
    if (api == null) return '';
    try {
      _root = await api.workspaceRoot();
    } catch (_) {
      _root = '';
    }
    return _root!;
  }

  Future<void> _pickFolder() async {
    final t = ref.read(themeProvider);
    final api = ref.read(apiClientProvider);
    if (api == null) return;
    final root = await _ensureRoot();
    if (!mounted) return;
    String current = _selectedRelPath;
    await showDialog<void>(
      context: context,
      builder: (ctx) => _FolderPickerDialog(
        api: api,
        theme: t,
        root: root,
        initialPath: current,
        onPathChanged: (p) => current = p,
      ),
    );
    if (!mounted) return;
    setState(() => _selectedRelPath = current);
  }

  Future<void> _create() async {
    final api = ref.read(apiClientProvider);
    if (api == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final cwd = _selectedRelPath.isEmpty ? null : _selectedRelPath;
      final res = await api.createSession(
        projectId: _projectCtl.text.trim(),
        toolId: _toolId,
        model: _modelCtl.text.trim().isEmpty ? null : _modelCtl.text.trim(),
        cwd: cwd,
      );
      if (!mounted) return;
      ref.invalidate(sessionsProvider);
      context.pop();
      context.go('/chat/${res.id}');
    } catch (e) {
      setState(() {
        _error = '创建失败：$e';
        _busy = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = ref.watch(themeProvider);
    final padding = MediaQuery.of(context).viewInsets;
    return Padding(
      padding: EdgeInsets.only(bottom: padding.bottom),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 28),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Center(
              child: Container(
                width: 36,
                height: 4,
                margin: const EdgeInsets.only(bottom: 16),
                decoration: BoxDecoration(
                  color: t.border,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            Text(
              '新建会话',
              style: TextStyle(
                color: t.foreground,
                fontSize: 18,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 18),
            _Label(t: t, text: '工具'),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                _toolChip(t, 'claude-code', 'Claude Code'),
                _toolChip(t, 'codebuddy', 'CodeBuddy'),
                _toolChip(t, 'codex', 'Codex'),
              ],
            ),
            const SizedBox(height: 16),
            _Label(t: t, text: '项目 ID'),
            _field(t, _projectCtl, 'my-project'),
            const SizedBox(height: 14),
            _Label(t: t, text: '启动目录'),
            const SizedBox(height: 4),
            FutureBuilder<String>(
              future: _ensureRoot(),
              builder: (ctx, snap) {
                final root = snap.data ?? '';
                final label = _selectedRelPath.isEmpty
                    ? (root.isEmpty ? '工作根目录' : root)
                    : '$root/$_selectedRelPath';
                return InkWell(
                  onTap: _pickFolder,
                  borderRadius: BorderRadius.circular(t.radius),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
                    decoration: BoxDecoration(
                      color: t.inputFill,
                      borderRadius: BorderRadius.circular(t.radius),
                      border: Border.all(color: t.inputBorder),
                    ),
                    child: Row(
                      children: [
                        Icon(Icons.folder_outlined, color: t.sub, size: 16),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            label,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(color: t.foreground, fontSize: 13, fontFamily: t.fontMono),
                          ),
                        ),
                        Icon(Icons.chevron_right, color: t.sub, size: 18),
                      ],
                    ),
                  ),
                );
              },
            ),
            const SizedBox(height: 14),
            _Label(t: t, text: '模型（可选）'),
            _field(t, _modelCtl, 'claude-sonnet-4-6 / gpt-5 等'),
            const SizedBox(height: 22),
            if (_error != null) ...[
              Container(
                padding: const EdgeInsets.all(10),
                margin: const EdgeInsets.only(bottom: 12),
                decoration: BoxDecoration(
                  color: t.dangerBg,
                  borderRadius: BorderRadius.circular(t.radius),
                  border: Border.all(color: t.danger, width: 0.5),
                ),
                child: Text(_error!, style: TextStyle(color: t.dangerFg, fontSize: 12)),
              ),
            ],
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: _busy ? null : _create,
                icon: _busy
                    ? SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: t.accentForeground))
                    : const Icon(Icons.play_arrow),
                label: const Text('开始'),
                style: FilledButton.styleFrom(
                  backgroundColor: t.accent,
                  foregroundColor: t.accentForeground,
                  padding: const EdgeInsets.symmetric(vertical: 14),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _toolChip(PocketTheme t, String id, String label) {
    final selected = _toolId == id;
    return GestureDetector(
      onTap: () => setState(() => _toolId = id),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: selected ? t.accent : t.cardAlt,
          borderRadius: BorderRadius.circular(t.radius),
          border: Border.all(color: selected ? t.accent : t.border),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: selected ? t.accentForeground : t.foreground,
            fontSize: 13,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
    );
  }

  Widget _field(PocketTheme t, TextEditingController c, String hint) => TextField(
        controller: c,
        style: TextStyle(color: t.foreground, fontSize: 13),
        decoration: InputDecoration(
          hintText: hint,
          hintStyle: TextStyle(color: t.sub, fontSize: 13),
          filled: true,
          fillColor: t.inputFill,
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(t.radius),
            borderSide: BorderSide(color: t.inputBorder),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(t.radius),
            borderSide: BorderSide(color: t.inputBorder),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(t.radius),
            borderSide: BorderSide(color: t.inputBorderFocus),
          ),
          contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
        ),
      );
}

class _Label extends StatelessWidget {
  final PocketTheme t;
  final String text;
  const _Label({required this.t, required this.text});
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 4),
        child: Text(
          text,
          style: TextStyle(
            color: t.sub,
            fontSize: 11,
            fontWeight: FontWeight.w600,
            letterSpacing: 0.6,
          ),
        ),
      );
}

/// Browses the server's workspace root for a subfolder to use as a session's
/// cwd. The server confines browsing to the root via safeJoin, so '..' is
/// rejected at the API; we also hide it in the UI to avoid dead taps.
class _FolderPickerDialog extends StatefulWidget {
  final ApiClient api;
  final PocketTheme theme;
  final String root;
  final String initialPath;
  final ValueChanged<String> onPathChanged;
  const _FolderPickerDialog({
    required this.api,
    required this.theme,
    required this.root,
    required this.initialPath,
    required this.onPathChanged,
  });
  @override
  State<_FolderPickerDialog> createState() => _FolderPickerDialogState();
}

class _FolderPickerDialogState extends State<_FolderPickerDialog> {
  late String _path;
  List<RootEntry> _entries = const [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _path = widget.initialPath;
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final entries = await widget.api.browseRoots(path: _path);
      if (!mounted) return;
      setState(() {
        _entries = entries;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _loading = false;
      });
    }
  }

  void _enter(String name) {
    _path = _path.isEmpty ? name : '$_path/$name';
    widget.onPathChanged(_path);
    _load();
  }

  void _up() {
    if (_path.isEmpty) return;
    final i = _path.lastIndexOf('/');
    _path = i < 0 ? '' : _path.substring(0, i);
    widget.onPathChanged(_path);
    _load();
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.theme;
    return AlertDialog(
      backgroundColor: t.card,
      titlePadding: const EdgeInsets.fromLTRB(20, 16, 12, 0),
      contentPadding: const EdgeInsets.fromLTRB(0, 12, 0, 0),
      title: Row(
        children: [
          Expanded(
            child: Text(
              '选择启动目录',
              style: TextStyle(color: t.foreground, fontSize: 16, fontWeight: FontWeight.w600),
            ),
          ),
          if (_path.isNotEmpty)
            IconButton(
              icon: Icon(Icons.arrow_upward, color: t.sub, size: 20),
              tooltip: '上一级',
              onPressed: _up,
            ),
        ],
      ),
      content: SizedBox(
        width: double.maxFinite,
        height: 360,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              color: t.cardAlt,
              child: Text(
                _path.isEmpty ? (widget.root.isEmpty ? '/' : widget.root) : '${widget.root}/$_path',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: t.sub, fontSize: 11, fontFamily: t.fontMono),
              ),
            ),
            Expanded(
              child: _loading
                  ? Center(child: CircularProgressIndicator(color: t.accent, strokeWidth: 2))
                  : _error != null
                      ? Center(
                          child: Padding(
                            padding: const EdgeInsets.all(16),
                            child: Text('加载失败：$_error',
                                style: TextStyle(color: t.danger, fontSize: 12)),
                          ),
                        )
                      : _entries.isEmpty
                          ? Center(
                              child: Text('（空）',
                                  style: TextStyle(color: t.sub, fontSize: 12)),
                            )
                          : ListView.builder(
                              itemCount: _entries.length,
                              itemBuilder: (ctx, i) {
                                final e = _entries[i];
                                return ListTile(
                                  leading: Icon(Icons.folder, color: t.sub, size: 20),
                                  title: Text(e.name,
                                      style: TextStyle(color: t.foreground, fontSize: 13)),
                                  trailing: Icon(Icons.chevron_right, color: t.sub, size: 18),
                                  onTap: () => _enter(e.name),
                                );
                              },
                            ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text('取消', style: TextStyle(color: t.sub)),
        ),
        FilledButton(
          style: FilledButton.styleFrom(
            backgroundColor: t.accent,
            foregroundColor: t.accentForeground,
          ),
          onPressed: () {
            widget.onPathChanged(_path);
            Navigator.pop(context);
          },
          child: const Text('选择'),
        ),
      ],
    );
  }
}
