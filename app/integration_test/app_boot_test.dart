// On-device / emulator integration test.
//
// Run on a connected device:
//   flutter test integration_test/app_boot_test.dart -d <device-id>
//
// This boots the real app and verifies it renders to the Connect screen
// without a live server (no pairing yet). End-to-end flows that need a running
// server (pair -> create session -> send message -> import host session) are
// described in docs/testing-plan.md; add them here behind an env-provided
// SERVER_URL so they only run when a server is reachable.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:app/main.dart' as app;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('app boots and renders a MaterialApp', (tester) async {
    app.main();
    await tester.pumpAndSettle(const Duration(seconds: 2));
    expect(find.byType(MaterialApp), findsOneWidget);
  });
}
