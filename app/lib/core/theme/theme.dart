import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// A visual theme for Pocket Coding. Each theme is a self-contained token set;
/// new themes can be added by appending to [PocketThemes.all].
class PocketTheme {
  final String id;
  final String name;
  final String tagline;
  final bool dark;
  final Color background;
  final Color card;
  final Color cardAlt;
  final Color foreground;
  final Color sub;
  final Color accent;
  final Color accentForeground;
  final Color border;
  final Color inputFill;
  final Color inputBorder;
  final Color inputBorderFocus;
  final Color danger;
  final Color dangerBg;
  final Color dangerFg;
  final double radius;
  final String? fontHead;
  final String? fontBody;
  final String? fontMono;

  const PocketTheme({
    required this.id,
    required this.name,
    required this.tagline,
    required this.dark,
    required this.background,
    required this.card,
    required this.cardAlt,
    required this.foreground,
    required this.sub,
    required this.accent,
    required this.accentForeground,
    required this.border,
    required this.inputFill,
    required this.inputBorder,
    required this.inputBorderFocus,
    required this.danger,
    required this.dangerBg,
    required this.dangerFg,
    required this.radius,
    this.fontHead,
    this.fontBody,
    this.fontMono,
  });

  ThemeData toThemeData() {
    final scheme = ColorScheme.fromSeed(
      seedColor: accent,
      brightness: dark ? Brightness.dark : Brightness.light,
    );
    return ThemeData(
      useMaterial3: true,
      brightness: dark ? Brightness.dark : Brightness.light,
      scaffoldBackgroundColor: background,
      colorScheme: scheme.copyWith(
        primary: accent,
        onPrimary: accentForeground,
        surface: card,
        onSurface: foreground,
      ),
    );
  }
}

class PocketThemes {
  static const all = <PocketTheme>[
    _v0Terminal,
    _v9Graphite,
    _v10Coral,
    _v11Forest,
    _v12Slate,
    _v13Plum,
  ];

  static PocketTheme byId(String id) =>
      all.firstWhere((t) => t.id == id, orElse: () => _v0Terminal);

  static const _v0Terminal = PocketTheme(
    id: 'terminal',
    name: 'Terminal',
    tagline: '// vibe code anywhere',
    dark: true,
    background: Color(0xFF060810),
    card: Color(0xFF11131D),
    cardAlt: Color(0xFF141B30),
    foreground: Colors.white,
    sub: Color(0xFF94A3B8),
    accent: Color(0xFF22C55E),
    accentForeground: Color(0xFF04140A),
    border: Color(0xFF232636),
    inputFill: Color(0xFF141B30),
    inputBorder: Color(0xFF243049),
    inputBorderFocus: Color(0xFF22C55E),
    danger: Color(0xFFEF4444),
    dangerBg: Color(0x22EF4444),
    dangerFg: Color(0xFFFCA5A5),
    radius: 12,
    fontMono: 'JetBrains Mono',
  );

  static const _v9Graphite = PocketTheme(
    id: 'graphite',
    name: 'Graphite Carbon',
    tagline: '// workstation-grade',
    dark: true,
    background: Color(0xFF0D0F13),
    card: Color(0xFF161922),
    cardAlt: Color(0xFF1D212C),
    foreground: Color(0xFFE5E7EB),
    sub: Color(0xFF8B8F9A),
    accent: Color(0xFF3B82F6),
    accentForeground: Color(0xFF0A0F1D),
    border: Color(0xFF2A2F3A),
    inputFill: Color(0xFF1D212C),
    inputBorder: Color(0xFF2A2F3A),
    inputBorderFocus: Color(0xFF3B82F6),
    danger: Color(0xFFEF4444),
    dangerBg: Color(0x22EF4444),
    dangerFg: Color(0xFFFCA5A5),
    radius: 12,
    fontHead: 'Inter Tight',
    fontBody: 'Inter Tight',
    fontMono: 'JetBrains Mono',
  );

