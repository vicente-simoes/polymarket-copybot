import { prisma } from '@polymarket-bot/db';
import Link from 'next/link';
import { StatCard } from '../components';

async function getMetrics() {
    // Get all paper intents with fills
    const intents = await prisma.paperIntent.findMany({
        include: {
            paperFill: true,
            trade: {
                include: { leader: { select: { id: true, label: true } } },
            },
        },
    });

    // Calculate overall metrics
    const tradeDecisions = intents.filter(i => i.decision === 'TRADE');
    const skipDecisions = intents.filter(i => i.decision === 'SKIP');
    const filledTrades = tradeDecisions.filter(i => i.paperFill?.filled);
    const matchedPrice = tradeDecisions.filter(i => i.paperFill?.matchSamePrice);

    // Slippage calculations
    const slippages = filledTrades
        .map(i => i.paperFill?.slippagePct ? Number(i.paperFill.slippagePct) * 100 : null)
        .filter((s): s is number => s !== null);

    const avgSlippage = slippages.length > 0 ? slippages.reduce((a, b) => a + b, 0) / slippages.length : 0;
    const worstSlippage = slippages.length > 0 ? Math.max(...slippages) : 0;
    const bestSlippage = slippages.length > 0 ? Math.min(...slippages) : 0;

    // Total USDC
    const totalUsdcCopied = filledTrades.reduce((sum, i) => sum + Number(i.yourUsdcTarget), 0);
    const totalUsdcSkipped = skipDecisions.reduce((sum, i) => sum + Number(i.yourUsdcTarget), 0);

    // By leader breakdown
    const leaderMap = new Map<string, { label: string; trades: number; skips: number; filled: number; usdc: number }>();
    for (const intent of intents) {
        const leaderId = intent.trade.leader.id;
        const label = intent.trade.leader.label;
        if (!leaderMap.has(leaderId)) {
            leaderMap.set(leaderId, { label, trades: 0, skips: 0, filled: 0, usdc: 0 });
        }
        const stats = leaderMap.get(leaderId)!;
        if (intent.decision === 'TRADE') {
            stats.trades++;
            if (intent.paperFill?.filled) {
                stats.filled++;
                stats.usdc += Number(intent.yourUsdcTarget);
            }
        } else {
            stats.skips++;
        }
    }

    // Skip reason breakdown
    const skipReasons = new Map<string, number>();
    for (const intent of skipDecisions) {
        const reason = intent.decisionReason;
        skipReasons.set(reason, (skipReasons.get(reason) || 0) + 1);
    }

    return {
        overview: {
            total: intents.length,
            tradeDecisions: tradeDecisions.length,
            skipDecisions: skipDecisions.length,
            filledTrades: filledTrades.length,
            matchedPrice: matchedPrice.length,
            matchRate: tradeDecisions.length > 0 ? (matchedPrice.length / tradeDecisions.length) * 100 : 0,
            fillRate: tradeDecisions.length > 0 ? (filledTrades.length / tradeDecisions.length) * 100 : 0,
            avgSlippage,
            worstSlippage,
            bestSlippage,
            totalUsdcCopied,
            totalUsdcSkipped,
        },
        byLeader: Array.from(leaderMap.entries()).map(([id, stats]) => ({ id, ...stats })),
        skipReasons: Array.from(skipReasons.entries()).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    };
}

