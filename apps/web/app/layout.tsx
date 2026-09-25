import type { Metadata } from 'next';
import './globals.css';

// Fonts: the system UI stacks (defined as --font-* tokens in globals.css).
// No web-font download — `next build` must work offline, and the review page
// runs on 127.0.0.1 with no third-party requests.

export const metadata: Metadata = {
  title: 'BYU-(A)I Grader',
  description:
    'AI-assisted, rubric-aligned grading for BYU-Idaho Canvas courses. The AI drafts; you review and approve every grade before anything posts.',
  icons: [{ rel: 'icon', url: '/aigrader-white-square.png', type: 'image/png' }],
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
