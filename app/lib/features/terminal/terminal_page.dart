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

  const TerminalPage({
    super.key,
    required this.sessionId,
    required this.onOpen,
    required this.onClose,
    required this.onInput,
    required this.onResize,
    required this.incoming,
  });

  @override
  State<TerminalPage> createState() => _TerminalPageState();
}

class _TerminalPageState extends State<TerminalPage> {
  late final Terminal _terminal;
  StreamSubscription<String>? _sub;

  @override
  void initState() {
    super.initState();
    _terminal = Terminal(maxLines: 10000);
    // User keystrokes → server pty stdin.
    _terminal.onOutput = (data) => widget.onInput(data);
    // Terminal geometry change → server pty resize (width/height are cols/rows).
    _terminal.onResize = (w, h, pw, ph) => widget.onResize(w, h);
    // Server pty stdout → render.
    _sub = widget.incoming.listen(_terminal.write);
    widget.onOpen();
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
