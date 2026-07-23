import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:app/features/terminal/terminal_page.dart';

void main() {
  testWidgets('TerminalPage builds and shows a terminal view', (tester) async {
    final sent = <String>[];
    var opened = false;
    await tester.pumpWidget(MaterialApp(
      home: TerminalPage(
        sessionId: 's1',
        onOpen: () => opened = true,
        onClose: () {},
        onInput: (d) => sent.add(d),
        onResize: (c, r) {},
        incoming: const Stream.empty(),
      ),
    ));
    await tester.pump();
    expect(find.byType(TerminalPage), findsOneWidget);
    expect(opened, isTrue, reason: 'onOpen should fire on init');
  });

  testWidgets('TerminalPage renders incoming term bytes', (tester) async {
    final controller = StreamController<String>.broadcast();
    await tester.pumpWidget(MaterialApp(
      home: TerminalPage(
        sessionId: 's1',
        onOpen: () {},
        onClose: () {},
        onInput: (_) {},
        onResize: (cols, rows) {},
        incoming: controller.stream,
      ),
    ));
    await tester.pump();
    // Pushing data through the stream should not throw (written to terminal).
    controller.add('hello world\r\n');
    await tester.pump(const Duration(milliseconds: 50));
    expect(tester.takeException(), isNull);
    await controller.close();
  });
}
