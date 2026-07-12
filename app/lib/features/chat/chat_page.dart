import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:speech_to_text/speech_to_text.dart';
import '../../core/protocol.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/theme.dart';
import '../../core/ws/client.dart';
import 'chat_state.dart';

class ChatPage extends ConsumerStatefulWidget {
  final String sessionId;
  const ChatPage({super.key, required this.sessionId});

  @override
  ConsumerState<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends ConsumerState<ChatPage> {
  final _scrollCtl = ScrollController();
  final _inputCtl = TextEditingController();
  bool _initialized = false;
  WsStatus? _wsStatus;

  @override
  void initState() {
    super.initState();
    final ws = ref.read(wsClientProvider);
    _wsStatus = ws?.currentStatus;
    ws?.status.listen((s) {
      if (mounted) setState(() => _wsStatus = s);
    });
  }

  @override
  void dispose() {
    _scrollCtl.dispose();
    _inputCtl.dispose();
    super.dispose();
  }

  void _ensureInit() {
    if (_initialized) return;
    _initialized = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(chatStateProvider(widget.sessionId).notifier).init();
    });
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollCtl.hasClients && _scrollCtl.position.maxScrollExtent > 0) {
        _scrollCtl.animateTo(
          _scrollCtl.position.maxScrollExtent,
          duration: const Duration(milliseconds: 180),
          curve: Curves.easeOut,
        );
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    _ensureInit();
    final t = ref.watch(themeProvider);
    final chat = ref.watch(chatStateProvider(widget.sessionId));
    final conn = ref.watch(connectionProvider);
    _scrollToBottom();
    final running = chat.state == 'running' || chat.state == 'waiting_approval';

    return Scaffold(
      backgroundColor: t.background,
      appBar: AppBar(
        backgroundColor: t.card,
        foregroundColor: t.foreground,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.go('/home'),
        ),
        title: Row(
          children: [
            Container(
              width: 8,
              height: 8,
              margin: const EdgeInsets.only(right: 8),
              decoration: BoxDecoration(
                color: _stateColor(chat.state, t),
                shape: BoxShape.circle,
              ),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    chat.projectId ?? _stateLabel(chat.state),
                    style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  if (_sessionSubtitle(chat) != null)
                    Text(
                      _sessionSubtitle(chat)!,
                      style: TextStyle(
                        fontSize: 10,
                        color: t.sub,
                        fontWeight: FontWeight.w400,
                        fontFamily: t.fontMono,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                ],
              ),
            ),
            if (_wsStatus != null && _wsStatus != WsStatus.connected)
              Container(
                margin: const EdgeInsets.only(left: 6),
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: (_wsStatus == WsStatus.connecting
                          ? Colors.amber
                          : t.danger)
                      .withValues(alpha: 0.18),
                  borderRadius: BorderRadius.circular(4),
                  border: Border.all(
                    color: (_wsStatus == WsStatus.connecting
                            ? Colors.amber
                            : t.danger)
                        .withValues(alpha: 0.6),
                  ),
                ),
                child: Text(
                  _wsStatus == WsStatus.connecting ? 'WS连接中' : 'WS断开',
                  style: TextStyle(
                    color: _wsStatus == WsStatus.connecting
                        ? Colors.amber
                        : t.danger,
                    fontSize: 9,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
          ],
        ),
        actions: [
          // Mode chip: tap to open a menu and pick a specific permission
          // mode. Long-press cycles (shift+tab equivalent) for quick toggling
          // without opening the menu. Label reflects the AI tool's current
          // mode, surfaced from the tool's own init event or echoed from
          // our request.
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
            child: PopupMenuButton<String>(
              tooltip: '权限模式',
              color: t.card,
              position: PopupMenuPosition.under,
              onSelected: (v) {
                if (v != chat.permissionMode) {
                  ref.read(chatStateProvider(widget.sessionId).notifier).setMode(v);
                }
              },
              itemBuilder: (ctx) => [
                for (final m in permissionModes)
                  PopupMenuItem<String>(
                    value: m,
                    child: Row(
                      children: [
                        Icon(_modeIcon(m), size: 16,
                            color: m == chat.permissionMode
                                ? _modeColor(m, t)
                                : t.sub),
                        const SizedBox(width: 8),
                        Text(permissionModeLabel(m),
                          style: TextStyle(
                            color: m == chat.permissionMode
                                ? _modeColor(m, t)
                                : t.foreground,
                            fontSize: 13,
                            fontWeight: m == chat.permissionMode
                                ? FontWeight.w600
                                : FontWeight.w400,
                          )),
                        const Spacer(),
                        if (m == chat.permissionMode)
                          Icon(Icons.check, size: 16, color: _modeColor(m, t)),
                      ],
                    ),
                  ),
              ],
              child: InkWell(
                borderRadius: BorderRadius.circular(t.radius),
                onLongPress: () => ref
                    .read(chatStateProvider(widget.sessionId).notifier)
                    .cycleMode(),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: t.cardAlt,
                    borderRadius: BorderRadius.circular(t.radius),
                    border: Border.all(color: t.border, width: 0.5),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(_modeIcon(chat.permissionMode),
                          size: 14, color: _modeColor(chat.permissionMode, t)),
                      const SizedBox(width: 6),
                      Text(
                        permissionModeLabel(chat.permissionMode),
                        style: TextStyle(
                          color: _modeColor(chat.permissionMode, t),
                          fontSize: 11,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(width: 4),
                      Icon(Icons.arrow_drop_down, size: 14, color: t.sub),
                    ],
                  ),
                ),
              ),
            ),
          ),
          if (running)
            IconButton(
              icon: Icon(Icons.stop_circle_outlined, color: t.danger),
              tooltip: '中断',
              onPressed: () => ref.read(chatStateProvider(widget.sessionId).notifier).interrupt(),
            ),
          PopupMenuButton<String>(
            icon: Icon(Icons.more_vert, color: t.sub),
            color: t.card,
            onSelected: (v) {
              switch (v) {
                case 'diff':
                  context.push('/diff/${widget.sessionId}');
                case 'files':
                  context.push('/files/${widget.sessionId}');
                case 'preview':
                  context.push('/preview/${widget.sessionId}');
                case 'theme':
                  context.push('/theme');
              }
            },
            itemBuilder: (ctx) => [
              PopupMenuItem<String>(
                value: 'diff',
                child: Row(children: [
                  Icon(Icons.difference_outlined, color: t.sub, size: 18),
                  const SizedBox(width: 8),
                  const Text('Diff'),
                ]),
              ),
              PopupMenuItem<String>(
                value: 'files',
                child: Row(children: [
                  Icon(Icons.folder_outlined, color: t.sub, size: 18),
                  const SizedBox(width: 8),
                  const Text('文件'),
                ]),
              ),
              PopupMenuItem<String>(
                value: 'preview',
                child: Row(children: [
                  Icon(Icons.web_outlined, color: t.sub, size: 18),
                  const SizedBox(width: 8),
                  const Text('预览'),
                ]),
              ),
              const PopupMenuDivider(),
              PopupMenuItem<String>(
                value: 'theme',
                child: Row(children: [
                  Icon(Icons.palette_outlined, color: t.sub, size: 18),
                  const SizedBox(width: 8),
                  const Text('主题'),
                ]),
              ),
            ],
          ),
        ],
      ),
      body: !conn.connected
          ? Center(child: Text('未连接', style: TextStyle(color: t.sub)))
          : Column(
              children: [
                if (_wsStatus != null && _wsStatus != WsStatus.connected)
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                    color: (_wsStatus == WsStatus.connecting
                            ? Colors.amber
                            : t.danger)
                        .withValues(alpha: 0.15),
                    child: Text(
                      'WS: ${_wsStatus == WsStatus.connecting ? '连接中' : _wsStatus == WsStatus.error ? '错误' : '断开'}  ${conn.wsUrl ?? ''}',
                      style: TextStyle(
                        color: _wsStatus == WsStatus.connecting
                            ? Colors.amber[800]
                            : t.danger,
                        fontSize: 11,
                        fontFamily: t.fontMono,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                Expanded(
                  child: chat.items.isEmpty
                      ? _EmptyState(t: t)
                      : ListView.builder(
                          controller: _scrollCtl,
                          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                          itemCount: chat.items.length,
                          itemBuilder: (context, i) => _ChatItemView(
                            item: chat.items[i],
                            theme: t,
                            sessionId: widget.sessionId,
                            onApprove: (callId, approve) => ref
                                .read(chatStateProvider(widget.sessionId).notifier)
                                .approve(callId, approve),
                          ),
                        ),
                ),
                _InputBar(
                  t: t,
                  controller: _inputCtl,
                  running: running,
                  onSend: (text) {
                    ref.read(chatStateProvider(widget.sessionId).notifier).send(text);
                    _inputCtl.clear();
                  },
                  onInterrupt: () => ref.read(chatStateProvider(widget.sessionId).notifier).interrupt(),
                ),
              ],
            ),
    );
  }

  Color _stateColor(String state, PocketTheme t) {
    switch (state) {
      case 'running':
        return t.accent;
      case 'waiting_approval':
        return const Color(0xFFF59E0B);
      case 'done':
        return t.sub;
      case 'error':
        return t.danger;
      default:
        return t.sub.withValues(alpha: 0.5);
    }
  }

  String _stateLabel(String state) {
    switch (state) {
      case 'running':
        return '运行中';
      case 'waiting_approval':
        return '等待审批';
      case 'done':
        return '会话';
      case 'error':
        return '出错';
      default:
        return '会话';
    }
  }

  /// Appbar subtitle: "Claude Code · sonnet" style. Falls back to null
  /// (no subtitle) when we don't have tool/model info yet.
  String? _sessionSubtitle(ChatState chat) {
    final tool = _toolDisplayName(chat.toolId);
    final model = chat.model;
    if (tool == null && model == null) return null;
    if (tool == null) return model;
    if (model == null) return tool;
    return '$tool · $model';
  }

  static String? _toolDisplayName(String? id) {
    switch (id) {
      case 'claude-code':
        return 'Claude Code';
      case 'codex':
        return 'Codex';
      case 'codebuddy':
        return 'CodeBuddy';
      default:
        return null;
    }
  }
}

