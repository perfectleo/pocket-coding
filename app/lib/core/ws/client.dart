import 'dart:async';
import 'dart:convert';
import 'package:web_socket_channel/web_socket_channel.dart';
import '../protocol.dart';

class WsClient {
  final String wsUrl;
  final String token;
  WebSocketChannel? _ch;
  final StreamController<ServerMessage> _controller = StreamController.broadcast();
  int _failures = 0;
  bool _closed = false;
  Timer? _heartbeat;

  WsClient({required this.wsUrl, required this.token});

  Stream<ServerMessage> get events => _controller.stream;

  Future<void> connect() async {
    if (_closed) return;
    final uri = Uri.parse('$wsUrl/ws?token=$token');
    try {
      _ch = WebSocketChannel.connect(uri);
      _failures = 0;
      _heartbeat?.cancel();
      _heartbeat = Timer.periodic(Duration(seconds: 30), (_) => send({'t': 'ping'}));
      _ch!.stream.listen(
        (data) {
          try {
            final j = jsonDecode(data.toString()) as Map<String, dynamic>;
            _controller.add(ServerMessage.fromJson(j));
          } catch (_) {}
        },
        onError: (e) => _scheduleReconnect(),
        onDone: _scheduleReconnect,
      );
    } catch (_) {
      _scheduleReconnect();
    }
  }

  void _scheduleReconnect() {
    if (_closed) return;
    _heartbeat?.cancel();
    _failures += 1;
    final delay = Duration(seconds: (1 << _failures.clamp(0, 5)).clamp(1, 30));
    Future.delayed(delay, connect);
  }

  void send(Map<String, dynamic> msg) {
    _ch?.sink.add(jsonEncode(msg));
  }

  void attach(String sessionId, int lastSeq) {
    send({'t': 'attach', 'sessionId': sessionId, 'lastSeq': lastSeq});
  }

  void input(String sessionId, String text) {
    send({'t': 'input', 'sessionId': sessionId, 'text': text});
  }

  void interrupt(String sessionId) {
    send({'t': 'interrupt', 'sessionId': sessionId});
  }

  Future<void> close() async {
    _closed = true;
    _heartbeat?.cancel();
    await _controller.close();
    await _ch?.sink.close();
  }
}
