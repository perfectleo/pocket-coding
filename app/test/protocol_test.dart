import 'package:flutter_test/flutter_test.dart';
import 'package:app/core/protocol.dart';

void main() {
  group('SessionSummary.resumeCommand', () {
    SessionSummary make(String toolId, String? extId) => SessionSummary(
          id: 's1',
          projectId: 'proj',
          toolId: toolId,
          state: 'idle',
          lastSeq: 0,
          createdAt: 0,
          externalSessionId: extId,
        );

    test('claude', () {
      expect(make('claude-code', 'abc').resumeCommand(), 'claude --resume abc');
    });
    test('codex', () {
      expect(make('codex', 'abc').resumeCommand(), 'codex exec resume abc');
    });
    test('codebuddy', () {
      expect(make('codebuddy', 'abc').resumeCommand(), 'codebuddy --resume=abc');
    });
    test('null when no external id', () {
      expect(make('claude-code', null).resumeCommand(), isNull);
      expect(make('claude-code', '').resumeCommand(), isNull);
    });
  });

  group('permission mode cycling', () {
    test('cycles default -> plan -> acceptEdits -> bypassPermissions -> default', () {
      expect(nextPermissionMode('default'), 'plan');
      expect(nextPermissionMode('plan'), 'acceptEdits');
      expect(nextPermissionMode('acceptEdits'), 'bypassPermissions');
      expect(nextPermissionMode('bypassPermissions'), 'default');
    });
    test('unknown falls back to default', () {
      expect(nextPermissionMode('garbage'), 'default');
    });
  });

  group('json parsing', () {
    test('SessionSummary.fromJson maps externalSessionId + cwd', () {
      final s = SessionSummary.fromJson({
        'id': 's1',
        'projectId': 'p',
        'toolId': 'claude-code',
        'state': 'idle',
        'lastSeq': 3,
        'createdAt': 100,
        'externalSessionId': 'ext-1',
        'cwd': '/proj',
      });
      expect(s.externalSessionId, 'ext-1');
      expect(s.cwd, '/proj');
      expect(s.resumeCommand(), 'claude --resume ext-1');
    });

    test('MessageRecord.source defaults to app', () {
      final m = MessageRecord.fromJson({
        'id': 'm1',
        'sessionId': 's1',
        'seq': 0,
        'role': 'user',
        'type': 'text',
        'payload': {'text': 'hi'},
        'createdAt': 0,
      });
      expect(m.source, 'app');
    });

    test('MessageRecord.source honors external', () {
      final m = MessageRecord.fromJson({
        'id': 'm1',
        'sessionId': 's1',
        'seq': 0,
        'role': 'user',
        'type': 'text',
        'payload': {'text': 'hi'},
        'createdAt': 0,
        'source': 'external',
      });
      expect(m.source, 'external');
    });

    test('ServerMessage parses term data', () {
      final m = ServerMessage.fromJson({'seq': 0, 't': 'term', 'sessionId': 's1', 'data': 'abc'});
      expect(m.t, 'term');
      expect(m.data, 'abc');
    });

    test('ServerMessage parses term_exit code', () {
      final m = ServerMessage.fromJson({'seq': 0, 't': 'term_exit', 'sessionId': 's1', 'code': 0});
      expect(m.t, 'term_exit');
      expect(m.exitCode, 0);
    });

    test('HostSession.fromJson maps fields with defaults', () {
      final h = HostSession.fromJson({
        'toolId': 'codex',
        'externalSessionId': 'cx-1',
        'messageCount': 5,
        'summary': 'say hi',
      });
      expect(h.toolId, 'codex');
      expect(h.externalSessionId, 'cx-1');
      expect(h.messageCount, 5);
      expect(h.summary, 'say hi');
      expect(h.cwd, '');
      expect(h.imported, isFalse);
    });
  });
}