export default async function MetricsPage() {
    const metrics = await getMetrics();

    return (
        <div className="animate-fade-in">
            <div className="page-header">
                <h1 className="page-title">Performance Metrics</h1>
                <p className="page-subtitle">Detailed analysis of paper trading results</p>
            </div>

            <div className="mb-8">
                <h2 className="mb-4" style={{ fontSize: '1.25rem' }}>Overview</h2>
                <div className="grid-cols-4">
                    <StatCard label="Total Intents" value={metrics.overview.total} />
                    <StatCard label="Trade Decisions" value={metrics.overview.tradeDecisions} color="var(--accent-secondary)" />
                    <StatCard label="Skip Decisions" value={metrics.overview.skipDecisions} color="var(--accent-warning)" />
                    <StatCard label="Filled Trades" value={metrics.overview.filledTrades} color="var(--success-text)" />
                </div>
            </div>

            <div className="mb-8">
                <h2 className="mb-4" style={{ fontSize: '1.25rem' }}>Execution Quality</h2>
                <div className="grid-cols-4">
                    <StatCard
                        label="Match Rate"
                        value={`${metrics.overview.matchRate.toFixed(1)}%`}
                        subtitle="Same-price matches"
                        color={metrics.overview.matchRate >= 80 ? 'var(--success-text)' : metrics.overview.matchRate >= 50 ? 'var(--warn-text)' : 'var(--error-text)'}
                    />
                    <StatCard
                        label="Fill Rate"
                        value={`${metrics.overview.fillRate.toFixed(1)}%`}
                        subtitle="Successfully filled"
                        color={metrics.overview.fillRate >= 80 ? 'var(--success-text)' : metrics.overview.fillRate >= 50 ? 'var(--warn-text)' : 'var(--error-text)'}
                    />
                    <StatCard
                        label="Avg Slippage"
                        value={`${metrics.overview.avgSlippage >= 0 ? '+' : ''}${metrics.overview.avgSlippage.toFixed(2)}%`}
                        subtitle="When filled"
                        color={metrics.overview.avgSlippage > 1 ? 'var(--error-text)' : metrics.overview.avgSlippage > 0 ? 'var(--warn-text)' : 'var(--success-text)'}
                    />
                    <StatCard
                        label="Worst Slippage"
                        value={`${metrics.overview.worstSlippage >= 0 ? '+' : ''}${metrics.overview.worstSlippage.toFixed(2)}%`}
                        color="var(--error-text)"
                    />
                </div>
            </div>

            <div className="mb-8">
                <h2 className="mb-4" style={{ fontSize: '1.25rem' }}>Capital Flow</h2>
                <div className="grid-cols-2">
                    <StatCard
                        label="Total Copied USDC"
                        value={`$${metrics.overview.totalUsdcCopied.toFixed(2)}`}
                        subtitle="Paper traded volume"
                        color="var(--success-text)"
                    />
                    <StatCard
                        label="Total Skipped USDC"
                        value={`$${metrics.overview.totalUsdcSkipped.toFixed(2)}`}
                        subtitle="Filtered out volume"
                        color="var(--text-secondary)"
                    />
                </div>
            </div>

            {metrics.byLeader.length > 0 && (
                <div className="mb-8">
                    <h2 className="mb-4" style={{ fontSize: '1.25rem' }}>Leader Performance</h2>
                    <div className="table-container">
                        <table>
                            <thead>
                                <tr>
                                    <th>Leader</th>
                                    <th className="text-right">Trades</th>
                                    <th className="text-right">Filled</th>
                                    <th className="text-right">Skips</th>
                                    <th className="text-right">Fill Rate</th>
                                    <th className="text-right">Volume (USDC)</th>
                                </tr>
                            </thead>
                            <tbody>
                                {metrics.byLeader.map(leader => (
                                    <tr key={leader.id}>
                                        <td style={{ fontWeight: 500 }}>{leader.label}</td>
                                        <td className="text-right">{leader.trades}</td>
                                        <td className="text-right">{leader.filled}</td>
                                        <td className="text-right">{leader.skips}</td>
                                        <td className="text-right">
                                            {leader.trades > 0 ? (
                                                <span className={`badge ${(leader.filled / leader.trades) >= 0.8 ? 'badge-green' :
                                                        (leader.filled / leader.trades) >= 0.5 ? 'badge-yellow' : 'badge-red'
                                                    }`}>
                                                    {((leader.filled / leader.trades) * 100).toFixed(0)}%
                                                </span>
                                            ) : '-'}
                                        </td>
                                        <td className="text-right code-mono" style={{ color: 'var(--success-text)' }}>
                                            ${leader.usdc.toFixed(2)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {metrics.skipReasons.length > 0 && (
                <div>
                    <h2 className="mb-4" style={{ fontSize: '1.25rem' }}>Skip Reasons</h2>
                    <div className="card">
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                            {metrics.skipReasons.map(({ reason, count }) => (
                                <div key={reason} className="badge badge-yellow" style={{ fontSize: '0.9rem', padding: '0.5rem 1rem' }}>
                                    {reason}: <strong style={{ marginLeft: '0.5rem' }}>{count}</strong>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {metrics.overview.total === 0 && (
                <div className="card text-center" style={{ padding: '4rem', color: 'var(--text-muted)' }}>
                    No metrics available. Start the worker to process trades and generate data.
                </div>
            )}
        </div>
    );
}
