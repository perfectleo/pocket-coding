import 'dart:async';
import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';

/// Interactive terminal view (M3 pty channel). Renders raw bytes from the
/// server's pty and forwards user keystrokes back. Dependency-injected via
/// callbacks/stream so it stays decoupled from WsClient (see ChatPage wiring).
class TerminalPage extends StatefulWidget {
  final String sessionId;
  final VoidCallback onOpen;
  final VoidCallback onClose;
  final ValueChanged<String> onInput;
  final void Function(int cols, int rows) onResize;
  final Stream<String> incoming; // term data bytes from server

  /// Optional slash command to auto-run once the interactive CLI has booted.
  /// Used to route chat's interactive-panel commands (/model, /memory, …) —
  /// which can't run over the non-interactive stream-json chat channel — into
  /// this real pty where they work. Injected as keystrokes after the TUI is up.
  final String? initialCommand;

  const TerminalPage({
    super.key,
    required this.sessionId,
    required this.onOpen,
    required this.onClose,
    required this.onInput,
    required this.onResize,
    required this.incoming,
    this.initialCommand,
  });

  @override
  State<TerminalPage> createState() => _TerminalPageState();
}

class _TerminalPageState extends State<TerminalPage> {
  late final Terminal _terminal;
  StreamSubscription<String>? _sub;
  bool _injected = false;

  @override
  void initState() {
    super.initState();
    _terminal = Terminal(maxLines: 10000);
    // User keystrokes → server pty stdin.
    _terminal.onOutput = (data) => widget.onInput(data);
    // Terminal geometry change → server pty resize (width/height are cols/rows).
    _terminal.onResize = (w, h, pw, ph) => widget.onResize(w, h);
    // Server pty stdout → render. Also drives auto-injection: the first byte
    // burst means the CLI's TUI is rendering, so we wait briefly for it to
    // settle then type the queued command + Enter, exactly once.
    _sub = widget.incoming.listen((data) {
      _terminal.write(data);
      _maybeInjectInitialCommand();
    });
    widget.onOpen();
  }

  void _maybeInjectInitialCommand() {
    final cmd = widget.initialCommand;
    if (_injected || cmd == null || cmd.isEmpty) return;
    _injected = true;
    // Give the interactive TUI time to finish its initial render before we
    // feed keystrokes, otherwise the input lands before the prompt is ready.
    Future.delayed(const Duration(milliseconds: 1400), () {
      widget.onInput('$cmd\r');
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    widget.onClose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('终端')),
      backgroundColor: Colors.black,
      body: SafeArea(
        child: TerminalView(_terminal),
      ),
    );
  }
}