IconData _modeIcon(String mode) {
  switch (mode) {
    case 'plan':
      return Icons.list_alt;
    case 'acceptEdits':
      return Icons.edit_outlined;
    case 'bypassPermissions':
      return Icons.bolt_outlined;
    default:
      return Icons.shield_outlined;
  }
}

Color _modeColor(String mode, PocketTheme t) {
  switch (mode) {
    case 'plan':
      return const Color(0xFF6366F1);
    case 'acceptEdits':
      return const Color(0xFFF59E0B);
    case 'bypassPermissions':
      return t.danger;
    default:
      return t.sub;
  }
}

class _EmptyState extends StatelessWidget {
  final PocketTheme t;
  const _EmptyState({required this.t});
  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.terminal_outlined, color: t.sub, size: 48),
              const SizedBox(height: 12),
              Text(
                '发条消息开始\n试试 "加个 README"',
                textAlign: TextAlign.center,
                style: TextStyle(color: t.sub, fontSize: 13, height: 1.6),
              ),
            ],
          ),
        ),
      );
}

class _ChatItemView extends StatelessWidget {
  final ChatItem item;
  final PocketTheme theme;
  final String sessionId;
  final void Function(String callId, bool approve) onApprove;
  const _ChatItemView({required this.item, required this.theme, required this.sessionId, required this.onApprove});

