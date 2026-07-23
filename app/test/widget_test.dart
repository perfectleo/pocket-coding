import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  // Smoke test. The full app needs a running server + pairing, so mounting
  // PocketCodingApp here would hit the network and be flaky. We keep a minimal
  // render check green in CI; real UI flows live in integration_test/ (run on
  // a device/emulator against a live server). See docs/testing-plan.md.
  testWidgets('smoke: renders a MaterialApp', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: Center(child: Text('ok')))),
    );
    expect(find.text('ok'), findsOneWidget);
  });
}
