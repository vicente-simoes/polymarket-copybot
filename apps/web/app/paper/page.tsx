import { prisma } from '@polymarket-bot/db';
import Link from 'next/link';
import { StatCard } from '../components';

interface PaperPageProps {
    searchParams: Promise<{
        leader?: string;
        decision?: string;
        filled?: string;
    }>;
}

async function getPaperIntents(filters: {
    leader?: string;
    decision?: string;
    filled?: string;
}) {
    return prisma.paperIntent.findMany({
        where: {
            // Exclude paper intents for backfill trades (historical)
            trade: {
                isBackfill: false,
                ...(filters.leader && { leaderId: filters.leader }),
            },
            ...(filters.decision && { decision: filters.decision as 'TRADE' | 'SKIP' }),
            ...(filters.filled !== undefined && filters.filled !== '' && {
                paperFill: {
                    filled: filters.filled === 'true',
                },
            }),
        },
        include: {
            trade: {
                include: {
                    leader: { select: { label: true } },
                },
            },
            paperFill: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
    });
}

async function getLeadersForFilter() {
    return prisma.leader.findMany({
        select: { id: true, label: true },
        orderBy: { label: 'asc' },
    });
}

export default async function PaperPage({ searchParams }: PaperPageProps) {
    const params = await searchParams;

    const [intents, leaders] = await Promise.all([
        getPaperIntents(params),
        getLeadersForFilter(),
    ]);

    const stats = {
        total: intents.length,
        trades: intents.filter(i => i.decision === 'TRADE').length,
        skips: intents.filter(i => i.decision === 'SKIP').length,
        filled: intents.filter(i => i.paperFill?.filled).length,
        notFilled: intents.filter(i => i.paperFill && !i.paperFill.filled).length,
    };

    return (
        <div className="animate-fade-in">
            <div className="page-header">
                <h1 className="page-title">Paper Trading Results</h1>
                <p className="page-subtitle">Simulated decisions and execution results</p>
            </div>

            <div className="grid-cols-5 mb-4">
                <StatCard label="Total" value={stats.total} color="var(--text-secondary)" />
                <StatCard label="TRADE" value={stats.trades} color="var(--accent-secondary)" />
                <StatCard label="SKIP" value={stats.skips} color="var(--accent-warning)" />
                <StatCard label="Filled" value={stats.filled} color="var(--success-text)" />
                <StatCard label="Not Filled" value={stats.notFilled} color="var(--error-text)" />
            </div>

            <div className="card mb-4">
                <form style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <div>
                        <label className="stat-label" style={{ display: 'block', marginBottom: '0.5rem' }}>Leader</label>
                        <select name="leader" defaultValue={params.leader || ''} className="input-field" style={{ minWidth: 150 }}>
                            <option value="">All Leaders</option>
                            {leaders.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
                        </select>
                    </div>
                    <div>
                        <label className="stat-label" style={{ display: 'block', marginBottom: '0.5rem' }}>Decision</label>
                        <select name="decision" defaultValue={params.decision || ''} className="input-field" style={{ minWidth: 150 }}>
                            <option value="">All Decisions</option>
                            <option value="TRADE">TRADE</option>
                            <option value="SKIP">SKIP</option>
                        </select>
                    </div>
                    <div>
                        <label className="stat-label" style={{ display: 'block', marginBottom: '0.5rem' }}>Filled Status</label>
                        <select name="filled" defaultValue={params.filled || ''} className="input-field" style={{ minWidth: 150 }}>
                            <option value="">All Statuses</option>
                            <option value="true">Filled</option>
                            <option value="false">Not Filled</option>
                        </select>
                    </div>
                    <button type="submit" className="btn btn-primary">Filter Results</button>
                    <Link href="/paper" className="btn btn-secondary">Clear</Link>
                </form>
            </div>

            <div className="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Time</th>
                            <th>Leader</th>
                            <th>Market</th>
                            <th>Side</th>
                            <th>Decision</th>
                            <th>Reason</th>
                            <th className="text-right">Target USDC</th>
                            <th className="text-right">Limit Price</th>
                            <th>Filled</th>
                            <th className="text-right">Fill Price</th>
                            <th className="text-right">Slippage</th>
                        </tr>
                    </thead>
                    <tbody>
                        {intents.length === 0 ? (
                            <tr>
                                <td colSpan={11} className="text-center" style={{ padding: '3rem', color: 'var(--text-muted)' }}>
                                    No paper trading records match your filters.
                                </td>
                            </tr>
                        ) : (
                            intents.map(intent => {
                                const fill = intent.paperFill;
                                const slippagePct = fill?.slippagePct ? Number(fill.slippagePct) * 100 : null;

                                return (
                                    <tr key={intent.id}>
                                        <td>
                                            <div>{new Date(intent.createdAt).toLocaleTimeString()}</div>
                                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                                {new Date(intent.createdAt).toLocaleDateString()}
                                            </div>
                                        </td>
                                        <td style={{ fontWeight: 500 }}>{intent.trade.leader.label}</td>
                                        <td style={{ maxWidth: '200px' }}>
                                            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={intent.trade.title || ''}>
                                                {intent.trade.title || 'Unknown'}
                                            </div>
                                            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                                {intent.trade.outcome}
                                            </div>
                                        </td>
                                        <td>
                                            <span className={`badge ${intent.yourSide === 'BUY' ? 'badge-green' : 'badge-red'}`}>
                                                {intent.yourSide}
                                            </span>
                                        </td>
                                        <td>
                                            <span className={`badge ${intent.decision === 'TRADE' ? 'badge-blue' : 'badge-yellow'}`}>
                                                {intent.decision}
                                            </span>
                                        </td>
                                        <td style={{ minWidth: '180px' }}>
                                            <div style={{ fontSize: '0.85rem' }}>
                                                {intent.decisionReason}
                                            </div>
                                        </td>
                                        <td className="text-right code-mono" style={{ fontWeight: 600 }}>
                                            ${Number(intent.yourUsdcTarget).toFixed(2)}
                                        </td>
                                        <td className="text-right code-mono">
                                            {Number(intent.limitPrice).toFixed(3)}
                                        </td>
                                        <td>
                                            {fill ? (
                                                fill.filled ? <span className="badge badge-green">Yes</span> : <span className="badge badge-gray">No</span>
                                            ) : (
                                                <span style={{ color: 'var(--text-muted)' }}>-</span>
                                            )}
                                        </td>
                                        <td className="text-right code-mono">
                                            {fill?.fillPrice ? Number(fill.fillPrice).toFixed(3) : '-'}
                                        </td>
                                        <td className="text-right code-mono">
                                            {slippagePct !== null ? (
                                                <span style={{
                                                    color: slippagePct > 0 ? 'var(--error-text)' : slippagePct < 0 ? 'var(--success-text)' : 'var(--text-secondary)'
                                                }}>
                                                    {slippagePct > 0 ? '+' : ''}{slippagePct.toFixed(2)}%
                                                </span>
                                            ) : '-'}
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