  @override
  Widget build(BuildContext context) {
    switch (item.kind) {
      case ChatItemKind.user:
        return _UserBubble(text: item.text ?? '', t: theme);
      case ChatItemKind.assistant:
        return _AssistantCard(text: item.text ?? '', pending: item.pending, t: theme);
      case ChatItemKind.thinking:
        return _ThinkingCard(text: item.text ?? '', pending: item.pending, t: theme);
      case ChatItemKind.toolCall:
        return _ToolCallCard(item: item, t: theme, sessionId: sessionId, onApprove: onApprove);
      case ChatItemKind.toolResult:
        // tool_result should always be merged into its tool_call by
        // chat_state (_onMessage or _mergeToolResults). If we get here,
        // it's an orphan result with no matching call — show it as raw
        // output rather than a separate tappable card.
        return _RawCard(data: item.toolOutput ?? '', t: theme);
      case ChatItemKind.status:
        // Don't render the "done" status card — the user said chat shouldn't
        // show "已完成"; the input button already recovers to idle when the
        // turn finishes. Keep error/interrupt cards so failures surface.
        if (item.statusState == 'done') return const SizedBox.shrink();
        return _StatusCard(state: item.statusState ?? 'done', t: theme);
      case ChatItemKind.raw:
        return _RawCard(data: item.text ?? '', t: theme);
    }
  }
}

class _UserBubble extends StatelessWidget {
  final String text;
  final PocketTheme t;
  const _UserBubble({required this.text, required this.t});
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(left: 48, bottom: 10),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            Flexible(
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                decoration: BoxDecoration(
                  color: t.accent,
                  borderRadius: BorderRadius.only(
                    topLeft: Radius.circular(t.radius + 2),
                    topRight: Radius.circular(t.radius + 2),
                    bottomLeft: Radius.circular(t.radius + 2),
                    bottomRight: Radius.circular(4),
                  ),
                ),
                child: Text(text, style: TextStyle(color: t.accentForeground, fontSize: 14, height: 1.4)),
              ),
            ),
          ],
        ),
      );
}

class _AssistantCard extends StatelessWidget {
  final String text;
  final bool pending; // true while streaming deltas are accumulating
  final PocketTheme t;
  const _AssistantCard({required this.text, required this.pending, required this.t});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(right: 32, bottom: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // AI avatar — gives assistant messages a clear visual anchor
          // and distinguishes them from tool/thinking cards.
          Container(
            width: 26,
            height: 26,
            margin: const EdgeInsets.only(top: 2, right: 10),
            decoration: BoxDecoration(
              color: t.accent.withValues(alpha: 0.14),
              borderRadius: BorderRadius.circular(7),
              border: Border.all(color: t.accent.withValues(alpha: 0.5), width: 0.8),
            ),
            child: Icon(Icons.auto_awesome, size: 14, color: t.accent),
          ),
          Expanded(
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              decoration: BoxDecoration(
                color: t.card,
                borderRadius: BorderRadius.circular(t.radius),
                border: Border.all(color: t.border, width: 0.5),
              ),
              child: _streamingBody(context),
            ),
          ),
        ],
      ),
    );
  }

  Widget _streamingBody(BuildContext context) {
    if (text.isEmpty && pending) {
      // Turn just started, no text yet — show a subtle pulsing dot instead
      // of an empty bubble so the user sees the assistant is "thinking".
      return _TypingDots(t: t);
    }
    // While streaming, render as plain SelectableText. MarkdownBody re-parses
    // the full document on every delta — for a 300-word response that's 300+
    // parses, each taking 10-50ms, which blocks the UI thread and makes
    // deltas appear to batch. Plain text append is O(n) and stays smooth.
    // Once the turn finalizes (pending=false), switch to MarkdownBody for
    // rich rendering (code blocks, bold, lists, etc).
    if (pending) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          SelectableText(
            text,
            style: TextStyle(color: t.foreground, fontSize: 14, height: 1.5),
          ),
          const SizedBox(height: 2),
          _BlinkingCursor(t: t),
        ],
      );
    }
    return MarkdownBody(
      data: text,
      selectable: true,
      styleSheet: MarkdownStyleSheet(
        p: TextStyle(color: t.foreground, fontSize: 14, height: 1.5),
        code: TextStyle(
          color: t.accent,
          fontFamily: t.fontMono,
          fontSize: 12,
        ),
        codeblockDecoration: BoxDecoration(
          color: t.cardAlt,
          borderRadius: BorderRadius.circular(t.radius - 2),
          border: Border.all(color: t.border, width: 0.5),
        ),
        codeblockPadding: const EdgeInsets.all(10),
      ),
    );
  }
}

class _TypingDots extends StatefulWidget {
  final PocketTheme t;
  const _TypingDots({required this.t});
  @override
  State<_TypingDots> createState() => _TypingDotsState();
}

class _TypingDotsState extends State<_TypingDots> with TickerProviderStateMixin {
  late final AnimationController _ctl;
  @override
  void initState() {
    super.initState();
    _ctl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 900),
    )..repeat();
  }
  @override
  void dispose() {
    _ctl.dispose();
    super.dispose();
  }
  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: List.generate(3, (i) {
        return AnimatedBuilder(
          animation: _ctl,
          builder: (_, __) {
            // Stagger the three dots so they ripple.
            final phase = (_ctl.value + i * 0.33) % 1.0;
            final scale = 0.6 + 0.4 * (0.5 - (phase - 0.5).abs() * 2).abs();
            return Container(
              margin: const EdgeInsets.only(right: 4),
              width: 5,
              height: 5,
              decoration: BoxDecoration(
                color: widget.t.accent.withValues(alpha: 0.4 + 0.5 * scale),
                shape: BoxShape.circle,
              ),
            );
          },
        );
      }),
    );
  }
}

/// Blinking block cursor shown at the tail of a streaming assistant
/// message. Toggles opacity on a ~530ms cadence (terminal-style).
class _BlinkingCursor extends StatefulWidget {
  final PocketTheme t;
  const _BlinkingCursor({required this.t});
  @override
  State<_BlinkingCursor> createState() => _BlinkingCursorState();
}

class _BlinkingCursorState extends State<_BlinkingCursor>
    with TickerProviderStateMixin {
  late final AnimationController _ctl;
  @override
  void initState() {
    super.initState();
    _ctl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 530),
    )..repeat(reverse: true);
  }
  @override
  void dispose() {
    _ctl.dispose();
    super.dispose();
  }
  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _ctl,
      builder: (_, __) => Container(
        width: 7,
        height: 14,
        decoration: BoxDecoration(
          color: widget.t.accent.withValues(alpha: 0.3 + 0.5 * _ctl.value),
          borderRadius: BorderRadius.circular(1),
        ),
      ),
    );
  }
}

