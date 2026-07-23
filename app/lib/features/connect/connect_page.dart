import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../core/api/client.dart';
import '../../core/protocol.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/theme.dart';

class ConnectPage extends ConsumerStatefulWidget {
  const ConnectPage({super.key});

  @override
  ConsumerState<ConnectPage> createState() => _ConnectPageState();
}

class _ConnectPageState extends ConsumerState<ConnectPage> {
  final _hostCtl = TextEditingController();
  final _codeCtl = TextEditingController();
  final _nameCtl = TextEditingController(text: 'my-phone');
  bool _busy = false;
  String? _error;
  String? _pendingCode;
  List<ToolInfo> _tools = [];

  static const _historyKey = 'hostHistory';
  static const _historyMax = 10;
  List<String> _hostHistory = [];
  bool _showHistory = false;

  @override
  void initState() {
    super.initState();
    _loadHistory();
  }

  @override
  void dispose() {
    _hostCtl.dispose();
    _codeCtl.dispose();
    _nameCtl.dispose();
    super.dispose();
  }

  Future<void> _loadHistory() async {
    final prefs = await SharedPreferences.getInstance();
    if (!mounted) return;
    setState(() => _hostHistory = prefs.getStringList(_historyKey) ?? []);
  }

  /// Record a successfully used host, most-recent first, de-duplicated and
  /// capped. Persisted so it survives restarts.
  Future<void> _rememberHost(String host) async {
    final h = host.trim();
    if (h.isEmpty) return;
    final prefs = await SharedPreferences.getInstance();
    final list = prefs.getStringList(_historyKey) ?? [];
    list.removeWhere((e) => e == h);
    list.insert(0, h);
    final capped = list.take(_historyMax).toList();
    await prefs.setStringList(_historyKey, capped);
    if (!mounted) return;
    setState(() => _hostHistory = capped);
  }

  Future<void> _removeHost(String host) async {
    final prefs = await SharedPreferences.getInstance();
    final list = prefs.getStringList(_historyKey) ?? [];
    list.removeWhere((e) => e == host);
    await prefs.setStringList(_historyKey, list);
    if (!mounted) return;
    setState(() {
      _hostHistory = list;
      if (_hostHistory.isEmpty) _showHistory = false;
    });
  }

