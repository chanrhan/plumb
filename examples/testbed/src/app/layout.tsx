import type { ReactNode } from 'react';

export const metadata = {
  title: 'Plumb testbed',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
