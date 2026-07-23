import 'dart:convert';
import 'package:http/http.dart' as http;
import '../protocol.dart';

class ApiException implements Exception {
  final int status;
  final String error;
  final String body;
  ApiException(this.status, this.error, this.body);
  @override
  String toString() => status == 401 ? '配对码无效或已过期' : 'HTTP $status: $error';
}

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
    return _decode(r);
  }

  Future<Map<String, dynamic>> post(String path, [Map<String, dynamic>? body]) async {
    final r = await http.post(
      Uri.parse('$baseUrl$path'),
      headers: _headers,
      body: body == null ? '{}' : jsonEncode(body),
    );
    return _decode(r);
  }

  Map<String, dynamic> _decode(http.Response r) {
    String errorText = '';
    try {
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      if (r.statusCode >= 400) {
        throw ApiException(r.statusCode, (j['error'] as String?) ?? '', r.body);
      }
      return j;
    } on FormatException {
      if (r.statusCode >= 400) throw ApiException(r.statusCode, errorText, r.body);
      rethrow;
    }
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

  Future<void> deleteSession(String sessionId) async {
    final r = await http.delete(Uri.parse('$baseUrl/api/sessions/$sessionId'), headers: _headers);
    if (r.statusCode != 200) {
      throw Exception('delete failed: ${r.statusCode} ${r.body}');
    }
  }

  /// Session detail — includes the ready-to-copy desktop resume command.
  Future<SessionDetail> getSession(String sessionId) async {
    final j = await get('/api/sessions/$sessionId');
    return SessionDetail.fromJson(j);
  }

  /// List conversations started from the desktop terminal (host scan).
  Future<List<HostSession>> listHostSessions({String? tool, String? cwd}) async {
    final q = <String>[];
    if (tool != null) q.add('tool=${Uri.encodeQueryComponent(tool)}');
    if (cwd != null) q.add('cwd=${Uri.encodeQueryComponent(cwd)}');
    final path = '/api/hosts/sessions${q.isEmpty ? '' : '?${q.join('&')}'}';
    final j = await get(path);
    final list = j['sessions'] as List? ?? const [];
    return list.map((e) => HostSession.fromJson(e as Map<String, dynamic>)).toList();
  }

  /// Import a desktop session into Pocket, backfilling its history. Returns
  /// the local session id to open.
  Future<({String id, int backfilled})> importHostSession({
    required String toolId,
    required String externalSessionId,
    required String cwd,
  }) async {
    final j = await post('/api/hosts/sessions/import', {
      'toolId': toolId,
      'externalSessionId': externalSessionId,
      'cwd': cwd,
    });
    return (id: j['id'] as String, backfilled: (j['backfilled'] as num?)?.toInt() ?? 0);
  }

  Future<String> workspaceRoot() async {
    final j = await get('/api/roots');
    return j['root'] as String;
  }

  Future<List<RootEntry>> browseRoots({String path = ''}) async {
    final j = await get('/api/roots/browse?path=${Uri.encodeQueryComponent(path)}');
    final list = j['entries'] as List? ?? const [];
    return list.map((e) => RootEntry.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<List<MessageRecord>> listMessages(String sessionId, {int afterSeq = -1}) async {
    final j = await get('/api/sessions/$sessionId/messages?after=$afterSeq');
    final list = j['messages'] as List;
    return list
        .map((e) => MessageRecord.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<List<CheckpointRecord>> listCheckpoints(String sessionId) async {
    final j = await get('/api/sessions/$sessionId/checkpoints');
    final list = j['checkpoints'] as List;
    return list
        .map((e) => CheckpointRecord.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<List<DiffHunk>> getDiff(String sessionId, {String? cpId, List<String>? files}) async {
    var path = '/api/sessions/$sessionId/diff';
    if (cpId != null) path += '/$cpId';
    final q = <String>[];
    if (files != null && files.isNotEmpty) q.add('files=${files.map(Uri.encodeQueryComponent).join(",")}');
    if (q.isNotEmpty) path += '?${q.join("&")}';
    final j = await get(path);
    final list = j['diff'] as List? ?? const [];
    return list.map((e) => DiffHunk.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<void> acceptCheckpoint(String sessionId, String cpId, {List<String>? files}) async {
    await post('/api/sessions/$sessionId/accept/$cpId', files == null ? null : {'files': files});
  }

  Future<void> rollbackCheckpoint(String sessionId, String cpId) async {
    await post('/api/sessions/$sessionId/rollback/$cpId');
  }

  Future<List<FileEntry>> listFiles(String sessionId, {String path = ''}) async {
    final j = await get('/api/sessions/$sessionId/files?path=${Uri.encodeQueryComponent(path)}');
    final list = j['entries'] as List? ?? const [];
    return list.map((e) => FileEntry.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<String> readFile(String sessionId, String path) async {
    final j = await get('/api/sessions/$sessionId/files/content?path=${Uri.encodeQueryComponent(path)}');
    return j['content'] as String? ?? '';
  }

  Future<void> interrupt(String sessionId) async {
    await post('/api/sessions/$sessionId/interrupt');
  }

  Future<PreviewHandle> startPreview(String sessionId) async {
    final j = await post('/api/sessions/$sessionId/preview/start');
    return PreviewHandle(
      token: j['token'] as String,
      state: j['state'] as String,
      url: j['url'] as String?,
    );
  }

  Future<void> stopPreview(String sessionId) async {
    await post('/api/sessions/$sessionId/preview/stop');
  }

  Future<PreviewStatus> previewStatus(String sessionId) async {
    final j = await get('/api/sessions/$sessionId/preview/status');
    return PreviewStatus(
      state: j['state'] as String,
      token: j['token'] as String?,
      port: j['port'] as int?,
      url: j['url'] as String?,
      startedAt: j['startedAt'] as int?,
    );
  }

  Future<String> previewLogs(String sessionId, {int tail = 500}) async {
    final j = await get('/api/sessions/$sessionId/preview/logs?tail=$tail');
    return j['logs'] as String? ?? '';
  }

  Future<void> registerPushToken({required String platform, required String token}) async {
    await post('/api/devices/push/register', {'platform': platform, 'token': token});
  }

  Future<void> unregisterPushToken(String token) async {
    await post('/api/devices/push/unregister', {'token': token});
  }
}

class PreviewHandle {
  final String token;
  final String state;
  final String? url;
  PreviewHandle({required this.token, required this.state, this.url});
}

class RootEntry {
  final String name;
  final String path;
  final bool dir;
  const RootEntry({required this.name, required this.path, required this.dir});
  factory RootEntry.fromJson(Map<String, dynamic> j) => RootEntry(
        name: j['name'] as String,
        path: j['path'] as String,
        dir: j['dir'] as bool? ?? true,
      );
}

class PreviewStatus {
  final String state;
  final String? token;
  final int? port;
  final String? url;
  final int? startedAt;
  PreviewStatus({
    required this.state,
    this.token,
    this.port,
    this.url,
    this.startedAt,
  });
}
