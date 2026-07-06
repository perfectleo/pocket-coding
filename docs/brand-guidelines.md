# Pocket Coding — Brand Guidelines (V9–V13)

> 5 个新视觉品牌的设计系统。每个品牌独立定义色相、字体、圆角、辉光，
> 与 V1–V8 不重复。所有品牌共享同一套页面模板，仅靠 CSS 变量换肤。

---

## 共通原则

- **品牌一致性**：主色占比 60–70%，次色 20–30%，强调色 5–10%。
- **可访问性**：正文对比度 ≥ 4.5:1（WCAG AA）；危险操作用色 + 符号 + 文字三重表达。
- **等宽数字**：行号、增删数、时间戳全部用 `font-variant-numeric: tabular-nums`。
- **触控**：所有可点区域 ≥ 44pt，底部导航避开手势条安全区。

---

## V9 · Graphite Carbon

> 高端工作站气质。石墨灰底 + 钴蓝强调，哑光金属质感，细边框，冷峻内敛。

| Token | Value | Usage |
|---|---|---|
| `--bg-grad` | `radial-gradient(120% 80% at 50% -10%, #1a1d24, #0d0f13 60%)` | 设备底 |
| `--card` | `#161922` | 卡片 |
| `--card-2` | `#1d212c` | 输入/次级 |
| `--fg` | `#E5E7EB` | 正文 |
| `--sub` | `#8B8F9A` | 次要 |
| `--acc` | `#3B82F6` | 钴蓝强调 |
| `--acc-fg` | `#0a0f1d` | 强调色上的字 |
| `--border` | `#2A2F3A` | 边框 |
| `--radius` | `12px` | 中等圆角 |
| `--font` | `'Inter Tight', sans-serif` | 正文 |
| `--head` | `'Inter Tight', sans-serif` | 标题 |
| `--glow` | `0 6px 18px -8px` | 微辉光，内敛 |

字体加载：`Inter Tight:wght@400;500;600;700` + `JetBrains Mono:wght@400;500;700`。

---

## V10 · Sunrise Coral

> 清晨友好感。奶油米底 + 珊瑚红强调 + 薄荷绿次色，大圆角，柔和阴影。

| Token | Value | Usage |
|---|---|---|
| `--bg-grad` | `linear-gradient(180deg, #FFF8F3, #FDEEE2)` | 设备底 |
| `--card` | `#FFFFFF` | 卡片 |
| `--card-2` | `#FFF1E6` | 输入/次级 |
| `--fg` | `#2B1F1A` | 正文（暖墨） |
| `--sub` | `#8C7568` | 次要 |
| `--acc` | `#FF6B6B` | 珊瑚红强调 |
| `--acc-fg` | `#FFFFFF` | 强调色上的字 |
| `--border` | `#F0D9C7` | 边框 |
| `--radius` | `20px` | 大圆角亲和 |
| `--font` | `'DM Sans', sans-serif` | 正文 |
| `--head` | `'DM Sans', sans-serif` | 标题 |
| `--glow` | `0 10px 24px -10px` | 柔和阴影 |

字体加载：`DM Sans:wght@400;500;600;700` + `JetBrains Mono:wght@400;500;700`。

---

## V11 · Matrix Forest

> 森林深绿底 + 苔藓黄绿强调，雾面有机，自然主义开发者风。

| Token | Value | Usage |
|---|---|---|
| `--bg-grad` | `radial-gradient(120% 80% at 50% -10%, #0f1f1a, #06120e 60%)` | 设备底 |
| `--card` | `#11201B` | 卡片 |
| `--card-2` | `#16291F` | 输入/次级 |
| `--fg` | `#E8F0E5` | 正文 |
| `--sub` | `#8FA89A` | 次要 |
| `--acc` | `#84CC16` | 苔藓黄绿 |
| `--acc-fg` | `#0a1a0a` | 强调色上的字 |
| `--border` | `#1F3328` | 边框 |
| `--radius` | `14px` | 中等偏大圆角 |
| `--font` | `'Outfit', sans-serif` | 正文 |
| `--head` | `'Outfit', sans-serif` | 标题 |
| `--glow` | `0 8px 22px -8px` | 雾面辉光 |