class _ThinkingCard extends StatefulWidget {
  final String text;
  final bool pending; // true while thinking_delta is still streaming
  final PocketTheme t;
  const _ThinkingCard({required this.text, required this.pending, required this.t});
  @override
  State<_ThinkingCard> createState() => _ThinkingCardState();
}

class _ThinkingCardState extends State<_ThinkingCard> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final t = widget.t;
    // While streaming, auto-expand so the user sees reasoning arrive. Once
    // the turn finishes (pending=false), collapse to a single-line summary
    // so it doesn't dominate the chat — matches the vscode plugin's pattern
    // of hiding reasoning behind a toggle by default.
    final showFull = _expanded || widget.pending;
    final preview = widget.text.split('\n').first;
    return Padding(
      padding: const EdgeInsets.only(right: 32, bottom: 6),
      child: InkWell(
        borderRadius: BorderRadius.circular(t.radius - 2),
        onTap: () => setState(() => _expanded = !_expanded),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
          decoration: BoxDecoration(
            color: t.cardAlt.withValues(alpha: 0.4),
            borderRadius: BorderRadius.circular(t.radius - 2),
            border: Border.all(color: t.border.withValues(alpha: 0.6), width: 0.5),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                widget.pending ? Icons.psychology : Icons.psychology_outlined,
                color: t.sub,
                size: 13,
              ),
              const SizedBox(width: 6),
              Expanded(
                child: showFull
                    ? Text(
                        widget.text,
                        style: TextStyle(
                          color: t.sub,
                          fontSize: 12,
                          fontFamily: t.fontMono,
                          height: 1.45,
                        ),
                      )
                    : Text(
                        preview.isEmpty ? '思考过程' : preview,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: t.sub,
                          fontSize: 12,
                          fontFamily: t.fontMono,
                        ),
                      ),
              ),
              Icon(
                showFull ? Icons.expand_less : Icons.expand_more,
                color: t.sub,
                size: 16,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Tool-call card. Dispatches to a specialized layout per tool family so
/// each tool gets the affordance the user expects (Read → file row,
/// Write/Edit → diff link, Bash → command + approval, etc.). All three
/// adapters (claude/codebuddy/codex) produce tool_call events with a
/// `name` and `input` object; the dispatch is purely on `name`, so new
/// tools only need to add a case here.
class _ToolCallCard extends StatefulWidget {
  final ChatItem item;
  final PocketTheme t;
  final String sessionId;
  final void Function(String callId, bool approve) onApprove;
  const _ToolCallCard({required this.item, required this.t, required this.sessionId, required this.onApprove});

  @override
  State<_ToolCallCard> createState() => _ToolCallCardState();
}

class _ToolCallCardState extends State<_ToolCallCard> {
  bool _expanded = false;
  bool? _decision;

  void _decide(bool approve) {
    if (_decision != null || !widget.item.pending) return;
    HapticFeedback.mediumImpact();
    setState(() => _decision = approve);
    widget.onApprove(widget.item.toolCallId ?? '', approve);
  }

  @override
  Widget build(BuildContext context) {
    final item = widget.item;
    final t = widget.t;
    final name = (item.toolName ?? 'tool').toLowerCase();
    // Danger (rm -rf etc.) wraps the card in a swipe-to-approve Dismissible,
    // regardless of tool family — the approval gate is orthogonal to layout.
    final danger = item.danger == true;
    final canSwipe = danger && item.pending && _decision == null;

    Widget card;
    // Normalize tool names across adapters. claude/codebuddy use PascalCase
    // (Read, Write, Edit, Bash, Glob, Grep, MultiEdit). codex only emits
    // command_execution which we already map to name='Bash'. Unknown tools
    // fall through to the generic card.
    switch (name) {
      case 'read':
        card = _ReadToolCard(item: item, t: t, expanded: _expanded, onToggle: () => setState(() => _expanded = !_expanded));
        break;
      case 'write':
      case 'edit':
      case 'multiedit':
        card = _WriteEditToolCard(
          item: item,
          t: t,
          sessionId: widget.sessionId,
          expanded: _expanded,
          onToggle: () => setState(() => _expanded = !_expanded),
        );
        break;
      case 'bash':
      case 'command':
        card = _BashToolCard(
          item: item,
          t: t,
          expanded: _expanded,
          decision: _decision,
          onToggle: () => setState(() => _expanded = !_expanded),
          onDecide: _decide,
        );
        break;
      case 'glob':
      case 'grep':
      case 'ls':
        card = _GlobToolCard(item: item, t: t, expanded: _expanded, onToggle: () => setState(() => _expanded = !_expanded));
        break;
      case 'todowrite':
      case 'todo_write':
      case 'todo':
        card = _PlanToolCard(item: item, t: t, expanded: _expanded, onToggle: () => setState(() => _expanded = !_expanded));
        break;
      default:
        card = _GenericToolCard(item: item, t: t, expanded: _expanded, onToggle: () => setState(() => _expanded = !_expanded));
    }

    return Padding(
      padding: const EdgeInsets.only(right: 32, bottom: 8),
      child: canSwipe
          ? Dismissible(
              key: ValueKey('swipe-${item.toolCallId}-${item.key}'),
              direction: DismissDirection.horizontal,
              confirmDismiss: (dir) async {
                if (dir == DismissDirection.startToEnd) {
                  _decide(true);
                } else if (dir == DismissDirection.endToStart) {
                  _decide(false);
                }
                return false;
              },
              background: _swipeBackground(t, true),
              secondaryBackground: _swipeBackground(t, false),
              dismissThresholds: const {
                DismissDirection.startToEnd: 0.28,
                DismissDirection.endToStart: 0.28,
              },
              child: card,
            )
          : card,
    );
  }

  Widget _swipeBackground(PocketTheme t, bool approve) {
    final color = approve ? t.accent : t.danger;
    final icon = approve ? Icons.check_circle_outline : Icons.cancel_outlined;
    final label = approve ? '允许' : '拒绝';
    return Container(
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.18),
        borderRadius: BorderRadius.circular(t.radius),
        border: Border.all(color: color.withValues(alpha: 0.6), width: 1),
      ),
      margin: const EdgeInsets.symmetric(vertical: 2),
      child: Align(
        alignment: approve ? Alignment.centerLeft : Alignment.centerRight,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 18),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, color: color, size: 22),
              const SizedBox(width: 8),
              Text(label,
                  style: TextStyle(
                    color: color,
                    fontSize: 14,
                    fontWeight: FontWeight.w700,
                  )),
            ],
          ),
        ),
      ),
    );
  }
}