  Future<void> _requestCode() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final host = _hostCtl.text.trim();
    if (host.isEmpty) {
      setState(() {
        _busy = false;
        _error = '请输入主机地址';
      });
      return;
    }
    final baseUrl = normalizeBaseUrl(host);
    try {
      final api = ApiClient(baseUrl: baseUrl);
      final code = await api.requestPairCode();
      await _rememberHost(host);
      setState(() {
        _pendingCode = code;
        _busy = false;
      });
    } catch (e) {
      setState(() {
        _error = '获取配对码失败：$e';
        _busy = false;
      });
    }
  }

  Future<void> _pair() async {
    final host = _hostCtl.text.trim();
    final code = _codeCtl.text.trim();
    if (host.isEmpty || code.isEmpty) {
      setState(() => _error = '主机地址和配对码不能为空');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(connectionProvider.notifier).pairAndConnect(
            host: host,
            code: code,
            name: _nameCtl.text.trim(),
          );
      await _rememberHost(host);
      if (mounted) context.go('/home');
    } catch (e) {
      setState(() {
        _error = '配对失败：$e';
        _busy = false;
      });
    }
  }

  Future<void> _probeTools() async {
    final host = _hostCtl.text.trim();
    if (host.isEmpty) return;
    final baseUrl = normalizeBaseUrl(host);
    try {
      final api = ApiClient(baseUrl: baseUrl);
      final tools = await api.listTools();
      setState(() => _tools = tools);
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final conn = ref.watch(connectionProvider);
    final t = ref.watch(themeProvider);
    return Scaffold(
      backgroundColor: t.background,
      body: SafeArea(
        child: Stack(
          children: [
            SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const SizedBox(height: 24),
                  Container(
                    width: 64,
                    height: 64,
                    margin: const EdgeInsets.only(bottom: 16),
                    decoration: BoxDecoration(
                      color: t.accent,
                      borderRadius: BorderRadius.circular(t.radius + 6),
                    ),
                    alignment: Alignment.center,
                    child: Icon(Icons.terminal, color: t.accentForeground, size: 32),
                  ),
                  Text(
                    'Pocket Coding',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color: t.foreground,
                      fontSize: 24,
                      fontWeight: FontWeight.w700,
                      letterSpacing: -0.5,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    t.tagline,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color: t.accent,
                      fontFamily: t.fontMono,
                      fontSize: 12,
                    ),
                  ),
                  const SizedBox(height: 32),
                  _card(
                    t: t,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        _Label(t: t, text: '云主机地址'),
                        _field(
                          t: t,
                          controller: _hostCtl,
                          hint: '127.0.0.1:8080（本地测试）或 box-42.example.com',
                          icon: Icons.cloud_outlined,
                          keyboardType: TextInputType.url,
                          onChanged: (_) => setState(() {}),
                          suffix: _hostHistory.isEmpty
                              ? null
                              : IconButton(
                                  icon: Icon(
                                    _showHistory ? Icons.expand_less : Icons.history,
                                    color: t.sub,
                                    size: 18,
                                  ),
                                  tooltip: '历史地址',
                                  onPressed: () => setState(() => _showHistory = !_showHistory),
                                ),
                        ),
                        if (_showHistory && _hostHistory.isNotEmpty) _historyPanel(t),
                        const SizedBox(height: 12),
                        Row(
                          children: [
                            Expanded(
                              child: OutlinedButton(
                                onPressed: _busy ? null : _probeTools,
                                style: OutlinedButton.styleFrom(
                                  foregroundColor: t.foreground,
                                  side: BorderSide(color: t.border),
                                  padding: const EdgeInsets.symmetric(vertical: 12),
                                ),
                                child: const Text('探测工具'),
                              ),
                            ),
                          ],
                        ),
                        if (_tools.isNotEmpty) ...[
                          const SizedBox(height: 12),
                          Wrap(
                            spacing: 8,
                            runSpacing: 8,
                            children: _tools
                                .where((t) => t.installed)
                                .map((tool) => _chip(t, '${tool.displayName} ${tool.version ?? ''}'))
                                .toList(growable: false),
                          ),
                        ],
                        const SizedBox(height: 16),
                        _Label(t: t, text: '配对码'),
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Expanded(
                              child: _field(
                                t: t,
                                controller: _codeCtl,
                                hint: '6 位数字',
                                icon: Icons.lock_outline,
                                keyboardType: TextInputType.number,
                              ),
                            ),
                            const SizedBox(width: 8),
                            IconButton(
                              onPressed: _busy ? null : _requestCode,
                              icon: const Icon(Icons.qr_code),
                              color: t.accent,
                              tooltip: '获取配对码',
                            ),
                          ],
                        ),
                        if (_pendingCode != null)
                          Padding(
                            padding: const EdgeInsets.only(top: 8),
                            child: Text(
                              '本次配对码：$_pendingCode（10 分钟内有效，需在主机上确认）',
                              style: TextStyle(
                                color: t.sub,
                                fontSize: 11,
                                fontFamily: t.fontMono,
                              ),
                            ),
                          ),
                        const SizedBox(height: 12),
                        _Label(t: t, text: '设备名'),
                        _field(
                          t: t,
                          controller: _nameCtl,
                          hint: 'my-phone',
                          icon: Icons.phone_iphone,
                        ),
                        const SizedBox(height: 16),
                        SizedBox(
                          width: double.infinity,
                          child: FilledButton.icon(
                            onPressed: _busy ? null : _pair,
                            icon: _busy
                                ? SizedBox(
                                    width: 16,
                                    height: 16,
                                    child: CircularProgressIndicator(strokeWidth: 2, color: t.accentForeground),
                                  )
                                : const Icon(Icons.link),
                            label: const Text('连接主机'),
                            style: FilledButton.styleFrom(
                              backgroundColor: t.accent,
                              foregroundColor: t.accentForeground,
                              padding: const EdgeInsets.symmetric(vertical: 14),
                            ),
                          ),
                        ),
                        const SizedBox(height: 10),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Icon(Icons.shield_outlined, size: 12, color: t.sub),
                            const SizedBox(width: 6),
                            Text(
                              conn.connected ? '已连接 · ${conn.deviceId?.substring(0, 8)}' : '全程 TLS · 配对码一次有效',
                              style: TextStyle(color: t.sub, fontSize: 11),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 16),
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: t.dangerBg,
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: t.danger, width: 0.5),
                      ),
                      child: Text(
                        _error!,
                        style: TextStyle(color: t.dangerFg, fontSize: 12),
                      ),
                    ),
                  ],
                ],
              ),
            ),
            Positioned(
              top: 8,
              right: 12,
              child: IconButton(
                icon: Icon(Icons.palette_outlined, color: t.sub),
                tooltip: '主题',
                onPressed: () => context.push('/theme'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _card({required PocketTheme t, required Widget child}) => Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: t.card,
          borderRadius: BorderRadius.circular(t.radius + 4),
          border: Border.all(color: t.border),
        ),
        child: child,
      );

  Widget _field({
    required PocketTheme t,
    required TextEditingController controller,
    required String hint,
    required IconData icon,
    TextInputType? keyboardType,
    ValueChanged<String>? onChanged,
    Widget? suffix,
  }) =>
      TextField(
        controller: controller,
        keyboardType: keyboardType,
        onChanged: onChanged,
        style: TextStyle(color: t.foreground, fontSize: 13),
        decoration: InputDecoration(
          hintText: hint,
          hintStyle: TextStyle(color: t.sub, fontSize: 13),
          prefixIcon: Icon(icon, color: t.sub, size: 18),
          suffixIcon: suffix,
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
          contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 13),
        ),
      );

  Widget _historyPanel(PocketTheme t) => Container(
        margin: const EdgeInsets.only(top: 6),
        decoration: BoxDecoration(
          color: t.inputFill,
          borderRadius: BorderRadius.circular(t.radius),
          border: Border.all(color: t.inputBorder),
        ),
        child: Column(
          children: [
            for (var i = 0; i < _hostHistory.length; i++) ...[
              if (i > 0) Divider(height: 1, color: t.border),
              InkWell(
                onTap: () {
                  _hostCtl.text = _hostHistory[i];
                  setState(() => _showHistory = false);
                },
                child: Padding(
                  padding: const EdgeInsets.only(left: 12, right: 4, top: 4, bottom: 4),
                  child: Row(
                    children: [
                      Icon(Icons.history, size: 15, color: t.sub),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          _hostHistory[i],
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: t.foreground,
                            fontSize: 13,
                            fontFamily: t.fontMono,
                          ),
                        ),
                      ),
                      IconButton(
                        icon: Icon(Icons.close, size: 16, color: t.sub),
                        tooltip: '删除',
                        visualDensity: VisualDensity.compact,
                        onPressed: () => _removeHost(_hostHistory[i]),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ],
        ),
      );

  Widget _chip(PocketTheme t, String label) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
        decoration: BoxDecoration(
          color: t.accent.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: t.accent.withValues(alpha: 0.45)),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: t.accent,
            fontSize: 12,
            fontWeight: FontWeight.w600,
            fontFamily: t.fontMono,
          ),
        ),
      );
}

class _Label extends StatelessWidget {
  final PocketTheme t;
  final String text;
  const _Label({required this.t, required this.text});
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
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
