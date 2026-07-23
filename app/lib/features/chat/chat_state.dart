import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/protocol.dart';
import '../../core/state/app_state.dart';

/// A single chat entry rendered in the UI. May aggregate one or more server events.
class ChatItem {
  final String key;
  final String? turnId;
  final ChatItemKind kind;
  final String? text; // user / assistant / thinking text
  final String? toolCallId;
  final String? toolName;
  final dynamic toolInput;
  final bool? danger;
  final String? toolOutput;
  final String? statusState; // done / error / interrupt
  final bool pending;
  // For Write/Edit tools: rough +added/-removed parsed from tool_output or
  // patch. Null when not applicable. Used by the diff-link card to show
  // "+24 -3" affordance without a round-trip to the diff endpoint.
  final int? fileAdded;
  final int? fileRemoved;

  const ChatItem({
    required this.key,
    required this.kind,
    this.turnId,
    this.text,
    this.toolCallId,
    this.toolName,
    this.toolInput,
    this.danger,
    this.toolOutput,
    this.statusState,
    this.pending = false,
    this.fileAdded,
    this.fileRemoved,
  });

  ChatItem copyWith({
    String? text,
    String? toolOutput,
    bool? danger,
    String? statusState,
    bool? pending,
    int? fileAdded,
    int? fileRemoved,
  }) =>
      ChatItem(
        key: key,
        kind: kind,
        turnId: turnId,
        text: text ?? this.text,
        toolCallId: toolCallId,
        toolName: toolName,
        toolInput: toolInput,
        danger: danger ?? this.danger,
        toolOutput: toolOutput ?? this.toolOutput,
        statusState: statusState ?? this.statusState,
        pending: pending ?? this.pending,
        fileAdded: fileAdded ?? this.fileAdded,
        fileRemoved: fileRemoved ?? this.fileRemoved,
      );
}

enum ChatItemKind { user, assistant, thinking, toolCall, toolResult, status, raw }

class ChatState {
  final String sessionId;
  final int lastSeq;
  final String state; // running / waiting_approval / done / error / created
  final List<ChatItem> items;
  final bool attached;
  final String permissionMode; // current AI tool permission mode
  // Session metadata for the appbar title (project name + tool·model).
  // Fetched once during init() from the sessions list.
  final String? projectId;
  final String? toolId;
  final String? model;
  // The AI tool's own session id. Non-null only after the first turn (or a
  // desktop import) captured it. The pty terminal channel can only --resume
  // (share context) when this is set — the UI gates the terminal entry on it.
  final String? externalSessionId;
  const ChatState({
    required this.sessionId,
    required this.lastSeq,
    required this.state,
    required this.items,
    required this.attached,
    this.permissionMode = 'default',
    this.projectId,
    this.toolId,
    this.model,
    this.externalSessionId,
  });
  ChatState copyWith({
    int? lastSeq,
    String? state,
    List<ChatItem>? items,
    bool? attached,
    String? permissionMode,
    String? projectId,
    String? toolId,
    String? model,
    String? externalSessionId,
  }) =>
      ChatState(
        sessionId: sessionId,
        lastSeq: lastSeq ?? this.lastSeq,
        state: state ?? this.state,
        items: items ?? this.items,
        attached: attached ?? this.attached,
        permissionMode: permissionMode ?? this.permissionMode,
        projectId: projectId ?? this.projectId,
        toolId: toolId ?? this.toolId,
        model: model ?? this.model,
        externalSessionId: externalSessionId ?? this.externalSessionId,
      );
}

final chatStateProvider =
    StateNotifierProvider.family<ChatNotifier, ChatState, String>(
  (ref, sessionId) => ChatNotifier(ref, sessionId),
);

class ChatNotifier extends StateNotifier<ChatState> {
  final Ref _ref;
  final String sessionId;
  StreamSubscription<ServerMessage>? _sub;
  String? _currentTurnId;

  ChatNotifier(this._ref, this.sessionId)
      : super(ChatState(
          sessionId: sessionId,
          lastSeq: 0,
          state: 'created',
          items: const [],
          attached: false,
        ));

