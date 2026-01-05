import type { Metadata } from 'next'
import './globals.css'
import { Sidebar } from '@/components/sidebar'
import { MobileHeader } from '@/components/mobile-header'
import { TooltipProvider } from '@/components/ui/tooltip'

export const metadata: Metadata = {
  title: 'PolymarketSpy',
  description: 'Paper copy trading system for Polymarket',
  icons: {
    icon: '/logo6.png',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">
        <TooltipProvider>
          {/* Mobile Header - visible only on mobile */}
          <MobileHeader />

          {/* Main Layout */}
          <div className="flex min-h-screen">
            {/* Desktop Sidebar - hidden on mobile */}
            <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 lg:border-r lg:border-border">
              <Sidebar />
            </aside>

            {/* Main Content */}
            <main className="flex-1 lg:pl-64">
              <div className="mx-auto max-w-7xl">
                {children}
              </div>
            </main>
          </div>
        </TooltipProvider>
      </body>
    </html>
  )
}
