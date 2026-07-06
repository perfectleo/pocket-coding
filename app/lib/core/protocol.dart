// Pocket Coding protocol — Dart mirror of server/src/protocol.ts.

class AgentEvent {
  final String type;
  final String? role;
  final String? text;
  final String? id;
  final String? name;
  final dynamic input;
  final bool? danger;
  final String? output;
  final String? file;
  final String? patch;
  final List<String>? steps;
  final String? state;
  final String? data;

  AgentEvent({
    required this.type,
    this.role,
    this.text,
    this.id,
    this.name,
    this.input,
    this.danger,
    this.output,
    this.file,
    this.patch,
    this.steps,
    this.state,
    this.data,
  });

  factory AgentEvent.fromJson(Map<String, dynamic> j) => AgentEvent(
        type: j['type'] as String,
        role: j['role'] as String?,
        text: j['text'] as String?,
        id: j['id'] as String?,
        name: j['name'] as String?,
        input: j['input'],
        danger: j['danger'] as bool?,
        output: j['output'] as String?,
        file: j['file'] as String?,
        patch: j['patch'] as String?,
        steps: (j['steps'] as List?)?.map((e) => e as String).toList(),
        state: j['state'] as String?,
        data: j['data'] as String?,
      );
}

class ServerMessage {
  final int seq;
  final String t;
  final String? sessionId;
  final AgentEvent? event;
  final String? state;
  final String? cpId;
  final String? kind;
  final String? previewState;
  final String? url;
  final String? message;

  ServerMessage({
    required this.seq,
    required this.t,
    this.sessionId,
    this.event,
    this.state,
    this.cpId,
    this.kind,
    this.previewState,
    this.url,
    this.message,
  });

  factory ServerMessage.fromJson(Map<String, dynamic> j) => ServerMessage(
        seq: j['seq'] as int,
        t: j['t'] as String,
        sessionId: j['sessionId'] as String?,
        event: j['event'] is Map<String, dynamic>
            ? AgentEvent.fromJson(j['event'] as Map<String, dynamic>)
            : null,
        state: j['state'] as String?,
        cpId: j['cpId'] as String?,
        kind: j['kind'] as String?,
        previewState: j['state'] as String?,
        url: j['url'] as String?,
        message: j['message'] as String?,
      );
}

class ToolInfo {
  final String id;
  final String displayName;
  final bool installed;
  final String? version;
  ToolInfo({required this.id, required this.displayName, required this.installed, this.version});
  factory ToolInfo.fromJson(Map<String, dynamic> j) => ToolInfo(
        id: j['id'] as String,
        displayName: j['displayName'] as String,
        installed: j['installed'] as bool,
        version: j['version'] as String?,
      );
}

class SessionSummary {
  final String id;
  final String projectId;
  final String toolId;
  final String? model;
  final String state;
  final int lastSeq;
  final int createdAt;
  final String? lastMessage;
  SessionSummary({
    required this.id,
    required this.projectId,
    required this.toolId,
    this.model,
    required this.state,
    required this.lastSeq,
    required this.createdAt,
    this.lastMessage,
  });
  factory SessionSummary.fromJson(Map<String, dynamic> j) => SessionSummary(
        id: j['id'] as String,
        projectId: j['projectId'] as String,
        toolId: j['toolId'] as String,
        model: j['model'] as String?,
        state: j['state'] as String,
        lastSeq: j['lastSeq'] as int,
        createdAt: j['createdAt'] as int,
        lastMessage: j['lastMessage'] as String?,
      );
}
