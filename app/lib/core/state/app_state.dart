import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../api/client.dart';
import '../ws/client.dart';

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
  final bool connected;
  final String? error;
  PocketConnState({
    this.baseUrl,
    this.wsUrl,
    this.token,
    this.deviceId,
    this.connected = false,
    this.error,
  });
  PocketConnState copyWith({
    String? baseUrl,
    String? wsUrl,
    String? token,
    String? deviceId,
    bool? connected,
    String? error,
  }) =>
      PocketConnState(
        baseUrl: baseUrl ?? this.baseUrl,
        wsUrl: wsUrl ?? this.wsUrl,
        token: token ?? this.token,
        deviceId: deviceId ?? this.deviceId,
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
    if (baseUrl != null && token != null) {
      final wsUrl = baseUrl.replaceFirst(RegExp(r'^http'), 'ws');
      _ref.read(apiClientProvider.notifier).configure(baseUrl: baseUrl, token: token);
      final ws = WsClient(wsUrl: wsUrl, token: token);
      _ref.read(wsClientProvider.notifier).state = ws;
      await ws.connect();
      state = PocketConnState(
        baseUrl: baseUrl,
        wsUrl: wsUrl,
        token: token,
        deviceId: deviceId,
        connected: true,
      );
    }
  }

  Future<void> pairAndConnect({
    required String host,
    required String code,
    required String name,
  }) async {
    state = state.copyWith(error: null);
    final baseUrl = host.startsWith('http') ? host : 'https://$host';
    final tmp = ApiClient(baseUrl: baseUrl);
    try {
      final res = await tmp.pair(code, name);
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('baseUrl', baseUrl);
      await prefs.setString('token', res.token);
      await prefs.setString('deviceId', res.deviceId);
      final wsUrl = baseUrl.replaceFirst(RegExp(r'^http'), 'ws');
      _ref.read(apiClientProvider.notifier).configure(baseUrl: baseUrl, token: res.token);
      final ws = WsClient(wsUrl: wsUrl, token: res.token);
      _ref.read(wsClientProvider.notifier).state = ws;
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
    await _ref.read(wsClientProvider)?.close();
    _ref.read(wsClientProvider.notifier).state = null;
    _ref.read(apiClientProvider.notifier).state = null;
    state = PocketConnState();
  }
}
