import { prisma } from '@polymarket-bot/db';
import Link from 'next/link';

async function getDashboardData() {
  try {
    const [leaderCount, tradeCount, intentCount] = await Promise.all([
      prisma.leader.count(),
      prisma.trade.count(),
      prisma.paperIntent.count(),
    ]);
    return { leaderCount, tradeCount, intentCount, connected: true };
  } catch (error) {
    console.error('Database connection error:', error);
    return { leaderCount: 0, tradeCount: 0, intentCount: 0, connected: false };
  }
}

export default async function Home() {
  const data = await getDashboardData();

  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif', maxWidth: '1200px', margin: '0 auto' }}>
      <header style={{ marginBottom: '2rem', borderBottom: '1px solid #eee', paddingBottom: '1rem' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 600, color: '#1a1a1a' }}>
          📊 Polymarket Copy-Trader Dashboard
        </h1>
        <p style={{ color: '#666', marginTop: '0.5rem' }}>
          Paper trading dashboard for copy-trading Polymarket leaders
        </p>
      </header>

      {/* Database Status */}
      <div style={{
        padding: '1rem',
        marginBottom: '2rem',
        borderRadius: '8px',
        backgroundColor: data.connected ? '#d4edda' : '#f8d7da',
        border: `1px solid ${data.connected ? '#c3e6cb' : '#f5c6cb'}`
      }}>
        <strong>Database:</strong> {data.connected ? '✅ Connected' : '❌ Not Connected'}
      </div>

      {/* Stats Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '2rem' }}>
        <StatCard title="Leaders" value={data.leaderCount} href="/leaders" />
        <StatCard title="Trades" value={data.tradeCount} href="/trades" />
        <StatCard title="Paper Intents" value={data.intentCount} href="/paper" />
      </div>

      {/* Navigation */}
      <div style={{ marginTop: '2rem' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>Pages</h2>
        <nav style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          <NavLink href="/leaders">👥 Leaders</NavLink>
          <NavLink href="/trades">📈 Trades</NavLink>
          <NavLink href="/paper">📝 Paper</NavLink>
          <NavLink href="/metrics">📊 Metrics</NavLink>
          <NavLink href="/debug">🔧 Debug</NavLink>
        </nav>
      </div>
    </div>
  );
}

function StatCard({ title, value, href }: { title: string; value: number; href: string }) {
  return (
    <Link href={href} style={{ textDecoration: 'none' }}>
      <div style={{
        padding: '1.5rem',
        backgroundColor: '#f9fafb',
        borderRadius: '8px',
        border: '1px solid #e5e7eb',
        cursor: 'pointer',
        transition: 'all 0.2s',
      }}>
        <div style={{ fontSize: '0.875rem', color: '#6b7280', marginBottom: '0.5rem' }}>{title}</div>
        <div style={{ fontSize: '2rem', fontWeight: 700, color: '#1f2937' }}>{value}</div>
      </div>
    </Link>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} style={{
      padding: '0.75rem 1.5rem',
      backgroundColor: '#3b82f6',
      color: 'white',
      borderRadius: '6px',
      textDecoration: 'none',
      fontWeight: 500,
      transition: 'background-color 0.2s',
    }}>
      {children}
    </Link>
  );
}
