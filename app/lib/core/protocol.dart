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
  final String? mode;

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
    this.mode,
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
        mode: j['mode'] as String?,
      );
}

/// AI tool permission modes. claude/codebuddy accept these verbatim;
/// codex maps them onto --sandbox. Cycled via shift+tab equivalent in chat.
const permissionModes = <String>['default', 'plan', 'acceptEdits', 'bypassPermissions'];

String nextPermissionMode(String m) {
  final i = permissionModes.indexOf(m);
  if (i < 0) return 'default';
  return permissionModes[(i + 1) % permissionModes.length];
}

String permissionModeLabel(String m) {
  switch (m) {
    case 'plan':
      return 'Plan';
    case 'acceptEdits':
      return 'Accept Edits';
    case 'bypassPermissions':
      return 'Bypass';
    default:
      return 'Default';
  }
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
  final String? mode;

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
    this.mode,
  });

  factory ServerMessage.fromJson(Map<String, dynamic> j) => ServerMessage(
        seq: (j['seq'] as num?)?.toInt() ?? 0,
        t: j['t'] as String? ?? '',
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
        mode: j['mode'] as String?,
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
  final String permissionMode;
  final int lastSeq;
  final int createdAt;
  final String? lastMessage;
  SessionSummary({
    required this.id,
    required this.projectId,
    required this.toolId,
    this.model,
    required this.state,
    this.permissionMode = 'default',
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
        permissionMode: (j['permissionMode'] as String?) ?? 'default',
        lastSeq: j['lastSeq'] as int,
        createdAt: j['createdAt'] as int,
        lastMessage: j['lastMessage'] as String?,
      );
}

class MessageRecord {
  final String id;
  final String sessionId;
  final int seq;
  final String role;
  final String type;
  final dynamic payload;
  final String? turnId;
  final int createdAt;
  MessageRecord({
    required this.id,
    required this.sessionId,
    required this.seq,
    required this.role,
    required this.type,
    required this.payload,
    this.turnId,
    required this.createdAt,
  });
  factory MessageRecord.fromJson(Map<String, dynamic> j) => MessageRecord(
        id: j['id'] as String,
        sessionId: j['sessionId'] as String,
        seq: j['seq'] as int,
        role: j['role'] as String,
        type: j['type'] as String,
        payload: j['payload'],
        turnId: j['turnId'] as String?,
        createdAt: j['createdAt'] as int,
      );
}

class CheckpointRecord {
  final String id;
  final String sessionId;
  final String turnId;
  final String status;
  final String shadowCommit;
  final List<dynamic> files;
  final int createdAt;
  CheckpointRecord({
    required this.id,
    required this.sessionId,
    required this.turnId,
    required this.status,
    required this.shadowCommit,
    required this.files,
    required this.createdAt,
  });
  factory CheckpointRecord.fromJson(Map<String, dynamic> j) => CheckpointRecord(
        id: j['id'] as String,
        sessionId: j['sessionId'] as String,
        turnId: j['turnId'] as String,
        status: j['status'] as String,
        shadowCommit: j['shadowCommit'] as String,
        files: j['files'] as List? ?? const [],
        createdAt: j['createdAt'] as int,
      );
}

class DiffHunkLine {
  final String type; // add / del / ctx
  final int? oldNo;
  final int? newNo;
  final String text;
  const DiffHunkLine({required this.type, this.oldNo, this.newNo, required this.text});
  factory DiffHunkLine.fromJson(Map<String, dynamic> j) => DiffHunkLine(
        type: j['type'] as String,
        oldNo: j['oldNo'] as int?,
        newNo: j['newNo'] as int?,
        text: j['text'] as String,
      );
}

class DiffHunkBlock {
  final String header;
  final List<DiffHunkLine> lines;
  const DiffHunkBlock({required this.header, required this.lines});
  factory DiffHunkBlock.fromJson(Map<String, dynamic> j) => DiffHunkBlock(
        header: j['header'] as String,
        lines: (j['lines'] as List? ?? const [])
            .map((e) => DiffHunkLine.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

class DiffHunk {
  final String file;
  final List<DiffHunkBlock> hunks;
  final int added;
  final int removed;
  const DiffHunk({required this.file, required this.hunks, required this.added, required this.removed});
  factory DiffHunk.fromJson(Map<String, dynamic> j) => DiffHunk(
        file: j['file'] as String,
        hunks: (j['hunks'] as List? ?? const [])
            .map((e) => DiffHunkBlock.fromJson(e as Map<String, dynamic>))
            .toList(),
        added: j['added'] as int? ?? 0,
        removed: j['removed'] as int? ?? 0,
      );
}

class FileEntry {
  final String name;
  final String path;
  final bool dir;
  final int size;
  const FileEntry({required this.name, required this.path, required this.dir, required this.size});
  factory FileEntry.fromJson(Map<String, dynamic> j) => FileEntry(
        name: j['name'] as String,
        path: j['path'] as String,
        dir: j['dir'] as bool,
        size: j['size'] as int? ?? 0,
      );
}
