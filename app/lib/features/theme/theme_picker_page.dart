import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/theme/theme.dart';

class ThemePickerPage extends ConsumerWidget {
  const ThemePickerPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final current = ref.watch(themeProvider);
    final t = current;
    return Scaffold(
      backgroundColor: t.background,
      body: SafeArea(
        child: CustomScrollView(
          slivers: [
            SliverAppBar(
              backgroundColor: t.background,
              pinned: true,
              leading: IconButton(
                icon: Icon(Icons.arrow_back, color: t.foreground),
                onPressed: () => context.pop(),
              ),
              title: Text(
                '主题',
                style: TextStyle(
                  color: t.foreground,
                  fontSize: 18,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
              sliver: SliverList.separated(
                itemCount: PocketThemes.all.length,
                separatorBuilder: (_, _) => const SizedBox(height: 12),
                itemBuilder: (context, i) {
                  final theme = PocketThemes.all[i];
                  final selected = theme.id == current.id;
                  return _ThemeCard(
                    theme: theme,
                    selected: selected,
                    onTap: () {
                      ref.read(themeProvider.notifier).select(theme.id);
                    },
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ThemeCard extends StatelessWidget {
  final PocketTheme theme;
  final bool selected;
  final VoidCallback onTap;
  const _ThemeCard({required this.theme, required this.selected, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Material(
      color: theme.card,
      borderRadius: BorderRadius.circular(theme.radius),
      child: InkWell(
        borderRadius: BorderRadius.circular(theme.radius),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(theme.radius),
            border: Border.all(
              color: selected ? theme.accent : theme.border,
              width: selected ? 1.5 : 1,
            ),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _SwatchStrip(theme: theme),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Text(
                          theme.name,
                          style: TextStyle(
                            color: theme.foreground,
                            fontSize: 15,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(width: 8),
                        if (selected)
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                            decoration: BoxDecoration(
                              color: theme.accent,
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: Text(
                              '当前',
                              style: TextStyle(
                                color: theme.accentForeground,
                                fontSize: 10,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        const Spacer(),
                        Icon(
                          theme.dark ? Icons.dark_mode : Icons.light_mode,
                          color: theme.sub,
                          size: 16,
                        ),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text(
                      theme.tagline,
                      style: TextStyle(
                        color: theme.sub,
                        fontSize: 11,
                        fontFamily: theme.fontMono,
                      ),
                    ),
                    const SizedBox(height: 12),
                    _MiniPreview(theme: theme),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SwatchStrip extends StatelessWidget {
  final PocketTheme theme;
  const _SwatchStrip({required this.theme});

  @override
  Widget build(BuildContext context) {
    final colors = [theme.background, theme.card, theme.cardAlt, theme.accent, theme.sub];
    return Container(
      width: 56,
      height: 80,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(theme.radius / 2),
        border: Border.all(color: theme.border, width: 0.5),
      ),
      child: Column(
        children: colors
            .map((c) => Expanded(child: Container(color: c)))
            .toList(),
      ),
    );
  }
}

class _MiniPreview extends StatelessWidget {
  final PocketTheme theme;
  const _MiniPreview({required this.theme});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: theme.cardAlt,
        borderRadius: BorderRadius.circular(theme.radius / 2),
        border: Border.all(color: theme.border, width: 0.5),
      ),
      child: Row(
        children: [
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(color: theme.accent, shape: BoxShape.circle),
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Container(
              height: 6,
              decoration: BoxDecoration(
                color: theme.foreground.withValues(alpha: 0.3),
                borderRadius: BorderRadius.circular(3),
              ),
            ),
          ),
          const SizedBox(width: 6),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
            decoration: BoxDecoration(
              color: theme.accent,
              borderRadius: BorderRadius.circular(4),
            ),
            child: Text(
              'GO',
              style: TextStyle(
                color: theme.accentForeground,
                fontSize: 9,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