// ---------- shared helpers ----------

String? _extractCommand(dynamic input) {
  if (input is! Map) return null;
  final cmd = input['command'];
  if (cmd is String) return cmd;
  final c = input['cmd'];
  if (c is String) return c;
  return null;
}

String? _extractFilePath(dynamic input) {
  if (input is! Map) return null;
  for (final k in const ['file_path', 'filePath', 'path', 'filename']) {
    final v = input[k];
    if (v is String && v.isNotEmpty) return v;
  }
  return null;
}

String _prettyJson(dynamic obj) {
  try {
    return const JsonEncoder.withIndent('  ').convert(obj);
  } catch (_) {
    return obj.toString();
  }
}

String _basename(String path) {
  final i = path.lastIndexOf(RegExp(r'[/\\]'));
  return i < 0 ? path : path.substring(i + 1);
}

/// Common shell: a compact card with an icon header row and an expandable
/// output region. Tool-specific cards compose this with their own header.
Widget _toolCardShell({
  required PocketTheme t,
  required Widget header,
  required ChatItem item,
  required bool expanded,
  required VoidCallback onToggle,
  Widget? outputView,
}) {
  return Container(
    decoration: BoxDecoration(
      color: item.danger == true ? t.dangerBg : t.card,
      borderRadius: BorderRadius.circular(t.radius),
      border: Border.all(
        color: item.danger == true ? t.danger : t.border,
        width: item.danger == true ? 1 : 0.5,
      ),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        InkWell(
          borderRadius: BorderRadius.circular(t.radius),
          onTap: onToggle,
          child: header,
        ),
        if (expanded && item.toolInput != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: t.cardAlt,
                borderRadius: BorderRadius.circular(t.radius - 2),
                border: Border.all(color: t.border, width: 0.5),
              ),
              child: SelectableText(
                _prettyJson(item.toolInput),
                style: TextStyle(
                  color: t.foreground,
                  fontSize: 11,
                  fontFamily: t.fontMono,
                  height: 1.4,
                ),
              ),
            ),
          ),
        if (outputView != null) ...[
          Divider(height: 1, color: t.border),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
            child: outputView,
          ),
        ],
      ],
    ),
  );
}

Widget _toolOutputView(String output, PocketTheme t) {
  return Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        '输出',
        style: TextStyle(
          color: t.sub,
          fontSize: 10,
          fontWeight: FontWeight.w600,
          letterSpacing: 0.6,
        ),
      ),
      const SizedBox(height: 4),
      Container(
        constraints: const BoxConstraints(maxHeight: 220),
        child: SingleChildScrollView(
          child: SelectableText(
            output,
            style: TextStyle(
              color: t.foreground,
              fontSize: 11,
              fontFamily: t.fontMono,
              height: 1.4,
            ),
          ),
        ),
      ),
    ],
  );
}

// ---------- Read ----------

class _ReadToolCard extends StatelessWidget {
  final ChatItem item;
  final PocketTheme t;
  final bool expanded;
  final VoidCallback onToggle;
  const _ReadToolCard({required this.item, required this.t, required this.expanded, required this.onToggle});

  @override
  Widget build(BuildContext context) {
    final path = _extractFilePath(item.toolInput) ?? '(unknown file)';
    final name = _basename(path);
    // Output size hint: Read returns the file content as tool_output. Show
    // a byte/line count so the user can gauge scale without expanding.
    final out = item.toolOutput ?? '';
    String? sizeHint;
    if (out.isNotEmpty) {
      final lines = '\n'.allMatches(out).length + 1;
      sizeHint = '${_formatBytes(out.length)} · ${lines}L';
    }
    return _toolCardShell(
      t: t,
      item: item,
      expanded: expanded,
      onToggle: onToggle,
      outputView: out.isNotEmpty ? _toolOutputView(out, t) : null,
      header: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        child: Row(
          children: [
            Icon(Icons.description_outlined, color: t.accent, size: 16),
            const SizedBox(width: 8),
            Text('read', style: TextStyle(
              color: t.sub, fontSize: 11, fontWeight: FontWeight.w600,
              fontFamily: t.fontMono,
            )),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: t.foreground, fontSize: 13, fontWeight: FontWeight.w600),
              ),
            ),
            if (sizeHint != null)
              Text(sizeHint, style: TextStyle(color: t.sub, fontSize: 10, fontFamily: t.fontMono)),
            const SizedBox(width: 6),
            Icon(expanded ? Icons.expand_less : Icons.expand_more, color: t.sub, size: 16),
          ],
        ),
      ),
    );
  }
}

String _formatBytes(int n) {
  if (n < 1024) return '${n}B';
  if (n < 1024 * 1024) return '${(n / 1024).toStringAsFixed(1)}KB';
  return '${(n / 1024 / 1024).toStringAsFixed(1)}MB';
}

// ---------- Write / Edit / MultiEdit ----------

class _WriteEditToolCard extends StatelessWidget {
  final ChatItem item;
  final PocketTheme t;
  final String sessionId;
  final bool expanded;
  final VoidCallback onToggle;
  const _WriteEditToolCard({required this.item, required this.t, required this.sessionId, required this.expanded, required this.onToggle});

