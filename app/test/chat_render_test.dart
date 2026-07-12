// Verifies the App's _onMessage → ChatItem pipeline by feeding it real
// claude CLI stream-json fixtures (captured from actual `claude --output-format
// stream-json` runs). If this test passes, the App correctly renders the
// event sequences the backend actually produces.
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:app/core/protocol.dart';
import 'package:app/features/chat/chat_state.dart';

List<ServerMessage> loadFixture(String name) {
  final file = File('test/fixtures/$name');
  final lines = file.readAsLinesSync();
  final out = <ServerMessage>[];
  for (final line in lines) {
    if (line.trim().isEmpty) continue;
    final j = jsonDecode(line) as Map<String, dynamic>;
    // Mimic how the server's emitEvent wraps each AgentEvent.
    final type = j['type'] as String;
    if (type == 'system') continue; // adapter suppresses these
    if (type == 'assistant' || type == 'user') {
      final content = (j['message'] as Map<String, dynamic>)['content'] as List;
      for (final c in content) {
        final cm = c as Map<String, dynamic>;
        if (cm['type'] == 'text') {
          out.add(ServerMessage(seq: out.length + 1, t: 'event', sessionId: 's_test', event: AgentEvent(type: 'message', role: 'assistant', text: cm['text'] as String)));
        } else if (cm['type'] == 'tool_use') {
          out.add(ServerMessage(seq: out.length + 1, t: 'event', sessionId: 's_test', event: AgentEvent(type: 'tool_call', id: cm['id'] as String, name: cm['name'] as String, input: cm['input'])));
        } else if (cm['type'] == 'tool_result') {
          final raw = cm['content'];
          String output = '';
          if (raw is String) output = raw;
          else if (raw is List) output = raw.map((x) => x is String ? x : (x as Map)['text'] as String? ?? '').join();
          out.add(ServerMessage(seq: out.length + 1, t: 'event', sessionId: 's_test', event: AgentEvent(type: 'tool_result', id: cm['tool_use_id'] as String, output: output)));
        }
      }
    } else if (type == 'result') {
      final state = (j['subtype'] == 'error') ? 'error' : 'done';
      out.add(ServerMessage(seq: out.length + 1, t: 'event', sessionId: 's_test', event: AgentEvent(type: 'status', state: state)));
    }
  }
  return out;
}

void main() {
  test('plain-text fixture: produces one assistant message + done', () {
    final msgs = loadFixture('plain-text.jsonl');
    expect(msgs.length, greaterThanOrEqualTo(2));
    final assistantMsgs = msgs.where((m) => m.event?.type == 'message' && m.event?.role == 'assistant').toList();
    expect(assistantMsgs.length, 1);
    expect(assistantMsgs.first.event!.text, 'OK');
    expect(msgs.last.event?.type, 'status');
    expect(msgs.last.event?.state, 'done');
  });

  test('tool-bash fixture: text + tool_call + tool_result + text + done', () {
    final msgs = loadFixture('tool-bash.jsonl');
    final types = msgs.map((m) => m.event?.type).toList();
    expect(types, containsAll(['message', 'tool_call', 'tool_result', 'status']));
    final toolCalls = msgs.where((m) => m.event?.type == 'tool_call').toList();
    expect(toolCalls.length, 1);
    expect(toolCalls.first.event!.name, 'Bash');
    expect(toolCalls.first.event!.id, startsWith('call_'));
    final results = msgs.where((m) => m.event?.type == 'tool_result').toList();
    expect(results.length, 1);
    expect(results.first.event!.id, toolCalls.first.event!.id);
  });

  test('tool-write-read fixture: two tool_calls with matching results', () {
    final msgs = loadFixture('tool-write-read.jsonl');
    final toolCalls = msgs.where((m) => m.event?.type == 'tool_call').toList();
    expect(toolCalls.length, 2);
    expect(toolCalls[0].event!.name, 'Write');
    expect(toolCalls[1].event!.name, 'Read');
    final results = msgs.where((m) => m.event?.type == 'tool_result').toList();
    expect(results.length, 2);
    expect(results[0].event!.id, toolCalls[0].event!.id);
    expect(results[1].event!.id, toolCalls[1].event!.id);
  });

  test('ChatNotifier dedup + render: feed plain-text events', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final notifier = container.read(chatStateProvider('s_test').notifier);
    notifier.initForTest();
    final msgs = loadFixture('plain-text.jsonl');
    for (final m in msgs) {
      notifier.onMessageForTest(m);
    }
    final state = container.read(chatStateProvider('s_test'));
    expect(state.items.where((i) => i.kind == ChatItemKind.assistant).length, 1);
    expect(state.items.where((i) => i.kind == ChatItemKind.status).length, 1);
    expect(state.lastSeq, msgs.last.seq);
  });

  test('ChatNotifier: tool_call + tool_result attach correctly', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final notifier = container.read(chatStateProvider('s_test').notifier);
    notifier.initForTest();
    final msgs = loadFixture('tool-bash.jsonl');
    for (final m in msgs) {
      notifier.onMessageForTest(m);
    }
    final state = container.read(chatStateProvider('s_test'));
    final toolCallItem = state.items.firstWhere((i) => i.kind == ChatItemKind.toolCall);
    expect(toolCallItem.toolName, 'Bash');
    expect(toolCallItem.toolOutput, isNotNull); // result attached
    expect(toolCallItem.pending, false);
  });

  test('dedup: feeding same seq twice does not duplicate items', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final notifier = container.read(chatStateProvider('s_test').notifier);
    notifier.initForTest();
    final msgs = loadFixture('plain-text.jsonl');
    for (final m in msgs) {
      notifier.onMessageForTest(m);
    }
    final countBefore = container.read(chatStateProvider('s_test')).items.length;
    // Re-feed all messages.
    for (final m in msgs) {
      notifier.onMessageForTest(m);
    }
    final countAfter = container.read(chatStateProvider('s_test')).items.length;
    expect(countAfter, countBefore);
  });
}