字体加载：`Outfit:wght@300;400;500;600;700` + `JetBrains Mono:wght@400;500;700`。

---

## V12 · Slate Pro

> Notion/Linear 同源的专业灰。冷灰白底 + 紫罗兰强调，极简、信息密集。

| Token | Value | Usage |
|---|---|---|
| `--bg-grad` | `linear-gradient(180deg, #FAFAFA, #F1F2F4)` | 设备底 |
| `--card` | `#FFFFFF` | 卡片 |
| `--card-2` | `#F4F5F7` | 输入/次级 |
| `--fg` | `#1A1B1E` | 正文 |
| `--sub` | `#6B7280` | 次要 |
| `--acc` | `#8B5CF6` | 紫罗兰强调 |
| `--acc-fg` | `#FFFFFF` | 强调色上的字 |
| `--border` | `#E5E7EB` | 边框 |
| `--radius` | `8px` | 小圆角，信息密集 |
| `--font` | `'Geist', sans-serif` | 正文 |
| `--head` | `'Geist', sans-serif` | 标题 |
| `--glow` | `0 4px 12px -6px` | 几乎无辉光 |

字体加载：`Geist:wght@400;500;600;700` + `JetBrains Mono:wght@400;500;700`。
（Geist 在 Google Fonts 不可用，用 `Inter` 作为 fallback，并优先尝试 Vercel Geist CDN；保险起见本实现用 `Inter` 顶替 Geist 以保证离线可用。）

---

## V13 · Midnight Plum

> 暗夜深紫底 + 玫瑰金强调，优雅微辉光，贵族感。

| Token | Value | Usage |
|---|---|---|
| `--bg-grad` | `radial-gradient(120% 80% at 50% -10%, #2a1840, #15091f 60%)` | 设备底 |
| `--card` | `#241434` | 卡片 |
| `--card-2` | `#2E1A44` | 输入/次级 |
| `--fg` | `#F3E8F5` | 正文 |
| `--sub` | `#B79BC8` | 次要 |
| `--acc` | `#E8B4D6` | 玫瑰金强调 |
| `--acc-fg` | `#1f0a2a` | 强调色上的字 |
| `--border` | `#3D2655` | 边框 |
| `--radius` | `16px` | 中等圆角 |
| `--font` | `'Plus Jakarta Sans', sans-serif` | 正文 |
| `--head` | `'Plus Jakarta Sans', sans-serif` | 标题 |
| `--glow` | `0 8px 24px -8px` | 优雅辉光 |

字体加载：`Plus Jakarta Sans:wght@400;500;600;700` + `JetBrains Mono:wght@400;500;700`。

---

## 字体加载统一片段

```html
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700&family=DM+Sans:wght@400;500;600;700&family=Outfit:wght@300;400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet" />
```

---

## 各品牌差异化要点

- **V9 Graphite Carbon**：钴蓝 + 哑光金属，边框 1px 细线，无扫描线/无网格，靠精度感取胜。
- **V10 Sunrise Coral**：浅色暖调 + 大圆角 20px，唯一一个用珊瑚红的浅色版，亲和无威胁。
- **V11 Matrix Forest**：深绿底 + 黄绿强调，与 V1 终端绿区分（V1 是黑底亮绿，V11 是深绿底苔藓绿，色相完全不同）。
- **V12 Slate Pro**：冷灰白底 + 紫罗兰，极小圆角 8px，信息密度最高，与 V5 Linear 的暗色靛蓝形成浅色对照。
- **V13 Midnight Plum**：深紫底 + 玫瑰金，与 V8 Synthwave 的品红霓虹区分（V13 无网格、无霓虹辉光，更内敛优雅）。