  @override
  Widget build(BuildContext context) {
    final path = _extractFilePath(item.toolInput) ?? '(unknown file)';
    final name = _basename(path);
    final verb = (item.toolName ?? '').toLowerCase() == 'write' ? 'write' : 'edit';
    final added = item.fileAdded;
    final removed = item.fileRemoved;
    final hasDiff = added != null || removed != null;
    final out = item.toolOutput ?? '';

    return _toolCardShell(
      t: t,
      item: item,
      expanded: expanded,
      onToggle: onToggle,
      outputView: out.isNotEmpty ? _toolOutputView(out, t) : null,
      header: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        child: Row(
          children: [
            Icon(verb == 'write' ? Icons.create_new_folder_outlined : Icons.edit_outlined,
                color: t.accent, size: 16),
            const SizedBox(width: 8),
            Text(verb, style: TextStyle(
              color: t.sub, fontSize: 11, fontWeight: FontWeight.w600,
              fontFamily: t.fontMono,
            )),
            const SizedBox(width: 8),
            Expanded(
              child: InkWell(
                onTap: () => context.push('/diff/$sessionId'),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: t.accent, fontSize: 13, fontWeight: FontWeight.w600,
                          decoration: TextDecoration.underline,
                          decorationColor: t.accent.withValues(alpha: 0.4),
                        ),
                      ),
                    ),
                    if (hasDiff) ...[
                      if (added != null)
                        Padding(
                          padding: const EdgeInsets.only(left: 6),
                          child: Text('+$added',
                            style: TextStyle(color: const Color(0xFF22C55E), fontSize: 11, fontWeight: FontWeight.w700, fontFamily: t.fontMono)),
                        ),
                      if (removed != null)
                        Padding(
                          padding: const EdgeInsets.only(left: 4),
                          child: Text('-$removed',
                            style: TextStyle(color: t.danger, fontSize: 11, fontWeight: FontWeight.w700, fontFamily: t.fontMono)),
                        ),
                    ],
                  ],
                ),
              ),
            ),
            const SizedBox(width: 6),
            Icon(expanded ? Icons.expand_less : Icons.expand_more, color: t.sub, size: 16),
          ],
        ),
      ),
    );
  }
}

// ---------- Bash / command_execution ----------

class _BashToolCard extends StatelessWidget {
  final ChatItem item;
  final PocketTheme t;
  final bool expanded;
  final bool? decision;
  final VoidCallback onToggle;
  final void Function(bool approve) onDecide;
  const _BashToolCard({required this.item, required this.t, required this.expanded, required this.decision, required this.onToggle, required this.onDecide});

  @override
  Widget build(BuildContext context) {
    final command = _extractCommand(item.toolInput) ?? '';
    final danger = item.danger == true;
    final out = item.toolOutput ?? '';
    return _toolCardShell(
      t: t,
      item: item,
      expanded: expanded,
      onToggle: onToggle,
      outputView: out.isNotEmpty ? _toolOutputView(out, t) : null,
      header: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(danger ? Icons.warning_amber_rounded : Icons.terminal,
                    color: danger ? t.danger : t.accent, size: 16),
                const SizedBox(width: 8),
                Text('bash', style: TextStyle(
                  color: t.sub, fontSize: 11, fontWeight: FontWeight.w600,
                  fontFamily: t.fontMono,
                )),
                const Spacer(),
                Icon(expanded ? Icons.expand_less : Icons.expand_more, color: t.sub, size: 16),
              ],
            ),
            const SizedBox(height: 6),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              decoration: BoxDecoration(
                color: danger ? t.dangerBg.withValues(alpha: 0.5) : t.cardAlt,
                borderRadius: BorderRadius.circular(t.radius - 4),
                border: Border.all(color: danger ? t.danger.withValues(alpha: 0.5) : t.border, width: 0.5),
              ),
              child: Text(
                '\$ $command',
                maxLines: expanded ? null : 2,
                overflow: expanded ? TextOverflow.visible : TextOverflow.ellipsis,
                style: TextStyle(
                  color: danger ? t.dangerFg : t.foreground,
                  fontSize: 12,
                  fontFamily: t.fontMono,
                  height: 1.4,
                ),
              ),
            ),
            if (danger && item.pending && decision == null) ...[
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: () => onDecide(false),
                      icon: const Icon(Icons.close, size: 16),
                      label: const Text('拒绝'),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: t.danger,
                        side: BorderSide(color: t.danger),
                        padding: const EdgeInsets.symmetric(vertical: 8),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: () => onDecide(true),
                      icon: const Icon(Icons.check, size: 16),
                      label: const Text('允许'),
                      style: FilledButton.styleFrom(
                        backgroundColor: t.accent,
                        foregroundColor: t.accentForeground,
                        padding: const EdgeInsets.symmetric(vertical: 8),
                      ),
                    ),
                  ),
                ],
              ),
            ],
            if (decision != null)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(
                  decision! ? '已允许' : '已拒绝',
                  style: TextStyle(
                    color: decision! ? t.accent : t.danger,
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

// ---------- Glob / Grep / Ls ----------

class _GlobToolCard extends StatelessWidget {
  final ChatItem item;
  final PocketTheme t;
  final bool expanded;
  final VoidCallback onToggle;
  const _GlobToolCard({required this.item, required this.t, required this.expanded, required this.onToggle});

  @override
  Widget build(BuildContext context) {
    final out = item.toolOutput ?? '';
    // Glob/Grep output is a list of paths — count lines as match count.
    int? matchCount;
    if (out.isNotEmpty) {
      final n = out.split('\n').where((s) => s.trim().isNotEmpty).length;
      matchCount = n;
    }
    final pattern = item.toolInput is Map
        ? (item.toolInput['pattern'] ?? item.toolInput['path'] ?? item.toolInput['query']) as String?
        : null;
    return _toolCardShell(
      t: t,
      item: item,
      expanded: expanded,
      onToggle: onToggle,
      outputView: out.isNotEmpty ? _toolOutputView(out, t) : null,
      header: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        child: Row(
          children: [
            Icon(Icons.search, color: t.accent, size: 16),
            const SizedBox(width: 8),
            Text((item.toolName ?? 'glob').toLowerCase(),
              style: TextStyle(color: t.sub, fontSize: 11, fontWeight: FontWeight.w600, fontFamily: t.fontMono)),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                pattern ?? '',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: t.foreground, fontSize: 13, fontFamily: t.fontMono),
              ),
            ),
            if (matchCount != null)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                decoration: BoxDecoration(
                  color: t.accent.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text('$matchCount',
                  style: TextStyle(color: t.accent, fontSize: 10, fontWeight: FontWeight.w700, fontFamily: t.fontMono)),
              ),
            const SizedBox(width: 6),
            Icon(expanded ? Icons.expand_less : Icons.expand_more, color: t.sub, size: 16),
          ],
        ),
      ),
    );
  }
}