  /// Attach to the live WS stream and replay history first.
  Future<void> init() async {
    if (state.attached) return;
    final api = _ref.read(apiClientProvider);
    final ws = _ref.read(wsClientProvider);
    if (api == null || ws == null) return;

    // 1. Replay persisted history from REST.
    try {
      final history = await api.listMessages(sessionId);
      final items = <ChatItem>[];
      int maxSeq = 0;
      for (final m in history) {
        if (m.seq > maxSeq) maxSeq = m.seq;
        final item = _recordToItem(m);
        if (item != null) items.add(item);
      }
      // Merge tool_result rows into their matching tool_call so the UI
      // shows one card per tool invocation (command + output together),
      // matching the live stream behavior in _onMessage.
      final merged = _mergeToolResults(items);
      state = state.copyWith(items: merged, lastSeq: maxSeq);
    } catch (_) {}

    // 2. Fetch session metadata (projectId / toolId / model / permissionMode)
    // for the appbar + mode chip. Best-effort: the sessions list endpoint
    // returns these fields; if it fails we fall back to defaults.
    try {
      final sessions = await api.listSessions();
      final me = sessions.where((s) => s.id == sessionId).firstOrNull;
      if (me != null) {
        state = state.copyWith(
          projectId: me.projectId,
          toolId: me.toolId,
          model: me.model,
          permissionMode: me.permissionMode,
          externalSessionId: me.externalSessionId,
        );
      }
    } catch (_) {}

    // 3. Subscribe to live WS events.
    _sub = ws.events.where((m) => m.sessionId == sessionId || m.sessionId == null).listen(_onMessage);

    // 4. Attach with lastSeq so server replays any gap.
    ws.attach(sessionId, state.lastSeq);
    state = state.copyWith(attached: true);
  }

  /// Test-only: skip WS/REST, just mark attached so _onMessage works.
  void initForTest() {
    state = state.copyWith(attached: true);
  }

  /// Test-only: expose _onMessage for feeding fixture events.
  void onMessageForTest(ServerMessage msg) => _onMessage(msg);

  ChatItem? _recordToItem(MessageRecord m) {
    if (m.type == 'text' && m.role == 'user') {
      final t = (m.payload as Map<String, dynamic>?)?['text'] as String? ?? '';
      return ChatItem(key: 'u-${m.id}', kind: ChatItemKind.user, text: t, turnId: m.turnId);
    }
    if (m.type == 'message') {
      final t = (m.payload as Map<String, dynamic>?)?['text'] as String? ?? '';
      return ChatItem(key: 'a-${m.id}', kind: ChatItemKind.assistant, text: t, turnId: m.turnId);
    }
    if (m.type == 'thinking') {
      final t = (m.payload as Map<String, dynamic>?)?['text'] as String? ?? '';
      return ChatItem(key: 't-${m.id}', kind: ChatItemKind.thinking, text: t, turnId: m.turnId);
    }
    if (m.type == 'tool_call') {
      final p = m.payload as Map<String, dynamic>?;
      return ChatItem(
        key: 'tc-${m.id}',
        kind: ChatItemKind.toolCall,
        toolCallId: p?['id'] as String?,
        toolName: p?['name'] as String?,
        toolInput: p?['input'],
        danger: p?['danger'] as bool?,
        turnId: m.turnId,
      );
    }
    if (m.type == 'tool_result') {
      final p = m.payload as Map<String, dynamic>?;
      return ChatItem(
        key: 'tr-${m.id}',
        kind: ChatItemKind.toolResult,
        toolCallId: p?['id'] as String?,
        toolOutput: p?['output'] as String?,
        turnId: m.turnId,
      );
    }
    if (m.type == 'status') {
      final p = m.payload as Map<String, dynamic>?;
      final s = p?['state'] as String? ?? 'done';
      return ChatItem(key: 's-${m.id}', kind: ChatItemKind.status, statusState: s, turnId: m.turnId);
    }
    if (m.type == 'raw') {
      final p = m.payload as Map<String, dynamic>?;
      return ChatItem(key: 'r-${m.id}', kind: ChatItemKind.raw, text: p?['data'] as String?, turnId: m.turnId);
    }
    return null;
  }

