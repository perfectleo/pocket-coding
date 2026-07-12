import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:webview_flutter/webview_flutter.dart';
import '../../core/api/client.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/theme.dart';

enum DevicePreset { mobile, tablet, desktop }

extension DevicePresetW on DevicePreset {
  double get width => switch (this) {
        DevicePreset.mobile => 390,
        DevicePreset.tablet => 834,
        DevicePreset.desktop => 1280,
      };
  String get label => switch (this) {
        DevicePreset.mobile => '手机',
        DevicePreset.tablet => '平板',
        DevicePreset.desktop => '桌面',
      };
}

class PreviewPage extends ConsumerStatefulWidget {
  final String sessionId;
  const PreviewPage({super.key, required this.sessionId});

  @override
  ConsumerState<PreviewPage> createState() => _PreviewPageState();
}

class _PreviewPageState extends ConsumerState<PreviewPage> {
  PreviewStatus? _status;
  String? _proxyUrl;
  String _logs = '';
  bool _loading = false;
  String? _error;
  DevicePreset _device = DevicePreset.mobile;
  Timer? _poll;
  WebViewController? _ctrl;
  bool _logsExpanded = false;
  bool _picking = false;
  final List<String> _picked = [];

  @override
  void initState() {
    super.initState();
    _init();
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _init() async {
    await _refreshStatus();
    if (_status?.state == 'ready' && _proxyUrl == null) {
      _setProxyUrl(_status!);
    } else if (_status?.state != 'ready') {
      await _start();
    }
  }

  Future<void> _refreshStatus() async {
    final api = ref.read(apiClientProvider);
    if (api == null) return;
    try {
      final s = await api.previewStatus(widget.sessionId);
      setState(() {
        _status = s;
        _error = null;
      });
      _setProxyUrl(s);
    } catch (e) {
      setState(() => _error = '状态查询失败: $e');
    }
  }

  void _setProxyUrl(PreviewStatus s) {
    if (s.state == 'ready' && s.token != null) {
      final base = ref.read(apiClientProvider)?.baseUrl ?? '';
      final url = '$base/preview/${s.token}/';
      if (url != _proxyUrl) {
        setState(() {
          _proxyUrl = url;
          _ctrl = _buildController(url);
        });
      }
    } else if (s.state != 'ready') {
      if (_proxyUrl != null) {
        setState(() {
          _proxyUrl = null;
          _ctrl = null;
        });
      }
    }
  }

  WebViewController _buildController(String url) {
    final c = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFF000000))
      ..setNavigationDelegate(
        NavigationDelegate(
          onPageFinished: (_) => setState(() {}),
          onWebResourceError: (e) =>
              setState(() => _error = 'WebView: ${e.description}'),
        ),
      )
      ..addJavaScriptChannel(
        'pocketPick',
        onMessageReceived: (m) {
          setState(() => _picked.add(m.message));
        },
      )
      ..loadRequest(Uri.parse(url));
    return c;
  }

  Future<void> _start() async {
    final api = ref.read(apiClientProvider);
    if (api == null) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await api.startPreview(widget.sessionId);
      _poll?.cancel();
      _poll = Timer.periodic(const Duration(milliseconds: 600), (t) async {
        await _refreshStatus();
        if (_status?.state == 'ready' || _status?.state == 'error') {
          t.cancel();
          _poll = null;
        }
        if (_status?.state == 'ready') {
          await _refreshLogs();
        }
      });
    } catch (e) {
      setState(() => _error = '启动失败: $e');
    } finally {
      setState(() => _loading = false);
    }
  }

  Future<void> _stop() async {
    final api = ref.read(apiClientProvider);
    if (api == null) return;
    try {
      await api.stopPreview(widget.sessionId);
      setState(() {
        _proxyUrl = null;
        _ctrl = null;
      });
      await _refreshStatus();
    } catch (e) {
      setState(() => _error = '停止失败: $e');
    }
  }

  Future<void> _refreshLogs() async {
    final api = ref.read(apiClientProvider);
    if (api == null) return;
    try {
      final l = await api.previewLogs(widget.sessionId, tail: 500);
      setState(() => _logs = l);
    } catch (_) {}
  }

  Future<void> _restart() async {
    await _stop();
    await Future.delayed(const Duration(milliseconds: 300));
    await _start();
  }

  Future<void> _togglePick() async {
    if (!_picking) {
      setState(() {
        _picking = true;
        _picked.clear();
      });
      await _ctrl?.runJavaScript('''
(() => {
  const handler = (ev) => {
    const target = ev.target;
    const sel = (() => {
      if (target.id) return '#' + target.id;
      const path = [];
      let el = target;
      while (el && el.nodeType === 1 && path.length < 5) {
        let part = el.tagName.toLowerCase();
        if (el.className && typeof el.className === 'string') {
          part += '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.');
        }
        path.unshift(part);
        el = el.parentElement;
      }
      return path.join(' > ');
    })();
    try { window.pocketPick.postMessage(JSON.stringify({ sel, text: (target.innerText||'').slice(0,200) })); } catch(e){}
    ev.preventDefault();
    ev.stopPropagation();
  };
  document.addEventListener('click', handler, { capture: true, once: false });
  window.__pocketPickHandler = handler;
  document.body.style.outline = '2px dashed #ff5e3a';
})();
''');
    } else {
      await _ctrl?.runJavaScript('''
(() => {
  if (window.__pocketPickHandler) {
    document.removeEventListener('click', window.__pocketPickHandler, { capture: true });
    window.__pocketPickHandler = null;
  }
  document.body.style.outline = '';
})();
''');
      setState(() => _picking = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = ref.watch(themeProvider);
    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          icon: Icon(Icons.arrow_back, color: t.foreground),
          onPressed: () => context.pop(),
        ),
        title: Text('预览', style: TextStyle(color: t.foreground, fontSize: 16)),
        backgroundColor: t.background,
        actions: [
          if (_status?.state == 'ready')
            IconButton(
              icon: Icon(Icons.refresh, color: t.sub),
              tooltip: '重启 dev server',
              onPressed: _restart,
            ),
          if (_status?.state == 'ready')
            IconButton(
              icon: Icon(Icons.power_settings_new, color: t.danger),
              tooltip: '停止',
              onPressed: _stop,
            ),
        ],
      ),
      body: Column(
        children: [
          _statusBar(t),
          if (_proxyUrl != null && _ctrl != null)
            Expanded(
              child: _deviceFrame(t),
            )
          else
            Expanded(
              child: _placeholder(t),
            ),
          if (_status?.state == 'ready') _logsPanel(t),
        ],
      ),
    );
  }

  Widget _statusBar(PocketTheme t) {
    final state = _status?.state ?? 'stopped';
    final color = switch (state) {
      'ready' => Colors.green,
      'starting' => Colors.amber,
      'error' => t.danger,
      _ => t.sub,
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      color: t.cardAlt,
      child: Row(
        children: [
          Icon(Icons.circle, color: color, size: 10),
          const SizedBox(width: 8),
          Text(state, style: TextStyle(color: t.foreground, fontSize: 13)),
          if (_status?.port != null) ...[
            const SizedBox(width: 12),
            Text(':${_status!.port}',
                style: TextStyle(color: t.sub, fontSize: 12, fontFamily: t.fontMono)),
          ],
          const Spacer(),
          if (_proxyUrl != null)
            Flexible(
              child: Text(
                _proxyUrl!,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: t.sub, fontSize: 11, fontFamily: t.fontMono),
              ),
            ),
        ],
      ),
    );
  }

  Widget _deviceFrame(PocketTheme t) {
    final screenWidth = MediaQuery.of(context).size.width;
    final frameWidth = _device.width.clamp(0, screenWidth - 24).toDouble();
    return Center(
      child: Container(
        width: frameWidth,
        margin: const EdgeInsets.symmetric(vertical: 12),
        decoration: BoxDecoration(
          color: t.card,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: t.border),
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(
          children: [
            _toolbar(t),
            Expanded(child: WebViewWidget(controller: _ctrl!)),
          ],
        ),
      ),
    );
  }

  Widget _toolbar(PocketTheme t) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      decoration: BoxDecoration(
        color: t.cardAlt,
        border: Border(bottom: BorderSide(color: t.border)),
      ),
      child: Row(
        children: [
          ...DevicePreset.values.map((d) => Padding(
                padding: const EdgeInsets.only(right: 4),
                child: ChoiceChip(
                  label: Text(d.label, style: TextStyle(fontSize: 12)),
                  selected: _device == d,
                  onSelected: (_) => setState(() => _device = d),
                  visualDensity: VisualDensity.compact,
                ),
              )),
          const Spacer(),
          IconButton(
            icon: Icon(
              _picking ? Icons.touch_app : Icons.ads_click,
              color: _picking ? t.accent : t.sub,
              size: 18,
            ),
            tooltip: '选取元素',
            onPressed: _togglePick,
          ),
          IconButton(
            icon: Icon(Icons.refresh, color: t.sub, size: 18),
            tooltip: '刷新页面',
            onPressed: () => _ctrl?.reload(),
          ),
        ],
      ),
    );
  }

  Widget _placeholder(PocketTheme t) {
    if (_loading) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const CircularProgressIndicator(),
            const SizedBox(height: 12),
            Text('正在启动 dev server…', style: TextStyle(color: t.sub, fontSize: 13)),
          ],
        ),
      );
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.error_outline, color: t.danger, size: 48),
              const SizedBox(height: 12),
              Text(_error!, textAlign: TextAlign.center,
                  style: TextStyle(color: t.sub, fontSize: 13)),
              const SizedBox(height: 16),
              FilledButton.icon(
                onPressed: _start,
                icon: const Icon(Icons.play_arrow),
                label: const Text('重试'),
              ),
            ],
          ),
        ),
      );
    }
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.web, color: t.sub, size: 48),
          const SizedBox(height: 12),
          Text('未启动预览', style: TextStyle(color: t.sub, fontSize: 14)),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: _start,
            icon: const Icon(Icons.play_arrow),
            label: const Text('启动 dev server'),
          ),
        ],
      ),
    );
  }

  Widget _logsPanel(PocketTheme t) {
    return AnimatedContainer(
      duration: const Duration(milliseconds: 150),
      height: _logsExpanded ? 220 : 44,
      decoration: BoxDecoration(
        color: const Color(0xFF0B0E14),
        border: Border(top: BorderSide(color: t.border)),
      ),
      child: Column(
        children: [
          GestureDetector(
            onTap: () => setState(() => _logsExpanded = !_logsExpanded),
            onDoubleTap: _refreshLogs,
            child: Container(
              height: 44,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              color: Colors.transparent,
              child: Row(
                children: [
                  Icon(Icons.terminal, color: Colors.greenAccent, size: 16),
                  const SizedBox(width: 8),
                  Text('Console',
                      style: TextStyle(color: Colors.grey[400], fontSize: 12)),
                  const Spacer(),
                  if (_picked.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: Text('${_picked.length} picked',
                          style: const TextStyle(color: Colors.orangeAccent, fontSize: 11)),
                    ),
                  Icon(
                    _logsExpanded ? Icons.keyboard_arrow_down : Icons.keyboard_arrow_up,
                    color: Colors.grey[500],
                    size: 18,
                  ),
                ],
              ),
            ),
          ),
          if (_logsExpanded)
            Expanded(
              child: ListView(
                padding: const EdgeInsets.symmetric(horizontal: 10),
                children: [
                  if (_picked.isNotEmpty) ..._picked.map((p) => _pickedRow(p)),
                  SelectableText(
                    _logs.isEmpty ? '(no logs yet)' : _logs,
                    style: const TextStyle(
                      color: Color(0xFFB3B9C2),
                      fontSize: 11,
                      fontFamily: 'monospace',
                      height: 1.4,
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _pickedRow(String json) {
    return Container(
      margin: const EdgeInsets.only(top: 6, bottom: 4),
      padding: const EdgeInsets.all(6),
      decoration: BoxDecoration(
        color: const Color(0xFF2A1F12),
        borderRadius: BorderRadius.circular(4),
        border: Border.all(color: Colors.orangeAccent.withValues(alpha: 0.4)),
      ),
      child: SelectableText(
        json,
        style: const TextStyle(color: Colors.orangeAccent, fontSize: 11, fontFamily: 'monospace'),
      ),
    );
  }
}