// ---------- TodoWrite / plan ----------

class _PlanToolCard extends StatelessWidget {
  final ChatItem item;
  final PocketTheme t;
  final bool expanded;
  final VoidCallback onToggle;
  const _PlanToolCard({required this.item, required this.t, required this.expanded, required this.onToggle});

  @override
  Widget build(BuildContext context) {
    // Claude's TodoWrite tool input: {todos: [{content, status, activeForm}, ...]}.
    // We render the todo list as a numbered plan card. Codex/codebuddy
    // don't have an equivalent tool, so this card only triggers for claude.
    final todos = _extractTodos(item.toolInput);
    return _toolCardShell(
      t: t,
      item: item,
      expanded: expanded,
      onToggle: onToggle,
      header: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        child: Row(
          children: [
            Icon(Icons.checklist, color: t.accent, size: 16),
            const SizedBox(width: 8),
            Text('plan',
              style: TextStyle(color: t.sub, fontSize: 11, fontWeight: FontWeight.w600, fontFamily: t.fontMono)),
            const SizedBox(width: 8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
              decoration: BoxDecoration(
                color: t.accent.withValues(alpha: 0.14),
                borderRadius: BorderRadius.circular(4),
              ),
              child: Text('${todos.length}',
                style: TextStyle(color: t.accent, fontSize: 10, fontWeight: FontWeight.w700, fontFamily: t.fontMono)),
            ),
            const Spacer(),
            Icon(expanded ? Icons.expand_less : Icons.expand_more, color: t.sub, size: 16),
          ],
        ),
      ),
      outputView: todos.isEmpty
          ? null
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (var i = 0; i < todos.length; i++)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 4),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Container(
                          width: 18,
                          height: 18,
                          margin: const EdgeInsets.only(right: 8, top: 1),
                          decoration: BoxDecoration(
                            color: todos[i].done
                                ? t.accent.withValues(alpha: 0.18)
                                : Colors.transparent,
                            border: Border.all(
                              color: todos[i].done ? t.accent : t.sub,
                              width: 1,
                            ),
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: todos[i].done
                              ? Icon(Icons.check, size: 12, color: t.accent)
                              : Center(
                                  child: Text(
                                    '${i + 1}',
                                    style: TextStyle(
                                      color: t.sub,
                                      fontSize: 10,
                                      fontWeight: FontWeight.w600,
                                    ),
                                  ),
                                ),
                        ),
                        Expanded(
                          child: Text(
                            todos[i].content,
                            style: TextStyle(
                              color: todos[i].done ? t.sub : t.foreground,
                              fontSize: 12,
                              height: 1.4,
                              decoration: todos[i].done ? TextDecoration.lineThrough : null,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
    );
  }

  List<_Todo> _extractTodos(dynamic input) {
    if (input is! Map) return const [];
    final raw = input['todos'];
    if (raw is! List) return const [];
    return raw
        .map((x) {
          if (x is! Map) return null;
          final content = (x['content'] ?? x['activeForm'] ?? '').toString();
          final status = (x['status'] ?? '').toString();
          return _Todo(content: content, done: status == 'completed' || status == 'done');
        })
        .whereType<_Todo>()
        .toList();
  }
}

class _Todo {
  final String content;
  final bool done;
  const _Todo({required this.content, required this.done});
}

// ---------- Generic fallback ----------

class _GenericToolCard extends StatelessWidget {
  final ChatItem item;
  final PocketTheme t;
  final bool expanded;
  final VoidCallback onToggle;
  const _GenericToolCard({required this.item, required this.t, required this.expanded, required this.onToggle});

  @override
  Widget build(BuildContext context) {
    final out = item.toolOutput ?? '';
    return _toolCardShell(
      t: t,
      item: item,
      expanded: expanded,
      onToggle: onToggle,
      outputView: out.isNotEmpty ? _toolOutputView(out, t) : null,
      header: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        child: Row(
          children: [
            Icon(item.danger == true ? Icons.warning_amber_rounded : Icons.build_outlined,
                color: item.danger == true ? t.danger : t.accent, size: 16),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                item.toolName ?? 'tool',
                style: TextStyle(color: t.foreground, fontSize: 13, fontWeight: FontWeight.w600),
              ),
            ),
            if (item.pending)
              SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 1.5, color: t.sub)),
            const SizedBox(width: 6),
            Icon(expanded ? Icons.expand_less : Icons.expand_more, color: t.sub, size: 16),
          ],
        ),
      ),
    );
  }
}

class _StatusCard extends StatelessWidget {
  final String state;
  final PocketTheme t;
  const _StatusCard({required this.state, required this.t});
  @override
  Widget build(BuildContext context) {
    final (icon, color, label) = switch (state) {
      'done' => (Icons.check_circle_outline, t.sub, '已完成'),
      'error' => (Icons.error_outline, t.danger, '出错'),
      _ => (Icons.stop_outlined, t.sub, '已中断'),
    };
    return Padding(
      padding: const EdgeInsets.only(right: 48, bottom: 10),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: t.cardAlt.withValues(alpha: 0.4),
          borderRadius: BorderRadius.circular(t.radius),
          border: Border.all(color: t.border, width: 0.5),
        ),
        child: Row(
          children: [
            Icon(icon, color: color, size: 14),
            const SizedBox(width: 6),
            Text(label, style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w600)),
          ],
        ),
      ),
    );
  }
}