  static const _v10Coral = PocketTheme(
    id: 'coral',
    name: 'Sunrise Coral',
    tagline: '// warm morning',
    dark: false,
    background: Color(0xFFFDF8F3),
    card: Color(0xFFFFFFFF),
    cardAlt: Color(0xFFFFF1E6),
    foreground: Color(0xFF2B1F1A),
    sub: Color(0xFF8C7568),
    accent: Color(0xFFFF6B6B),
    accentForeground: Color(0xFFFFFFFF),
    border: Color(0xFFF0D9C7),
    inputFill: Color(0xFFFFF1E6),
    inputBorder: Color(0xFFF0D9C7),
    inputBorderFocus: Color(0xFFFF6B6B),
    danger: Color(0xFFE23744),
    dangerBg: Color(0x22E23744),
    dangerFg: Color(0xFF8A1F26),
    radius: 20,
    fontHead: 'DM Sans',
    fontBody: 'DM Sans',
    fontMono: 'JetBrains Mono',
  );

  static const _v11Forest = PocketTheme(
    id: 'forest',
    name: 'Matrix Forest',
    tagline: '// organic dev',
    dark: true,
    background: Color(0xFF06120E),
    card: Color(0xFF11201B),
    cardAlt: Color(0xFF16291F),
    foreground: Color(0xFFE8F0E5),
    sub: Color(0xFF8FA89A),
    accent: Color(0xFF84CC16),
    accentForeground: Color(0xFF0A1A0A),
    border: Color(0xFF1F3328),
    inputFill: Color(0xFF16291F),
    inputBorder: Color(0xFF1F3328),
    inputBorderFocus: Color(0xFF84CC16),
    danger: Color(0xFFEF4444),
    dangerBg: Color(0x22EF4444),
    dangerFg: Color(0xFFFCA5A5),
    radius: 14,
    fontHead: 'Outfit',
    fontBody: 'Outfit',
    fontMono: 'JetBrains Mono',
  );

  static const _v12Slate = PocketTheme(
    id: 'slate',
    name: 'Slate Pro',
    tagline: '// notion-grade',
    dark: false,
    background: Color(0xFFF1F2F4),
    card: Color(0xFFFFFFFF),
    cardAlt: Color(0xFFF4F5F7),
    foreground: Color(0xFF1A1B1E),
    sub: Color(0xFF6B7280),
    accent: Color(0xFF8B5CF6),
    accentForeground: Color(0xFFFFFFFF),
    border: Color(0xFFE5E7EB),
    inputFill: Color(0xFFF4F5F7),
    inputBorder: Color(0xFFE5E7EB),
    inputBorderFocus: Color(0xFF8B5CF6),
    danger: Color(0xFFE23744),
    dangerBg: Color(0x22E23744),
    dangerFg: Color(0xFF8A1F26),
    radius: 8,
    fontHead: 'Inter',
    fontBody: 'Inter',
    fontMono: 'JetBrains Mono',
  );

  static const _v13Plum = PocketTheme(
    id: 'plum',
    name: 'Midnight Plum',
    tagline: '// elegant night',
    dark: true,
    background: Color(0xFF15091F),
    card: Color(0xFF241434),
    cardAlt: Color(0xFF2E1A44),
    foreground: Color(0xFFF3E8F5),
    sub: Color(0xFFB79BC8),
    accent: Color(0xFFE8B4D6),
    accentForeground: Color(0xFF1F0A2A),
    border: Color(0xFF3D2655),
    inputFill: Color(0xFF2E1A44),
    inputBorder: Color(0xFF3D2655),
    inputBorderFocus: Color(0xFFE8B4D6),
    danger: Color(0xFFEF4444),
    dangerBg: Color(0x22EF4444),
    dangerFg: Color(0xFFFCA5A5),
    radius: 16,
    fontHead: 'Plus Jakarta Sans',
    fontBody: 'Plus Jakarta Sans',
    fontMono: 'JetBrains Mono',
  );
}

const _kThemePrefKey = 'pocket.theme.id';

class ThemeNotifier extends StateNotifier<PocketTheme> {
  ThemeNotifier() : super(PocketThemes._v0Terminal);

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    final id = prefs.getString(_kThemePrefKey);
    if (id != null) state = PocketThemes.byId(id);
  }

  Future<void> select(String id) async {
    state = PocketThemes.byId(id);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kThemePrefKey, id);
  }
}

final themeProvider = StateNotifierProvider<ThemeNotifier, PocketTheme>(
  (ref) => ThemeNotifier(),
);
