'use client'

import Link from 'next/link'
import Image from 'next/image'
import { usePathname } from 'next/navigation'
import {
    LayoutDashboard,
    TrendingUp,
    Users,
    FileText,
    DollarSign,
    BarChart3,
    Settings,
    Bug,
    TrendingDown,
    Zap
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'

const navItems = [
    { href: '/', label: 'Overview', icon: LayoutDashboard },
    { href: '/trades', label: 'Trades', icon: TrendingUp },
    { href: '/leaders', label: 'Leaders', icon: Users },
    { href: '/paper', label: 'Paper Trading', icon: FileText },
    { href: '/pnl', label: 'P&L', icon: DollarSign },
    { href: '/metrics', label: 'Metrics', icon: BarChart3 },
    { href: '/latency', label: 'Latency', icon: Zap },
    { href: '/settings', label: 'Settings', icon: Settings },
    { href: '/debug', label: 'Debug', icon: Bug },
]

export function Sidebar({ className }: { className?: string }) {
    const pathname = usePathname()

    return (
        <div className={cn("flex h-full flex-col bg-sidebar", className)}>
            {/* Brand */}
            <div className="flex h-14 items-center px-4 border-b border-sidebar-border">
                <Link href="/" className="flex items-center gap-2">
                    <div className="relative size-8 flex items-center justify-center">
                        <Image
                            src="/logo5.png"
                            alt="PolymarketSpy Logo"
                            width={32}
                            height={32}
                            className="object-contain"
                        />
                    </div>
                    <span className="text-lg font-bold text-sidebar-foreground">
                        PolymarketSpy
                    </span>
                </Link>
            </div>

            {/* Navigation */}
            <ScrollArea className="flex-1 px-3 py-4">
                <nav className="flex flex-col gap-1">
                    {navItems.map((item) => {
                        const isActive = pathname === item.href
                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                className={cn(
                                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                                    isActive
                                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                        : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                                )}
                            >
                                <item.icon className="size-4" />
                                {item.label}
                            </Link>
                        )
                    })}
                </nav>
            </ScrollArea>

            {/* Footer */}
            <Separator className="bg-sidebar-border" />
            <div className="p-4">
                <div className="text-xs text-sidebar-foreground/50">
                    PolymarketSpy
                </div>
            </div>
        </div>
    )
}
