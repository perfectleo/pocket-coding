import 'dart:convert';
import 'package:http/http.dart' as http;
import '../protocol.dart';

class ApiClient {
  String baseUrl;
  String? token;

  ApiClient({required this.baseUrl, this.token});

  Map<String, String> get _headers => {
        'content-type': 'application/json',
        if (token != null) 'authorization': 'Bearer $token',
      };

  Future<Map<String, dynamic>> get(String path) async {
    final r = await http.get(Uri.parse('$baseUrl$path'), headers: _headers);
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> post(String path, [Map<String, dynamic>? body]) async {
    final r = await http.post(
      Uri.parse('$baseUrl$path'),
      headers: _headers,
      body: body == null ? '{}' : jsonEncode(body),
    );
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  Future<String> requestPairCode() async {
    final j = await post('/api/pair/code');
    return j['code'] as String;
  }

  Future<({String token, String deviceId, int expiresAt})> pair(String code, String name) async {
    final j = await post('/api/pair', {'code': code, 'name': name});
    return (
      token: j['token'] as String,
      deviceId: j['deviceId'] as String,
      expiresAt: j['expiresAt'] as int,
    );
  }

  Future<List<ToolInfo>> listTools() async {
    final j = await get('/api/hosts/tools');
    final list = j['tools'] as List;
    return list.map((e) => ToolInfo.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<List<SessionSummary>> listSessions() async {
    final j = await get('/api/sessions');
    final list = j['sessions'] as List;
    return list.map((e) => SessionSummary.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<({String id, String state})> createSession({
    required String projectId,
    required String toolId,
    String? model,
    String? cwd,
  }) async {
    final j = await post('/api/sessions', {
      'projectId': projectId,
      'toolId': toolId,
      if (model != null) 'model': model,
      if (cwd != null) 'cwd': cwd,
    });
    return (id: j['id'] as String, state: j['state'] as String);
  }

  Future<void> interrupt(String sessionId) async {
    await post('/api/sessions/$sessionId/interrupt');
  }
}