  /// Fold tool_result rows into their preceding tool_call. Records come
  /// back from the REST endpoint as a flat list; the live WS stream already
  /// merges via _onMessage, so this mirrors that behavior for replay.
  List<ChatItem> _mergeToolResults(List<ChatItem> items) {
    final out = <ChatItem>[];
    for (final it in items) {
      if (it.kind == ChatItemKind.toolResult) {
        final idx = out.lastIndexWhere(
          (x) => x.kind == ChatItemKind.toolCall && x.toolCallId == it.toolCallId,
        );
        if (idx >= 0) {
          final output = it.toolOutput ?? '';
          out[idx] = out[idx].copyWith(
            toolOutput: output,
            pending: false,
            fileAdded: _countDiffLines(output, true),
            fileRemoved: _countDiffLines(output, false),
          );
          continue;
        }
      }
      out.add(it);
    }
    return out;
  }

  /// Count +/- lines in a unified-diff-style output. Returns null when the
  /// output doesn't look like a diff (no +/- prefixed lines). Used only as
  /// a display hint for Write/Edit cards; the authoritative diff comes
  /// from the /diff endpoint on tap.
  int? _countDiffLines(String output, bool added) {
    if (output.isEmpty) return null;
    final prefix = added ? '+' : '-';
    final skip = added ? '+++' : '---';
    var n = 0;
    for (final line in output.split('\n')) {
      if (line.startsWith(prefix) && !line.startsWith(skip)) n++;
    }
    return n > 0 ? n : null;
  }

  void _onMessage(ServerMessage msg) {
    if (msg.seq > 0 && msg.seq <= state.lastSeq) return; // dedup
    final newItems = List<ChatItem>.from(state.items);
    int newSeq = state.lastSeq;

    if (msg.t == 'event' && msg.event != null) {
      if (msg.seq > newSeq) newSeq = msg.seq;
      final ev = msg.event!;
      switch (ev.type) {
        case 'message':
          if (ev.role == 'assistant') {
            // If we were streaming deltas into a pending assistant item,
            // finalize it with the full text. Otherwise add a new item.
            final idx = newItems.lastIndexWhere(
              (it) =>
                  it.kind == ChatItemKind.assistant &&
                  it.pending &&
                  it.turnId == _currentTurnId,
            );
            if (idx >= 0) {
              newItems[idx] = newItems[idx].copyWith(
                text: ev.text ?? '',
                pending: false,
              );
            } else {
              newItems.add(ChatItem(
                key: 'a-${msg.seq}',
                kind: ChatItemKind.assistant,
                text: ev.text ?? '',
                turnId: _currentTurnId,
              ));
            }
          }
          break;
        case 'message_delta':
          if (ev.role == 'assistant') {
            final idx = newItems.lastIndexWhere(
              (it) =>
                  it.kind == ChatItemKind.assistant &&
                  it.pending &&
                  it.turnId == _currentTurnId,
            );
            if (idx >= 0) {
              newItems[idx] = newItems[idx].copyWith(
                text: (newItems[idx].text ?? '') + (ev.text ?? ''),
              );
            } else {
              newItems.add(ChatItem(
                key: 'a-${msg.seq}',
                kind: ChatItemKind.assistant,
                text: ev.text ?? '',
                turnId: _currentTurnId,
                pending: true,
              ));
            }
          }
          break;
        case 'thinking':
          final idx = newItems.lastIndexWhere(
            (it) =>
                it.kind == ChatItemKind.thinking &&
                it.pending &&
                it.turnId == _currentTurnId,
          );
          if (idx >= 0) {
            newItems[idx] = newItems[idx].copyWith(
              text: ev.text ?? '',
              pending: false,
            );
          } else {
            newItems.add(ChatItem(
              key: 't-${msg.seq}',
              kind: ChatItemKind.thinking,
              text: ev.text ?? '',
              turnId: _currentTurnId,
            ));
          }
          break;
        case 'thinking_delta':
          final tIdx = newItems.lastIndexWhere(
            (it) =>
                it.kind == ChatItemKind.thinking &&
                it.pending &&
                it.turnId == _currentTurnId,
          );
          if (tIdx >= 0) {
            newItems[tIdx] = newItems[tIdx].copyWith(
              text: (newItems[tIdx].text ?? '') + (ev.text ?? ''),
            );
          } else {
            newItems.add(ChatItem(
              key: 't-${msg.seq}',
              kind: ChatItemKind.thinking,
              text: ev.text ?? '',
              turnId: _currentTurnId,
              pending: true,
            ));
          }
          break;
        case 'tool_call':
          newItems.add(ChatItem(
            key: 'tc-${msg.seq}',
            kind: ChatItemKind.toolCall,
            toolCallId: ev.id,
            toolName: ev.name,
            toolInput: ev.input,
            danger: ev.danger,
            pending: true,
            turnId: _currentTurnId,
          ));
          break;
        case 'tool_result':
          // Attach to the matching tool_call item if still pending.
          final idx = newItems.lastIndexWhere(
            (it) => it.kind == ChatItemKind.toolCall && it.toolCallId == ev.id,
          );
          if (idx >= 0) {
            final output = ev.output ?? '';
            newItems[idx] = newItems[idx].copyWith(
              toolOutput: output,
              pending: false,
              fileAdded: _countDiffLines(output, true),
              fileRemoved: _countDiffLines(output, false),
            );
          } else {
            newItems.add(ChatItem(
              key: 'tr-${msg.seq}',
              kind: ChatItemKind.toolResult,
              toolCallId: ev.id,
              toolOutput: ev.output ?? '',
              turnId: _currentTurnId,
            ));
          }
          break;
        case 'status':
          newItems.add(ChatItem(
            key: 's-${msg.seq}',
            kind: ChatItemKind.status,
            statusState: ev.state ?? 'done',
            turnId: _currentTurnId,
          ));
          break;
        case 'mode':
          // AI tool reports its current permission mode (captured from the
          // tool's own init event, or echoed back from our request). Update
          // the mode chip — no chat bubble.
          state = state.copyWith(permissionMode: ev.mode ?? state.permissionMode);
          break;
        case 'raw':
          newItems.add(ChatItem(
            key: 'r-${msg.seq}',
            kind: ChatItemKind.raw,
            text: ev.data ?? '',
            turnId: _currentTurnId,
          ));
          break;
      }
    } else if (msg.t == 'status') {
      state = state.copyWith(state: msg.state ?? state.state);
      if (msg.seq > newSeq) newSeq = msg.seq;
    } else if (msg.t == 'mode') {
      state = state.copyWith(permissionMode: msg.mode ?? state.permissionMode);
      if (msg.seq > newSeq) newSeq = msg.seq;
    } else if (msg.t == 'checkpoint') {
      // Checkpoint creation — could surface a chip later. For now, no-op.
      if (msg.seq > newSeq) newSeq = msg.seq;
    }

    state = state.copyWith(items: newItems, lastSeq: newSeq);
  }

