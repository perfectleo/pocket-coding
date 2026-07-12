import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/protocol.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/theme.dart';

final fileListProvider =
    FutureProvider.family<List<FileEntry>, ({String sessionId, String path})>((ref, args) async {
  final api = ref.watch(apiClientProvider);
  if (api == null) return [];
  return api.listFiles(args.sessionId, path: args.path);
});

final fileContentProvider =
    FutureProvider.family<String, ({String sessionId, String path})>((ref, args) async {
  final api = ref.watch(apiClientProvider);
  if (api == null) return '';
  return api.readFile(args.sessionId, args.path);
});

class FilesPage extends ConsumerStatefulWidget {
  final String sessionId;
  const FilesPage({super.key, required this.sessionId});

  @override
  ConsumerState<FilesPage> createState() => _FilesPageState();
}

class _FilesPageState extends ConsumerState<FilesPage> {
  String _path = '';
  final List<String> _stack = [];
  String? _viewing;

  void _enter(String name) {
    setState(() {
      _stack.add(_path);
      _path = _path.isEmpty ? name : '$_path/$name';
    });
  }

  void _up() {
    if (_stack.isEmpty) {
      context.pop();
      return;
    }
    setState(() {
      _path = _stack.removeLast();
    });
  }

  @override
  Widget build(BuildContext context) {
    final t = ref.watch(themeProvider);
    if (_viewing != null) {
      return _FileViewer(
        sessionId: widget.sessionId,
        path: _viewing!,
        t: t,
        onBack: () => setState(() => _viewing = null),
      );
    }
    final entries = ref.watch(fileListProvider((sessionId: widget.sessionId, path: _path)));
    return Scaffold(
      backgroundColor: t.background,
      appBar: AppBar(
        backgroundColor: t.card,
        foregroundColor: t.foreground,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: _up,
        ),
        title: Text(
          _path.isEmpty ? '文件' : _path,
          style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
          overflow: TextOverflow.ellipsis,
        ),
      ),
      body: entries.when(
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
              child: Text('空目录', style: TextStyle(color: t.sub, fontSize: 13)),
            );
          }
          return ListView.separated(
            padding: const EdgeInsets.symmetric(vertical: 8),
            itemCount: list.length,
            separatorBuilder: (_, _) => Divider(height: 1, color: t.border, indent: 56, endIndent: 16),
            itemBuilder: (context, i) {
              final e = list[i];
              return ListTile(
                leading: Icon(
                  e.dir ? Icons.folder_outlined : Icons.insert_drive_file_outlined,
                  color: e.dir ? t.accent : t.sub,
                  size: 22,
                ),
                title: Text(
                  e.name,
                  style: TextStyle(
                    color: t.foreground,
                    fontSize: 13,
                    fontWeight: e.dir ? FontWeight.w600 : FontWeight.w400,
                  ),
                ),
                subtitle: e.dir
                    ? null
                    : Text(
                        _sizeLabel(e.size),
                        style: TextStyle(color: t.sub, fontSize: 10, fontFamily: t.fontMono),
                      ),
                trailing: Icon(Icons.chevron_right, color: t.sub, size: 18),
                onTap: () {
                  if (e.dir) {
                    _enter(e.name);
                  } else {
                    setState(() => _viewing = e.path);
                  }
                },
              );
            },
          );
        },
      ),
    );
  }

  String _sizeLabel(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
  }
}

class _FileViewer extends ConsumerWidget {
  final String sessionId;
  final String path;
  final PocketTheme t;
  final VoidCallback onBack;
  const _FileViewer({required this.sessionId, required this.path, required this.t, required this.onBack});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final content = ref.watch(fileContentProvider((sessionId: sessionId, path: path)));
    return Scaffold(
      backgroundColor: t.background,
      appBar: AppBar(
        backgroundColor: t.card,
        foregroundColor: t.foreground,
        leading: IconButton(icon: const Icon(Icons.arrow_back), onPressed: onBack),
        title: Text(
          path.split('/').last,
          style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
        ),
      ),
      body: content.when(
        loading: () => Center(child: CircularProgressIndicator(color: t.accent)),
        error: (e, _) => Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Text('读取失败\n$e',
                textAlign: TextAlign.center,
                style: TextStyle(color: t.sub, fontSize: 13, height: 1.5)),
          ),
        ),
        data: (text) => SingleChildScrollView(
          padding: const EdgeInsets.all(12),
          child: SelectableText(
            text,
            style: TextStyle(
              color: t.foreground,
              fontSize: 12,
              fontFamily: t.fontMono,
              height: 1.5,
            ),
          ),
        ),
      ),
    );
  }
}