class _RawCard extends StatelessWidget {
  final String data;
  final PocketTheme t;
  const _RawCard({required this.data, required this.t});
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(right: 48, bottom: 6),
        child: Container(
          padding: const EdgeInsets.all(8),
          decoration: BoxDecoration(
            color: t.cardAlt,
            borderRadius: BorderRadius.circular(t.radius - 2),
            border: Border.all(color: t.border, width: 0.5),
          ),
          child: SelectableText(
            data,
            style: TextStyle(
              color: t.sub,
              fontSize: 11,
              fontFamily: t.fontMono,
              height: 1.4,
            ),
          ),
        ),
      );
}

class _InputBar extends StatefulWidget {
  final PocketTheme t;
  final TextEditingController controller;
  final bool running;
  final ValueChanged<String> onSend;
  final VoidCallback onInterrupt;
  const _InputBar({
    required this.t,
    required this.controller,
    required this.running,
    required this.onSend,
    required this.onInterrupt,
  });

  @override
  State<_InputBar> createState() => _InputBarState();
}

class _InputBarState extends State<_InputBar> {
  final SpeechToText _speech = SpeechToText();
  bool _speechAvailable = false;
  bool _listening = false;

  @override
  void initState() {
    super.initState();
    _initSpeech();
  }

  Future<void> _initSpeech() async {
    try {
      final ok = await _speech.initialize(
        onError: (err) => setState(() => _listening = false),
        onStatus: (s) {
          if (s == 'notListening' || s == 'done') {
            setState(() => _listening = false);
          }
        },
      );
      setState(() => _speechAvailable = ok);
    } catch (_) {
      setState(() => _speechAvailable = false);
    }
  }

  Future<void> _toggleMic() async {
    if (!_speechAvailable) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: const Text('语音识别不可用（需真机 + 麦克风权限）'),
          backgroundColor: widget.t.dangerBg,
        ),
      );
      return;
    }
    if (_listening) {
      await _speech.stop();
      setState(() => _listening = false);
      return;
    }
    HapticFeedback.mediumImpact();
    setState(() => _listening = true);
    await _speech.listen(
      onResult: (r) {
        if (r.recognizedWords.isNotEmpty) {
          setState(() {
            widget.controller.text = r.recognizedWords;
            widget.controller.selection = TextSelection.fromPosition(
              TextPosition(offset: widget.controller.text.length),
            );
          });
        }
      },
      listenOptions: SpeechListenOptions(
        localeId: 'zh_CN',
        listenMode: ListenMode.dictation,
        partialResults: true,
        cancelOnError: true,
        listenFor: const Duration(seconds: 30),
        pauseFor: const Duration(seconds: 3),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.t;
    return SafeArea(
      top: false,
      child: Container(
        decoration: BoxDecoration(
          color: t.card,
          border: Border(top: BorderSide(color: t.border, width: 0.5)),
        ),
        padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
        child: Column(
          children: [
            _quickRow(context),
            const SizedBox(height: 6),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: TextField(
                    controller: widget.controller,
                    minLines: 1,
                    maxLines: 5,
                    style: TextStyle(color: t.foreground, fontSize: 14),
                    decoration: InputDecoration(
                      hintText: _listening ? '正在聆听…' : '发消息…',
                      hintStyle: TextStyle(
                        color: _listening ? t.accent : t.sub,
                        fontSize: 14,
                      ),
                      filled: true,
                      fillColor: _listening
                          ? t.accent.withValues(alpha: 0.06)
                          : t.inputFill,
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(t.radius + 4),
                        borderSide: BorderSide(
                          color: _listening ? t.accent : t.inputBorder,
                        ),
                      ),
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(t.radius + 4),
                        borderSide: BorderSide(
                          color: _listening ? t.accent : t.inputBorder,
                        ),
                      ),
                      focusedBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(t.radius + 4),
                        borderSide: BorderSide(
                          color: _listening ? t.accent : t.inputBorderFocus,
                        ),
                      ),
                      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                      isDense: true,
                    ),
                    onSubmitted: (v) {
                      if (v.trim().isNotEmpty) widget.onSend(v);
                    },
                  ),
                ),
                const SizedBox(width: 8),
                GestureDetector(
                  onLongPress: _toggleMic,
                  child: IconButton(
                    onPressed: _toggleMic,
                    icon: Icon(
                      _listening ? Icons.mic : Icons.mic_none,
                      color: _listening ? t.accent : t.sub,
                    ),
                    style: IconButton.styleFrom(
                      backgroundColor: _listening
                          ? t.accent.withValues(alpha: 0.12)
                          : Colors.transparent,
                    ),
                  ),
                ),
                const SizedBox(width: 4),
                if (widget.running)
                  IconButton.filled(
                    onPressed: widget.onInterrupt,
                    icon: const Icon(Icons.stop),
                    style: IconButton.styleFrom(
                      backgroundColor: t.danger,
                      foregroundColor: Colors.white,
                    ),
                  )
                else
                  IconButton.filled(
                    onPressed: () {
                      final v = widget.controller.text.trim();
                      if (v.isNotEmpty) widget.onSend(v);
                    },
                    icon: const Icon(Icons.send),
                    style: IconButton.styleFrom(
                      backgroundColor: t.accent,
                      foregroundColor: t.accentForeground,
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _quickRow(BuildContext context) {
    final chips = ['/plan', '/fix', '/test', '/explain'];
    return SizedBox(
      height: 28,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: chips.length,
        separatorBuilder: (_, _) => const SizedBox(width: 6),
        itemBuilder: (context, i) => GestureDetector(
          onTap: () {
            widget.controller.text = '${chips[i]} ';
            widget.controller.selection = TextSelection.fromPosition(TextPosition(offset: widget.controller.text.length));
          },
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(
              color: widget.t.cardAlt,
              borderRadius: BorderRadius.circular(999),
              border: Border.all(color: widget.t.border, width: 0.5),
            ),
            child: Text(
              chips[i],
              style: TextStyle(
                color: widget.t.accent,
                fontSize: 11,
                fontFamily: widget.t.fontMono,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
