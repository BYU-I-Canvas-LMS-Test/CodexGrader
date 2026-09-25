// Ported from: C:\Devs\AIgrader\app\lti\_components\icons.tsx
// Centralized icon library for the faculty dashboard. Tiny stroke icons
// (Lucide-style) drawn inline — pure SVG, safe from server or client
// components.

import * as React from 'react';

export type IconProps = {
  w?: number;
  h?: number;
  fill?: string;
  stroke?: string;
  sw?: number;
  vb?: string;
  className?: string;
};

function Ico({
  w = 18,
  h = 18,
  fill = 'none',
  stroke = 'currentColor',
  sw = 2,
  vb = '0 0 24 24',
  className,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={w}
      height={h}
      viewBox={vb}
      fill={fill}
      stroke={stroke}
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {children}
    </svg>
  );
}

export const I = {
  Home: (p: IconProps) => (
    <Ico {...p}>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5 10v10h14V10" />
      <path d="M10 20v-6h4v6" />
    </Ico>
  ),
  Doc: (p: IconProps) => (
    <Ico {...p}>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 8h6M9 12h6M9 16h4" />
    </Ico>
  ),
  Users: (p: IconProps) => (
    <Ico {...p}>
      <circle cx="9" cy="9" r="3.2" />
      <path d="M3 19c.6-3.2 3.2-5 6-5s5.4 1.8 6 5" />
      <circle cx="17" cy="8" r="2.5" />
      <path d="M21 18c-.3-2-1.6-3.4-3.5-3.9" />
    </Ico>
  ),
  Target: (p: IconProps) => (
    <Ico {...p}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
    </Ico>
  ),
  Shield: (p: IconProps) => (
    <Ico {...p}>
      <path d="M12 3 4 6v6c0 4.5 3.2 8.3 8 9 4.8-.7 8-4.5 8-9V6l-8-3z" />
      <path d="m9 12 2 2 4-4" />
    </Ico>
  ),
  Bars: (p: IconProps) => (
    <Ico {...p}>
      <path d="M4 20V10M10 20V4M16 20v-8M22 20h-20" />
    </Ico>
  ),
  Help: (p: IconProps) => (
    <Ico {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 0 1 5 0c0 1.7-2.5 2-2.5 4" />
      <circle cx="12" cy="17" r="0.8" fill="currentColor" />
    </Ico>
  ),
  Chevron: (p: IconProps) => (
    <Ico {...p}>
      <path d="m9 6 6 6-6 6" />
    </Ico>
  ),
  ChevDown: (p: IconProps) => (
    <Ico {...p}>
      <path d="m6 9 6 6 6-6" />
    </Ico>
  ),
  ChevLeft: (p: IconProps) => (
    <Ico {...p}>
      <path d="m15 18-6-6 6-6" />
    </Ico>
  ),
  ArrowRight: (p: IconProps) => (
    <Ico {...p}>
      <path d="M5 12h14M13 5l7 7-7 7" />
    </Ico>
  ),
  ArrowLeft: (p: IconProps) => (
    <Ico {...p}>
      <path d="M19 12H5M11 5 4 12l7 7" />
    </Ico>
  ),
  Refresh: (p: IconProps) => (
    <Ico {...p}>
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v5h-5" />
    </Ico>
  ),
  Sparkle: (p: IconProps) => (
    <Ico {...p}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
    </Ico>
  ),
  Search: (p: IconProps) => (
    <Ico {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Ico>
  ),
  Check: (p: IconProps) => (
    <Ico {...p}>
      <path d="m5 12 5 5 10-11" />
    </Ico>
  ),
  CheckCirc: (p: IconProps) => (
    <Ico {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-6" />
    </Ico>
  ),
  Warn: (p: IconProps) => (
    <Ico {...p}>
      <path d="M12 3 2 21h20Z" />
      <path d="M12 10v5M12 18v.5" />
    </Ico>
  ),
  Info: (p: IconProps) => (
    <Ico {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 10.5v5.5M12 7.5v.5" />
    </Ico>
  ),
  External: (p: IconProps) => (
    <Ico {...p}>
      <path d="M14 4h6v6" />
      <path d="M10 14 20 4" />
      <path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6" />
    </Ico>
  ),
  Trash: (p: IconProps) => (
    <Ico {...p}>
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
    </Ico>
  ),
  Plus: (p: IconProps) => (
    <Ico {...p}>
      <path d="M12 5v14M5 12h14" />
    </Ico>
  ),
  Download: (p: IconProps) => (
    <Ico {...p}>
      <path d="M12 4v12M7 11l5 5 5-5M5 20h14" />
    </Ico>
  ),
  Clock: (p: IconProps) => (
    <Ico {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Ico>
  ),
  List: (p: IconProps) => (
    <Ico {...p}>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <circle cx="4" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="18" r="1" fill="currentColor" stroke="none" />
    </Ico>
  ),
  Send: (p: IconProps) => (
    <Ico {...p}>
      <path d="m4 12 16-8-6 16-2-7z" />
    </Ico>
  ),
  Canvas: (p: IconProps) => (
    <Ico {...p}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" />
    </Ico>
  ),
  Smile: (p: IconProps) => (
    <Ico {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <circle cx="9" cy="10" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="15" cy="10" r="0.6" fill="currentColor" stroke="none" />
    </Ico>
  ),
};
