import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/api/client.dart';
import '../../core/protocol.dart';
import '../../core/state/app_state.dart';

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

  @override
  void dispose() {
    _hostCtl.dispose();
    _codeCtl.dispose();
    _nameCtl.dispose();
    super.dispose();
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
    final baseUrl = host.startsWith('http') ? host : 'https://$host';
    try {
      final api = ApiClient(baseUrl: baseUrl);
      final code = await api.requestPairCode();
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
    final baseUrl = host.startsWith('http') ? host : 'https://$host';
    try {
      final api = ApiClient(baseUrl: baseUrl);
      final tools = await api.listTools();
      setState(() => _tools = tools);
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final conn = ref.watch(connectionProvider);
    return Scaffold(
      backgroundColor: const Color(0xFF060810),
      body: SafeArea(
        child: SingleChildScrollView(
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
                  color: const Color(0xFF22C55E),
                  borderRadius: BorderRadius.circular(18),
                ),
                alignment: Alignment.center,
                child: const Icon(Icons.terminal, color: Colors.black, size: 32),
              ),
              const Text(
                'Pocket Coding',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 24,
                  fontWeight: FontWeight.w700,
                  letterSpacing: -0.5,
                ),
              ),
              const SizedBox(height: 4),
              const Text(
                '// vibe code anywhere',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: Color(0xFF22C55E),
                  fontFamily: 'JetBrains Mono',
                  fontSize: 12,
                ),
              ),
              const SizedBox(height: 32),
              _card(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const _Label('云主机地址'),
                    _field(
                      controller: _hostCtl,
                      hint: 'box-42.example.com',
                      icon: Icons.cloud_outlined,
                      keyboardType: TextInputType.url,
                      onChanged: (_) => setState(() {}),
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton(
                            onPressed: _busy ? null : _probeTools,
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
                            .map((t) => _chip('${t.displayName} ${t.version ?? ''}'))
                            .toList(growable: false),
                      ),
                    ],
                    const SizedBox(height: 16),
                    const _Label('配对码'),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: _field(
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
                          color: const Color(0xFF22C55E),
                          tooltip: '获取配对码',
                        ),
                      ],
                    ),
                    if (_pendingCode != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Text(
                          '本次配对码：$_pendingCode（10 分钟内有效，需在主机上确认）',
                          style: const TextStyle(
                            color: Color(0xFF94A3B8),
                            fontSize: 11,
                            fontFamily: 'JetBrains Mono',
                          ),
                        ),
                      ),
                    const SizedBox(height: 12),
                    const _Label('设备名'),
                    _field(
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
                            ? const SizedBox(
                                width: 16,
                                height: 16,
                                child: CircularProgressIndicator(strokeWidth: 2),
                              )
                            : const Icon(Icons.link),
                        label: const Text('连接主机'),
                        style: FilledButton.styleFrom(
                          backgroundColor: const Color(0xFF22C55E),
                          foregroundColor: const Color(0xFF04140A),
                          padding: const EdgeInsets.symmetric(vertical: 14),
                        ),
                      ),
                    ),
                    const SizedBox(height: 10),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        const Icon(Icons.shield_outlined, size: 12, color: Color(0xFF94A3B8)),
                        const SizedBox(width: 6),
                        Text(
                          conn.connected ? '已连接 · ${conn.deviceId?.substring(0, 8)}' : '全程 TLS · 配对码一次有效',
                          style: const TextStyle(color: Color(0xFF94A3B8), fontSize: 11),
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
                    color: const Color(0x22EF4444),
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: const Color(0xFFEF4444), width: 0.5),
                  ),
                  child: Text(
                    _error!,
                    style: const TextStyle(color: Color(0xFFFCA5A5), fontSize: 12),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _card({required Widget child}) => Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: const Color(0xFF11131D),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: const Color(0xFF232636)),
        ),
        child: child,
      );

  Widget _field({
    required TextEditingController controller,
    required String hint,
    required IconData icon,
    TextInputType? keyboardType,
    ValueChanged<String>? onChanged,
  }) =>
      TextField(
        controller: controller,
        keyboardType: keyboardType,
        onChanged: onChanged,
        style: const TextStyle(color: Colors.white, fontSize: 13),
        decoration: InputDecoration(
          hintText: hint,
          hintStyle: const TextStyle(color: Color(0xFF64748B), fontSize: 13),
          prefixIcon: Icon(icon, color: const Color(0xFF94A3B8), size: 18),
          filled: true,
          fillColor: const Color(0xFF141B30),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: Color(0xFF243049)),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: Color(0xFF243049)),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: Color(0xFF22C55E)),
          ),
          contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 13),
        ),
      );

  Widget _chip(String label) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
        decoration: BoxDecoration(
          color: const Color(0x1F22C55E),
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: const Color(0x7322C55E)),
        ),
        child: Text(
          label,
          style: const TextStyle(
            color: Color(0xFF22C55E),
            fontSize: 12,
            fontWeight: FontWeight.w600,
            fontFamily: 'JetBrains Mono',
          ),
        ),
      );
}

class _Label extends StatelessWidget {
  final String text;
  const _Label(this.text);
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Text(
          text,
          style: const TextStyle(
            color: Color(0xFF94A3B8),
            fontSize: 11,
            fontWeight: FontWeight.w600,
            letterSpacing: 0.6,
          ),
        ),
      );
}
