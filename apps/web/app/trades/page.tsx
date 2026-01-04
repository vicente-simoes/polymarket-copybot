import { prisma } from '@polymarket-bot/db';
import Link from 'next/link';
import { StatCard } from '../components';

interface TradesPageProps {
    searchParams: Promise<{ leader?: string; showHistorical?: string }>;
}

async function getTrades(leaderId?: string, showHistorical: boolean = false) {
    return prisma.trade.findMany({
        where: {
            ...(leaderId && { leaderId }),
            // By default, filter out backfill/historical trades
            ...(!showHistorical && { isBackfill: false }),
        },
        include: {
            leader: {
                select: { label: true, wallet: true },
            },
            paperIntents: {
                select: { id: true }, // just check existence
            },
        },
        orderBy: { tradeTs: 'desc' },
        take: 100,
    });
}

async function getLeaders() {
    return prisma.leader.findMany({
        select: { id: true, label: true },
        orderBy: { label: 'asc' },
    });
}

export default async function TradesPage({ searchParams }: TradesPageProps) {
    const params = await searchParams;
    const selectedLeaderId = params.leader;
    const showHistorical = params.showHistorical === 'true';

    const [trades, leaders] = await Promise.all([
        getTrades(selectedLeaderId, showHistorical),
        getLeaders(),
    ]);

    return (
        <div className="animate-fade-in">
            <div className="page-header">
                <h1 className="page-title">Trade Ingestion</h1>
                <p className="page-subtitle">Real-time trade feed from monitored wallets</p>
            </div>

            <div className="card mb-4" style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                <div style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>Filter by Leader:</div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <Link
                        href={showHistorical ? '/trades?showHistorical=true' : '/trades'}
                        className={`badge ${!selectedLeaderId ? 'badge-blue' : 'badge-gray'}`}
                        style={{ textDecoration: 'none', cursor: 'pointer' }}
                    >
                        All
                    </Link>
                    {leaders.map(l => (
                        <Link
                            key={l.id}
                            href={`/trades?leader=${l.id}${showHistorical ? '&showHistorical=true' : ''}`}
                            className={`badge ${selectedLeaderId === l.id ? 'badge-blue' : 'badge-gray'}`}
                            style={{ textDecoration: 'none', cursor: 'pointer' }}
                        >
                            {l.label}
                        </Link>
                    ))}
                </div>
                <div style={{ marginLeft: 'auto' }}>
                    <Link
                        href={showHistorical ? `/trades${selectedLeaderId ? `?leader=${selectedLeaderId}` : ''}` : `/trades?showHistorical=true${selectedLeaderId ? `&leader=${selectedLeaderId}` : ''}`}
                        className={`badge ${showHistorical ? 'badge-yellow' : 'badge-gray'}`}
                        style={{ textDecoration: 'none', cursor: 'pointer' }}
                    >
                        {showHistorical ? '✓ Showing Historical' : 'Show Historical'}
                    </Link>
                </div>
            </div>

            <div className="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Time</th>
                            <th>Leader</th>
                            <th>Market</th>
                            <th>Side</th>
                            <th className="text-right">Price</th>
                            <th className="text-right">USDC</th>
                            <th className="text-right">Size</th>
                            <th className="text-right">Latency</th>
                            <th className="text-right">Tx</th>
                        </tr>
                    </thead>
                    <tbody>
                        {trades.length === 0 ? (
                            <tr>
                                <td colSpan={9} className="text-center" style={{ padding: '3rem', color: 'var(--text-muted)' }}>
                                    No trades found.
                                </td>
                            </tr>
                        ) : (
                            trades.map(trade => {
                                const latency = trade.detectedAt.getTime() - trade.tradeTs.getTime();
                                const latencyColor = latency < 2000 ? 'var(--success-text)' : latency < 5000 ? 'var(--warn-text)' : 'var(--error-text)';

                                return (
                                    <tr key={trade.id}>
                                        <td>
                                            <div>{new Date(trade.tradeTs).toLocaleTimeString()}</div>
                                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                                {new Date(trade.tradeTs).toLocaleDateString()}
                                            </div>
                                        </td>
                                        <td>
                                            <div style={{ fontWeight: 500 }}>{trade.leader.label}</div>
                                            <div className="code-mono" style={{ fontSize: '0.75rem' }}>
                                                {trade.leader.wallet.substring(0, 6)}...
                                            </div>
                                        </td>
                                        <td style={{ maxWidth: '300px' }}>
                                            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={trade.title || ''}>
                                                {trade.title || 'Unknown Market'}
                                            </div>
                                            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                                {trade.outcome}
                                            </div>
                                        </td>
                                        <td>
                                            <span className={`badge ${trade.side === 'BUY' ? 'badge-green' : 'badge-red'}`}>
                                                {trade.side}
                                            </span>
                                            {trade.isBackfill && (
                                                <span className="badge badge-gray" style={{ marginLeft: '0.25rem', fontSize: '0.65rem' }}>
                                                    Historical
                                                </span>
                                            )}
                                        </td>
                                        <td className="text-right code-mono">
                                            {Number(trade.leaderPrice).toFixed(3)}
                                        </td>
                                        <td className="text-right code-mono" style={{ fontWeight: 600 }}>
                                            ${Number(trade.leaderUsdc).toFixed(2)}
                                        </td>
                                        <td className="text-right code-mono" style={{ color: 'var(--text-muted)' }}>
                                            {Number(trade.leaderSize).toFixed(1)}
                                        </td>
                                        <td className="text-right" style={{ color: latencyColor, fontWeight: 500 }}>
                                            {latency}ms
                                        </td>
                                        <td className="text-right">
                                            <a
                                                href={`https://polygonscan.com/tx/${trade.txHash}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="badge badge-gray"
                                                style={{ textDecoration: 'none' }}
                                            >
                                                Scan ↗
                                            </a>
                                        </td>
                                    </tr>
                                );
                            })
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
