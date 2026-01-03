import { prisma } from '@polymarket-bot/db';
import { StatCard } from './components';

export const dynamic = 'force-dynamic';

async function getStats() {
  const [leaderCount, tradeCount, paperIntentCount] = await Promise.all([
    prisma.leader.count({ where: { enabled: true } }),
    prisma.trade.count(),
    prisma.paperIntent.count(),
  ]);

  return { leaderCount, tradeCount, paperIntentCount };
}

async function checkDbConnection() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (e) {
    return false;
  }
}

export default async function DashboardPage() {
  const isConnected = await checkDbConnection();
  const stats = await getStats();

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <h1 className="page-title">Dashboard Overview</h1>
        <p className="page-subtitle">Welcome to your copy trading control center</p>
      </div>

      <div className="mb-4">
        {isConnected ? (
          <div className="badge badge-green">
            Database: Connected
          </div>
        ) : (
          <div className="badge badge-red">
            Database: Not Connected
          </div>
        )}
      </div>

      <div className="grid-cols-3">
        <StatCard
          label="Active Leaders"
          value={stats.leaderCount}
          color="var(--accent-secondary)"
          subtitle="Monitored for trades"
        />
        <StatCard
          label="Total Trades"
          value={stats.tradeCount}
          color="var(--text-primary)"
          subtitle="Ingested from API"
        />
        <StatCard
          label="Paper Intents"
          value={stats.paperIntentCount}
          color="var(--accent-primary)"
          subtitle="Simulated decisions"
        />
      </div>

      <div className="mt-4 card">
        <h3 style={{ marginBottom: '1rem' }}>System Status</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
          <div>
            <div className="stat-label">Worker Status</div>
            <div style={{ marginTop: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: '#3fb950', display: 'block' }}></span>
              Running
            </div>
          </div>
          <div>
            <div className="stat-label">Last Update</div>
            <div style={{ marginTop: '0.25rem' }}>{new Date().toLocaleTimeString()}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
