import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import '../protocol.dart';

enum WsStatus { disconnected, connecting, connected, error }

/// Emitted when the server rejects the WS upgrade with 401 (token invalid
/// or expired). The app should clear stored credentials and route the user
/// back to pairing instead of retrying forever.
class WsAuthFailure {}

class WsClient {
  final String wsUrl;
  final String token;
  WebSocketChannel? _ch;
  final StreamController<ServerMessage> _controller = StreamController.broadcast();
  final StreamController<WsStatus> _status = StreamController.broadcast();
  final StreamController<WsAuthFailure> _authFailures = StreamController.broadcast();
  int _failures = 0;
  bool _closed = false;
  bool _authFailed = false;
  Timer? _heartbeat;
  WsStatus _currentStatus = WsStatus.disconnected;

  WsClient({required this.wsUrl, required this.token});

  Stream<ServerMessage> get events => _controller.stream;
  Stream<WsStatus> get status => _status.stream;
  Stream<WsAuthFailure> get authFailures => _authFailures.stream;
  WsStatus get currentStatus => _currentStatus;

  void _setStatus(WsStatus s) {
    _currentStatus = s;
    _status.add(s);
  }

  Future<void> connect() async {
    if (_closed || _authFailed) return;
    _setStatus(WsStatus.connecting);
    final uri = Uri.parse('$wsUrl/ws?token=$token');
    try {
      _ch = WebSocketChannel.connect(uri);
      await _ch!.ready;
      _failures = 0;
      _setStatus(WsStatus.connected);
      _heartbeat?.cancel();
      _heartbeat = Timer.periodic(const Duration(seconds: 30), (_) => send({'t': 'ping'}));
      _ch!.stream.listen(
        (data) {
          try {
            final j = jsonDecode(data.toString()) as Map<String, dynamic>;
            _controller.add(ServerMessage.fromJson(j));
          } catch (e) {
            // Malformed server messages are dropped silently — the protocol
            // layer is responsible for shaping valid ServerMessage JSON.
            debugPrint('[ws] parse error: $e');
          }
        },
        onError: (e) {
          _setStatus(WsStatus.error);
          _scheduleReconnect();
        },
        onDone: _scheduleReconnect,
      );
    } catch (e) {
      // web_socket_channel surfaces a handshake 401 as an exception on
      // `ready`. The exact shape varies by platform (io vs web), so we
      // sniff the message for the 401 / unauthorized markers the server
      // sends with x-pocket-reason. If we see it, stop retrying and
      // emit an auth failure so the app can re-pair.
      final msg = e.toString();
      if (msg.contains('401') || msg.contains('Unauthorized') || msg.contains('invalid_token')) {
        _authFailed = true;
        _setStatus(WsStatus.error);
        _authFailures.add(WsAuthFailure());
        return;
      }
      _setStatus(WsStatus.error);
      _scheduleReconnect();
    }
  }

  void _scheduleReconnect() {
    if (_closed || _authFailed) return;
    _heartbeat?.cancel();
    _failures += 1;
    final delay = Duration(seconds: (1 << _failures.clamp(0, 5)).clamp(1, 30));
    Future.delayed(delay, connect);
  }

  void send(Map<String, dynamic> msg) {
    if (_ch == null) {
      _setStatus(WsStatus.error);
      return;
    }
    try {
      _ch!.sink.add(jsonEncode(msg));
    } catch (_) {
      _setStatus(WsStatus.error);
    }
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

  // ---- M3 pty terminal channel ----
  void termOpen(String sessionId) => send({'t': 'term_open', 'sessionId': sessionId});
  void termClose(String sessionId) => send({'t': 'term_close', 'sessionId': sessionId});
  void termData(String sessionId, String data) =>
      send({'t': 'term', 'sessionId': sessionId, 'data': data});
  void resize(String sessionId, int cols, int rows) =>
      send({'t': 'resize', 'sessionId': sessionId, 'cols': cols, 'rows': rows});

  Future<void> close() async {
    _closed = true;
    _heartbeat?.cancel();
    await _controller.close();
    await _status.close();
    await _authFailures.close();
    await _ch?.sink.close();
  }
}
