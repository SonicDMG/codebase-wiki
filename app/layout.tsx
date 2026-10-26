import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Wiki',
  description: 'Live, GitHub-grounded codebase wiki and Q&A',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
