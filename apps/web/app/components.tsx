'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function Sidebar() {
    const pathname = usePathname();

    const navItems = [
        { href: '/', label: 'Overview', icon: '📊' },
        { href: '/trades', label: 'Trades', icon: '📈' },
        { href: '/leaders', label: 'Leaders', icon: '👥' },
        { href: '/paper', label: 'Paper Trading', icon: '📝' },
        { href: '/metrics', label: 'Metrics', icon: '📉' },
        { href: '/debug', label: 'Debug', icon: '🔍' },
    ];

    return (
        <aside className="sidebar">
            <div className="sidebar-brand">
                <span>⚡</span> CopyBot
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
                v0.1.0 Alpha
            </div>
        </aside>
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
        <div className="card animate-fade-in">
            <div className="stat-label">{label}</div>
            <div className="stat-value" style={{ color }}>{value}</div>
            {subtitle && <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>{subtitle}</div>}
        </div>
    );
}
