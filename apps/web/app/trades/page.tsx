import { prisma } from '@polymarket-bot/db';
import Link from 'next/link';

interface TradesPageProps {
    searchParams: Promise<{ leader?: string }>;
}

async function getTrades(leaderFilter?: string) {
    return prisma.trade.findMany({
        where: leaderFilter ? { leaderId: leaderFilter } : undefined,
        include: {
            leader: {
                select: { label: true, wallet: true },
            },
        },
        orderBy: { tradeTs: 'desc' },
        take: 100, // Limit for performance
    });
}

async function getLeadersForFilter() {
    return prisma.leader.findMany({
        select: { id: true, label: true },
        orderBy: { label: 'asc' },
    });
}

export default async function TradesPage({ searchParams }: TradesPageProps) {
    const params = await searchParams;
    const leaderFilter = params.leader;

    const [trades, leaders] = await Promise.all([
        getTrades(leaderFilter),
        getLeadersForFilter(),
    ]);

    return (
        <div style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif', maxWidth: '1400px', margin: '0 auto' }}>
            {/* Header */}
            <div style={{ marginBottom: '1.5rem' }}>
                <Link href="/" style={{ color: '#3b82f6', textDecoration: 'none', fontSize: '0.875rem' }}>
                    ← Back to Dashboard
                </Link>
                <h1 style={{ fontSize: '1.75rem', fontWeight: 600, marginTop: '0.5rem' }}>
                    📈 Trades Timeline
                </h1>
                <p style={{ color: '#666' }}>
                    View leader trades ingested from Polymarket
                </p>
            </div>

            {/* Filters */}
            <div style={{
                padding: '1rem',
                backgroundColor: '#f9fafb',
                borderRadius: '8px',
                border: '1px solid #e5e7eb',
                marginBottom: '1.5rem',
                display: 'flex',
                gap: '1rem',
                alignItems: 'center',
            }}>
                <label style={{ fontWeight: 500, fontSize: '0.875rem' }}>Filter by Leader:</label>
                <form style={{ display: 'flex', gap: '0.5rem' }}>
                    <select
                        name="leader"
                        defaultValue={leaderFilter || ''}
                        style={{
                            padding: '0.5rem 0.75rem',
                            border: '1px solid #d1d5db',
                            borderRadius: '6px',
                            fontSize: '0.875rem',
                            minWidth: '200px',
                        }}
                    >
                        <option value="">All Leaders</option>
                        {leaders.map((leader) => (
                            <option key={leader.id} value={leader.id}>
                                {leader.label}
                            </option>
                        ))}
                    </select>
                    <button
                        type="submit"
                        style={{
                            padding: '0.5rem 1rem',
                            backgroundColor: '#3b82f6',
                            color: 'white',
                            border: 'none',
                            borderRadius: '6px',
                            fontWeight: 500,
                            cursor: 'pointer',
                        }}
                    >
                        Filter
                    </button>
                    {leaderFilter && (
                        <Link
                            href="/trades"
                            style={{
                                padding: '0.5rem 1rem',
                                backgroundColor: '#6b7280',
                                color: 'white',
                                borderRadius: '6px',
                                textDecoration: 'none',
                                fontWeight: 500,
                            }}
                        >
                            Clear
                        </Link>
                    )}
                </form>
                <div style={{ marginLeft: 'auto', fontSize: '0.875rem', color: '#6b7280' }}>
                    Showing {trades.length} trades
                </div>
            </div>

            {/* Trades Table */}
            {trades.length === 0 ? (
                <div style={{
                    padding: '3rem',
                    textAlign: 'center',
                    color: '#6b7280',
                    backgroundColor: '#f9fafb',
                    borderRadius: '8px',
                    border: '1px dashed #d1d5db',
                }}>
                    No trades found. Make sure the worker is running and leaders are enabled.
                </div>
            ) : (
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
                        <thead>
                            <tr style={{ backgroundColor: '#f3f4f6', textAlign: 'left' }}>
                                <th style={{ padding: '0.75rem', borderBottom: '1px solid #e5e7eb' }}>Time</th>
                                <th style={{ padding: '0.75rem', borderBottom: '1px solid #e5e7eb' }}>Leader</th>
                                <th style={{ padding: '0.75rem', borderBottom: '1px solid #e5e7eb' }}>Side</th>
                                <th style={{ padding: '0.75rem', borderBottom: '1px solid #e5e7eb' }}>Market / Outcome</th>
                                <th style={{ padding: '0.75rem', borderBottom: '1px solid #e5e7eb', textAlign: 'right' }}>Price</th>
                                <th style={{ padding: '0.75rem', borderBottom: '1px solid #e5e7eb', textAlign: 'right' }}>USDC</th>
                                <th style={{ padding: '0.75rem', borderBottom: '1px solid #e5e7eb', textAlign: 'right' }}>Size</th>
                                <th style={{ padding: '0.75rem', borderBottom: '1px solid #e5e7eb' }}>Latency</th>
                                <th style={{ padding: '0.75rem', borderBottom: '1px solid #e5e7eb' }}>Tx</th>
                            </tr>
                        </thead>
                        <tbody>
                            {trades.map((trade) => {
                                const latencyMs = trade.detectedAt.getTime() - trade.tradeTs.getTime();
                                const latencyDisplay = latencyMs < 1000
                                    ? `${latencyMs}ms`
                                    : latencyMs < 60000
                                        ? `${(latencyMs / 1000).toFixed(1)}s`
                                        : `${Math.round(latencyMs / 60000)}m`;

                                return (
                                    <tr key={trade.id} style={{ borderBottom: '1px solid #e5e7eb' }}>
                                        <td style={{ padding: '0.75rem', whiteSpace: 'nowrap' }}>
                                            <div>{new Date(trade.tradeTs).toLocaleDateString()}</div>
                                            <div style={{ color: '#6b7280', fontSize: '0.75rem' }}>
                                                {new Date(trade.tradeTs).toLocaleTimeString()}
                                            </div>
                                        </td>
                                        <td style={{ padding: '0.75rem' }}>
                                            <div style={{ fontWeight: 500 }}>{trade.leader.label}</div>
                                            <div style={{ color: '#6b7280', fontSize: '0.75rem', fontFamily: 'monospace' }}>
                                                {trade.leader.wallet.slice(0, 8)}...
                                            </div>
                                        </td>
                                        <td style={{ padding: '0.75rem' }}>
                                            <span style={{
                                                padding: '0.25rem 0.5rem',
                                                borderRadius: '4px',
                                                fontSize: '0.75rem',
                                                fontWeight: 600,
                                                backgroundColor: trade.side === 'BUY' ? '#d1fae5' : '#fee2e2',
                                                color: trade.side === 'BUY' ? '#065f46' : '#991b1b',
                                            }}>
                                                {trade.side}
                                            </span>
                                        </td>
                                        <td style={{ padding: '0.75rem', maxWidth: '250px' }}>
                                            <div style={{
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                                fontWeight: 500,
                                            }}>
                                                {trade.title || 'Unknown Market'}
                                            </div>
                                            <div style={{ color: '#6b7280', fontSize: '0.75rem' }}>
                                                {trade.outcome}
                                            </div>
                                        </td>
                                        <td style={{ padding: '0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>
                                            {Number(trade.leaderPrice).toFixed(4)}
                                        </td>
                                        <td style={{ padding: '0.75rem', textAlign: 'right', fontFamily: 'monospace', fontWeight: 500 }}>
                                            ${Number(trade.leaderUsdc).toFixed(2)}
                                        </td>
                                        <td style={{ padding: '0.75rem', textAlign: 'right', fontFamily: 'monospace', color: '#6b7280' }}>
                                            {Number(trade.leaderSize).toFixed(2)}
                                        </td>
                                        <td style={{ padding: '0.75rem' }}>
                                            <span style={{
                                                padding: '0.125rem 0.375rem',
                                                borderRadius: '4px',
                                                fontSize: '0.75rem',
                                                backgroundColor: latencyMs < 5000 ? '#d1fae5' : latencyMs < 30000 ? '#fef3c7' : '#fee2e2',
                                                color: latencyMs < 5000 ? '#065f46' : latencyMs < 30000 ? '#92400e' : '#991b1b',
                                            }}>
                                                {latencyDisplay}
                                            </span>
                                        </td>
                                        <td style={{ padding: '0.75rem' }}>
                                            <a
                                                href={`https://polygonscan.com/tx/${trade.txHash}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                style={{
                                                    color: '#3b82f6',
                                                    textDecoration: 'none',
                                                    fontFamily: 'monospace',
                                                    fontSize: '0.75rem',
                                                }}
                                            >
                                                {trade.txHash.slice(0, 10)}...
                                            </a>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
