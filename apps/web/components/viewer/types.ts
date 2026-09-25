// Wire shapes for the submission viewer — structural mirrors of the worker's
// /preview payloads (workers/grading-engine/src/preview-routes.ts). Client
// components keep local structural types per the app convention (the shared
// package root is server-only); the classification enum itself comes from the
// shared-safe classifier module.

import type { PreviewKind } from '../../lib/viewing/classify';

/** One attachment tab (metadata only — bytes stream separately). */
export type AttachmentInfo = {
  id: number;
  filename: string | null;
  displayName: string;
  size: number | null;
  contentType: string | null;
};

/** The /preview/submission descriptor: what the viewer renders for one student. */
export type SubmissionDescriptor = {
  userId: number;
  submissionType: string | null;
  late: boolean;
  submittedAt: string | null;
  url: string | null;
  /** Text-entry body, SANITIZED worker-side (never raw student HTML). */
  bodyHtml: string | null;
  attachments: AttachmentInfo[];
};

/** A server-built preview (C# AttachmentPreview): html for rich-html,
 * plainText for text, sheetNames for the table shell, error for unsupported. */
export type PreviewPayload = {
  kind: PreviewKind;
  html?: string;
  plainText?: string;
  warnings: string[];
  error?: string;
  sheetNames?: string[];
};

/** One rendered worksheet (C# SheetPreview). */
export type SheetGridPayload = {
  html: string | null;
  warnings: string[];
  error: string | null;
  truncated: boolean;
  hasFormulas: boolean;
};

/** Grid row caps (mirrors @aigrader/extraction's grid constants — display only). */
export const GRID_MAX_ROWS = 2000;
