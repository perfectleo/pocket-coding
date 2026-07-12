import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../api/client.dart';
import '../ws/client.dart';

/// Normalize a user-entered host into a base URL with scheme.
/// - Inputs already carrying http:// or https:// are used as-is.
/// - Loopback / private addresses default to http (local dev).
/// - Everything else defaults to https (production).
String normalizeBaseUrl(String host) {
  final trimmed = host.trim();
  if (trimmed.isEmpty) return trimmed;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  final lower = trimmed.toLowerCase();
  final isLoopback = lower.startsWith('127.0.0.1') ||
      lower.startsWith('localhost') ||
      lower.startsWith('::1');
  final scheme = isLoopback ? 'http' : 'https';
  return '$scheme://$trimmed';
}

/// On Flutter Web, when the user types `localhost` but the page is served
/// from `127.0.0.1` (or vice versa), the browser treats WS as cross-origin
/// and silently drops the handshake. Resolve the WS host against the page
/// origin when the base URL is loopback.
String resolveWsUrl(String baseUrl) {
  if (!kIsWeb) return baseUrl.replaceFirst(RegExp(r'^http'), 'ws');
  try {
    final base = Uri.parse(baseUrl);
    final page = Uri.base;
    final isLoopback = base.host == 'localhost' ||
        base.host == '127.0.0.1' ||
        base.host == '::1';
    if (!isLoopback) return baseUrl.replaceFirst(RegExp(r'^http'), 'ws');
    // Prefer the page's host (avoids localhost↔127.0.0.1 mismatch).
    final host = (page.host.isNotEmpty &&
            (page.host == 'localhost' || page.host == '127.0.0.1'))
        ? page.host
        : base.host;
    return 'ws://$host:${base.port}';
  } catch (_) {
    return baseUrl.replaceFirst(RegExp(r'^http'), 'ws');
  }
}

final apiClientProvider = StateNotifierProvider<ApiClientNotifier, ApiClient?>((ref) {
  return ApiClientNotifier();
});

class ApiClientNotifier extends StateNotifier<ApiClient?> {
  ApiClientNotifier() : super(null);

  void configure({required String baseUrl, String? token}) {
    state = ApiClient(baseUrl: baseUrl, token: token);
  }

  void setToken(String token) {
    state?.token = token;
  }
}

final wsClientProvider = StateProvider<WsClient?>((ref) => null);

final connectionProvider = StateNotifierProvider<ConnectionNotifier, PocketConnState>((ref) {
  return ConnectionNotifier(ref);
});

class PocketConnState {
  final String? baseUrl;
  final String? wsUrl;
  final String? token;
  final String? deviceId;
  final String? lastSessionId;
  final bool connected;
  final String? error;
  PocketConnState({
    this.baseUrl,
    this.wsUrl,
    this.token,
    this.deviceId,
    this.lastSessionId,
    this.connected = false,
    this.error,
  });
  PocketConnState copyWith({
    String? baseUrl,
    String? wsUrl,
    String? token,
    String? deviceId,
    String? lastSessionId,
    bool? connected,
    String? error,
  }) =>
      PocketConnState(
        baseUrl: baseUrl ?? this.baseUrl,
        wsUrl: wsUrl ?? this.wsUrl,
        token: token ?? this.token,
        deviceId: deviceId ?? this.deviceId,
        lastSessionId: lastSessionId ?? this.lastSessionId,
        connected: connected ?? this.connected,
        error: error,
      );
}

class ConnectionNotifier extends StateNotifier<PocketConnState> {
  final Ref _ref;
  ConnectionNotifier(this._ref) : super(PocketConnState());

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    final baseUrl = prefs.getString('baseUrl');
    final token = prefs.getString('token');
    final deviceId = prefs.getString('deviceId');
    final lastSessionId = prefs.getString('lastSessionId');
    if (baseUrl != null && token != null) {
      final wsUrl = resolveWsUrl(baseUrl);
      _ref.read(apiClientProvider.notifier).configure(baseUrl: baseUrl, token: token);
      final ws = WsClient(wsUrl: wsUrl, token: token);
      _ref.read(wsClientProvider.notifier).state = ws;
      _watchAuth(ws);
      await ws.connect();
      state = PocketConnState(
        baseUrl: baseUrl,
        wsUrl: wsUrl,
        token: token,
        deviceId: deviceId,
        lastSessionId: lastSessionId,
        connected: true,
      );
    }
  }

  /// Listen for WS auth failures (server returned 401 on upgrade). When
  /// that fires, the stored token is no longer valid (server restarted
  /// with a new jwt secret, or token expired). Clear credentials so the
  /// router redirects to pairing on next build.
  void _watchAuth(WsClient ws) {
    ws.authFailures.listen((_) {
      // Fire-and-forget: disconnect clears prefs + providers and resets
      // state to disconnected, which the router picks up.
      disconnect();
    });
  }

  Future<void> setLastSession(String sessionId) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('lastSessionId', sessionId);
    state = state.copyWith(lastSessionId: sessionId);
  }

  Future<void> pairAndConnect({
    required String host,
    required String code,
    required String name,
  }) async {
    state = state.copyWith(error: null);
    final baseUrl = normalizeBaseUrl(host);
    final tmp = ApiClient(baseUrl: baseUrl);
    try {
      final res = await tmp.pair(code, name);
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('baseUrl', baseUrl);
      await prefs.setString('token', res.token);
      await prefs.setString('deviceId', res.deviceId);
      final wsUrl = resolveWsUrl(baseUrl);
      _ref.read(apiClientProvider.notifier).configure(baseUrl: baseUrl, token: res.token);
      final ws = WsClient(wsUrl: wsUrl, token: res.token);
      _ref.read(wsClientProvider.notifier).state = ws;
      _watchAuth(ws);
      await ws.connect();
      state = PocketConnState(
        baseUrl: baseUrl,
        wsUrl: wsUrl,
        token: res.token,
        deviceId: res.deviceId,
        connected: true,
      );
    } catch (e) {
      state = state.copyWith(error: e.toString());
      rethrow;
    }
  }

  Future<void> disconnect() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('baseUrl');
    await prefs.remove('token');
    await prefs.remove('deviceId');
    await prefs.remove('lastSessionId');
    await _ref.read(wsClientProvider)?.close();
    _ref.read(wsClientProvider.notifier).state = null;
    _ref.read(apiClientProvider.notifier).state = null;
    state = PocketConnState();
  }
}
