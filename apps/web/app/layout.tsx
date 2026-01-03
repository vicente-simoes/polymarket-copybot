import type { Metadata } from 'next';
import './globals.css';
import { Sidebar } from './components';

export const metadata: Metadata = {
  title: 'Polymarket CopyBot',
  description: 'Automated copy trading system',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>
        <div className="layout-container">
          <Sidebar />
          <main className="main-content">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
