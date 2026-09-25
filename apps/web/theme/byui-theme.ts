// BYU-Idaho-branded Fluent UI v9 theme.
// Ported from: C:\Devs\AIgrader\app\theme\byui-theme.ts
//
// The faculty + admin surfaces keep Fluent v9 for interactive form/data
// primitives (Input, Textarea, Dropdown, Switch, Slider, SpinButton,
// DataGrid). This theme retints Fluent's brand ramp so those controls match
// the design's BYU-Idaho Brand Blue (#006EB6) accent and use the Inter
// typeface, while the bespoke chrome (sidebar, cards, landing) is styled by
// globals.css tokens.
//
// The 16-stop BrandVariants ramp is anchored at `80: #006EB6` — Fluent maps
// `colorBrandBackground` to brand 80 — and lightens through #4F9ACF / #D6EBF7
// / #EFF7FC so it stays consistent with the --blue-* CSS tokens.

import {
  createLightTheme,
  type BrandVariants,
  type Theme,
} from '@fluentui/react-components';

const byuiBrand: BrandVariants = {
  10: '#020c13',
  20: '#06212f',
  30: '#08344a',
  40: '#0a4361',
  50: '#0b5179',
  60: '#006197',
  70: '#0068a9',
  80: '#006eb6',
  90: '#2c84c2',
  100: '#4a96cb',
  110: '#4f9acf',
  120: '#71afd9',
  130: '#94c4e3',
  140: '#b6d8ec',
  150: '#d6ebf7',
  160: '#eff7fc',
};

export const byuiLightTheme: Theme = {
  ...createLightTheme(byuiBrand),
  fontFamilyBase:
    "var(--font-inter), 'Inter', system-ui, -apple-system, sans-serif",
};
