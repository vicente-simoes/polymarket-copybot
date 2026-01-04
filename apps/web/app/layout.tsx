import type { Metadata } from 'next';
import './globals.css';
import { MobileLayout, Sidebar } from './components';

export const metadata: Metadata = {
  title: 'Polymarketpy',
  description: 'Paper copy trading system for Polymarket',
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
          <MobileLayout sidebar={<Sidebar />}>
            {children}
          </MobileLayout>
        </div>
      </body>
    </html>
  );
}
