'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function MobileLayout({ children, sidebar }: { children: React.ReactNode; sidebar: React.ReactNode }) {
    const [menuOpen, setMenuOpen] = useState(false);

    // Close menu on route change
    const pathname = usePathname();
    useEffect(() => {
        setMenuOpen(false);
    }, [pathname]);

    // Close menu when clicking outside
    useEffect(() => {
        const handleResize = () => {
            if (window.innerWidth > 768) {
                setMenuOpen(false);
            }
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    return (
        <>
            {/* Mobile header - visible only on mobile */}
            {/* Mobile header - visible only on mobile */}
            <header className="mobile-header" style={{ justifyContent: 'flex-start', gap: '1rem' }}>
                <button className="menu-toggle" onClick={() => setMenuOpen(!menuOpen)}>
                    {menuOpen ? '✕' : '☰'}
                </button>
                <span style={{ fontWeight: 600, fontSize: '1.2rem' }}>PolymarketSpy</span>
            </header>

            {/* Overlay for mobile */}
            <div
                className={`mobile-overlay ${menuOpen ? 'visible' : ''}`}
                onClick={() => setMenuOpen(false)}
            />

            {/* Sidebar with open/close state */}
            <div className={menuOpen ? 'sidebar open' : 'sidebar'}>
                {sidebar}
            </div>

            {/* Main content */}
            <main className="main-content">
                {children}
            </main>
        </>
    );
}

export function Sidebar() {
    const pathname = usePathname();

    const navItems = [
        { href: '/', label: 'Overview', icon: '📊' },
        { href: '/trades', label: 'Trades', icon: '📈' },
        { href: '/leaders', label: 'Leaders', icon: '👥' },
        { href: '/paper', label: 'Paper Trading', icon: '📝' },
        { href: '/pnl', label: 'P&L', icon: '💰' },
        { href: '/metrics', label: 'Metrics', icon: '📉' },
        { href: '/settings', label: 'Settings', icon: '⚙️' },
        { href: '/debug', label: 'Debug', icon: '🔍' },
    ];

    return (
        <>
            <div className="sidebar-brand">
                <span>📈</span> PolymarketSpy
            </div>
            <nav>
                {navItems.map((item) => (
                    <Link
                        key={item.href}
                        href={item.href}
                        className={`nav-item ${pathname === item.href ? 'active' : ''}`}
                    >
                        <span style={{ marginRight: '10px' }}>{item.icon}</span>
                        {item.label}
                    </Link>
                ))}
            </nav>
            <div style={{ marginTop: 'auto', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                v0.2.0
            </div>
        </>
    );
}

export function StatCard({
    label,
    value,
    color = 'var(--text-primary)',
    subtitle
}: {
    label: string;
    value: string | number;
    color?: string;
    subtitle?: string;
}) {
    return (
        <div className="card">
            <div className="stat-label">{label}</div>
            <div className="stat-value" style={{ color }}>{value}</div>
            {subtitle && <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '4px' }}>{subtitle}</div>}
        </div>
    );
}
