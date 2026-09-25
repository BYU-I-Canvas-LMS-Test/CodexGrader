// Ported from: C:\Devs\AIgrader\app\lti\_components\ui.tsx
// Shared presentational primitives for the faculty screens. Pure CSS/SVG —
// safe to render from server or client components. Styling lives in
// globals.css.

import * as React from 'react';
import Link from 'next/link';
import { I } from './icons';

export type Crumb = { label: string; href?: string };

export function PageHead({
  crumbs,
  title,
  sub,
  sparkle = false,
  action,
}: {
  crumbs: Crumb[];
  title: React.ReactNode;
  sub?: React.ReactNode;
  sparkle?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="crumbs">
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="sep">/</span>}
            {c.href ? (
              <Link href={c.href}>{c.label}</Link>
            ) : (
              <span className={i === crumbs.length - 1 ? 'here' : undefined}>
                {c.label}
              </span>
            )}
          </React.Fragment>
        ))}
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          gap: 24,
        }}
      >
        <div>
          <h1 className="page-title">
            {title}
            {sparkle && <I.Sparkle w={26} h={26} stroke="var(--blue-500)" />}
          </h1>
          {sub ? <p className="page-sub">{sub}</p> : null}
        </div>
        {action}
      </div>
    </div>
  );
}

export function InfoBanner({
  children,
  action,
  icon,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="info-banner">
      <div className="left">
        <span className="icon">{icon ?? <I.Info w={18} h={18} />}</span>
        {children}
      </div>
      {action}
    </div>
  );
}

/** Red-toned InfoBanner variant for errors (the ported views styled this
 * inline everywhere; centralized here). */
export function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="info-banner"
      style={{ borderColor: '#FCA5A5', background: 'var(--red-100)' }}
    >
      <div className="left">
        <span className="icon" style={{ color: 'var(--red-600)' }}>
          <I.Warn w={18} h={18} />
        </span>
        {children}
      </div>
    </div>
  );
}

export type IconCircClass = 'blue' | 'green' | 'amber' | 'purple';

// ---- Donut ring (Dashboard + Outcomes) ----
export function Donut({
  pct,
  color = 'var(--green-500)',
  size = 56,
  stroke = 6,
}: {
  pct: number;
  color?: string;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const off = c * (1 - pct / 100);
  return (
    <svg width={size} height={size} className="donut" role="img" aria-label={`${pct}%`}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke="var(--ink-200)"
        strokeWidth={stroke}
        fill="none"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={color}
        strokeWidth={stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={off}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

// ---- Stat tile (Dashboard) ----
export function Stat({
  icon,
  iconClass,
  label,
  value,
  meta,
  extra,
}: {
  icon: React.ReactNode;
  iconClass: IconCircClass;
  label: string;
  value: React.ReactNode;
  meta: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-row">
        <div>
          <div className="stat-value">{value}</div>
          <div className="stat-meta">{meta}</div>
        </div>
        <div className={'icon-circ ' + iconClass}>{icon}</div>
      </div>
      {extra && <div style={{ marginTop: 4 }}>{extra}</div>}
    </div>
  );
}

export function StatDonut({
  label,
  value,
  meta,
  pct,
}: {
  label: string;
  value: string;
  meta: string;
  pct: number;
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-row">
        <div>
          <div className="stat-value">{value}</div>
          <div
            className="stat-meta"
            style={{ color: 'var(--green-600)', fontWeight: 600 }}
          >
            {meta}
          </div>
        </div>
        <Donut pct={pct} />
      </div>
    </div>
  );
}

// ---- BigStat (Assignments summary) ----
export function BigStat({
  icon,
  iconClass,
  value,
  label,
  sub,
}: {
  icon: React.ReactNode;
  iconClass: IconCircClass;
  value: React.ReactNode;
  label: string;
  sub: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 14px' }}>
      <div className={'icon-circ ' + iconClass} style={{ width: 52, height: 52 }}>
        {icon}
      </div>
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em' }}>
            {value}
          </span>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-700)' }}>
            {label}
          </span>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--ink-500)', marginTop: 2 }}>{sub}</div>
      </div>
    </div>
  );
}

// ---- Steps (Dashboard get-started) ----
export function Step({
  n,
  active = false,
  title,
  body,
}: {
  n: string;
  active?: boolean;
  title: string;
  body: string;
}) {
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
      <div className={'step-num ' + (active ? 'active' : 'pending')}>{n}</div>
      <div>
        <div style={{ fontWeight: 600, fontSize: 15 }}>{title}</div>
        <div
          style={{
            color: 'var(--ink-500)',
            fontSize: 13,
            marginTop: 4,
            maxWidth: 200,
            lineHeight: 1.45,
          }}
        >
          {body}
        </div>
      </div>
    </div>
  );
}

export function Dots() {
  return <div className="step-dots">— — — —</div>;
}

// ---- Prepare step tracker ----
export function PrepStep({
  n,
  title,
  sub,
  active = false,
}: {
  n: string;
  title: string;
  sub: string;
  active?: boolean;
}) {
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
      <div className={'step-num ' + (active ? 'active' : 'pending')}>{n}</div>
      <div>
        <div
          style={{
            fontWeight: 600,
            fontSize: 15,
            color: active ? 'var(--blue-600)' : 'var(--ink-700)',
          }}
        >
          {title}
        </div>
        <div style={{ color: 'var(--ink-500)', fontSize: 12.5, marginTop: 4 }}>{sub}</div>
      </div>
    </div>
  );
}

// ---- Field (label/value pair) ----
export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 12.5,
          color: 'var(--ink-500)',
          fontWeight: 500,
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 14, color: 'var(--ink-800)', fontWeight: 500 }}>
        {children}
      </div>
    </div>
  );
}