  void send(String text) {
    if (text.trim().isEmpty) return;
    final ws = _ref.read(wsClientProvider);
    if (ws == null) return;
    // Remember this session so the app reopens into it next launch.
    _ref.read(connectionProvider.notifier).setLastSession(sessionId);
    _currentTurnId = 'turn-${DateTime.now().millisecondsSinceEpoch}';
    // Optimistic user bubble.
    final items = List<ChatItem>.from(state.items);
    items.add(ChatItem(
      key: 'u-${DateTime.now().millisecondsSinceEpoch}',
      kind: ChatItemKind.user,
      text: text,
      turnId: _currentTurnId,
    ));
    state = state.copyWith(items: items, state: 'running');
    ws.input(sessionId, text);
  }

  void interrupt() {
    final ws = _ref.read(wsClientProvider);
    ws?.interrupt(sessionId);
  }

  /// Cycle the permission mode (shift+tab equivalent). Server applies the
  /// new mode on the next spawned process and echoes it back as a 'mode'
  /// event, which updates our chip.
  void cycleMode() {
    final ws = _ref.read(wsClientProvider);
    ws?.send({'t': 'mode', 'sessionId': sessionId});
  }

  /// Set the permission mode directly (user picked a specific mode from
  /// the menu). Server persists it to DB and echoes back as a 'mode' event.
  void setMode(String mode) {
    final ws = _ref.read(wsClientProvider);
    ws?.send({'t': 'mode', 'sessionId': sessionId, 'mode': mode});
  }

  void approve(String callId, bool approve) {
    final ws = _ref.read(wsClientProvider);
    ws?.send({'t': 'approve', 'sessionId': sessionId, 'callId': callId, 'approve': approve});
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }
}

/// All sessions list (refreshable).
final sessionsProvider = FutureProvider<List<SessionSummary>>((ref) async {
  final api = ref.watch(apiClientProvider);
  if (api == null) return [];
  return api.listSessions();
});
