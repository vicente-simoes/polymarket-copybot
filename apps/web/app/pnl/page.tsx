'use client';

import { useEffect, useState } from 'react';

type TimeRange = '24h' | '7d' | '30d' | 'all';

interface PnlData {
    openPositions: Array<{
        id: string;
        marketKey: string;
        outcome: string;
        title: string | null;
        shares: number;
        avgEntryPrice: number;
        totalCostBasis: number;
        updatedAt: string;
    }>;
    closedPositions: Array<{
        id: string;
        marketKey: string;
        outcome: string;
        title: string | null;
        resolutions: Array<{
            realizedPnl: number;
            resolvedOutcome: string;
            resolvedAt: string;
        }>;
    }>;
    pnlHistory: Array<{
        timestamp: string;
        totalPnl: number;
        unrealizedPnl: number;
        realizedPnl: number;
    }>;
    summary: {
        totalCostBasis: number;
        totalRealizedPnl: number;
        openPositionCount: number;
        closedPositionCount: number;
    };
}

export default function PnLPage() {
    const [data, setData] = useState<PnlData | null>(null);
    const [range, setRange] = useState<TimeRange>('7d');
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function fetchData() {
            setLoading(true);
            try {
                const res = await fetch(`/api/pnl?range=${range}`);
                const json = await res.json();
                setData(json);
            } catch (error) {
                console.error('Failed to fetch P&L data:', error);
            }
            setLoading(false);
        }
        fetchData();
    }, [range]);

    if (loading) {
        return (
            <div className="animate-fade-in">
                <div className="page-header">
                    <h1 className="page-title">P&L Dashboard</h1>
                    <p className="page-subtitle">Loading...</p>
                </div>
            </div>
        );
    }

    if (!data) {
        return (
            <div className="animate-fade-in">
                <div className="page-header">
                    <h1 className="page-title">P&L Dashboard</h1>
                    <p className="page-subtitle">Failed to load data</p>
                </div>
            </div>
        );
    }

    const { openPositions, closedPositions, pnlHistory, summary } = data;

    return (
        <div className="animate-fade-in">
            <div className="page-header">
                <h1 className="page-title">P&L Dashboard</h1>
                <p className="page-subtitle">Track your paper trading performance</p>
            </div>

            {/* Summary Cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
                <div className="card">
                    <div className="stat-label">Total Cost Basis</div>
                    <div className="stat-value code-mono">${summary.totalCostBasis.toFixed(2)}</div>
                </div>
                <div className="card">
                    <div className="stat-label">Realized P&L</div>
                    <div className="stat-value code-mono" style={{ color: summary.totalRealizedPnl >= 0 ? 'var(--success-text)' : 'var(--error-text)' }}>
                        {summary.totalRealizedPnl >= 0 ? '+' : ''}${summary.totalRealizedPnl.toFixed(2)}
                    </div>
                </div>
                <div className="card">
                    <div className="stat-label">Open Positions</div>
                    <div className="stat-value">{summary.openPositionCount}</div>
                </div>
                <div className="card">
                    <div className="stat-label">Closed Positions</div>
                    <div className="stat-value">{summary.closedPositionCount}</div>
                </div>
            </div>

            {/* P&L Chart */}
            <div className="card mb-4">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                    <h3>P&L Over Time</h3>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                        {(['24h', '7d', '30d', 'all'] as const).map(r => (
                            <button
                                key={r}
                                onClick={() => setRange(r)}
                                className={`btn ${range === r ? 'btn-primary' : 'btn-secondary'}`}
                                style={{ fontSize: '0.8rem', padding: '0.25rem 0.75rem' }}
                            >
                                {r === 'all' ? 'All Time' : r.toUpperCase()}
                            </button>
                        ))}
                    </div>
                </div>

                {pnlHistory.length > 0 ? (
                    <div style={{ height: '300px', position: 'relative' }}>
                        <PnLChart data={pnlHistory} />
                    </div>
                ) : (
                    <div style={{ height: '200px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
                        No P&L history data yet. Data is recorded hourly.
                    </div>
                )}
            </div>

            {/* Open Positions */}
            <div className="card mb-4">
                <h3 className="mb-3">Open Positions</h3>
                {openPositions.length === 0 ? (
                    <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                        No open positions
                    </div>
                ) : (
                    <div className="table-container">
                        <table>
                            <thead>
                                <tr>
                                    <th>Market</th>
                                    <th>Outcome</th>
                                    <th className="text-right">Shares</th>
                                    <th className="text-right">Avg Entry</th>
                                    <th className="text-right">Cost Basis</th>
                                </tr>
                            </thead>
                            <tbody>
                                {openPositions.map(pos => (
                                    <tr key={pos.id}>
                                        <td style={{ maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {pos.title || pos.marketKey}
                                        </td>
                                        <td>
                                            <span className={`badge ${pos.outcome === 'YES' ? 'badge-green' : 'badge-gray'}`}>
                                                {pos.outcome}
                                            </span>
                                        </td>
                                        <td className="text-right code-mono">{pos.shares.toFixed(2)}</td>
                                        <td className="text-right code-mono">${pos.avgEntryPrice.toFixed(3)}</td>
                                        <td className="text-right code-mono">${pos.totalCostBasis.toFixed(2)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Closed Positions */}
            <div className="card">
                <h3 className="mb-3">Closed Positions</h3>
                {closedPositions.length === 0 ? (
                    <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                        No closed positions yet
                    </div>
                ) : (
                    <div className="table-container">
                        <table>
                            <thead>
                                <tr>
                                    <th>Market</th>
                                    <th>Outcome</th>
                                    <th>Resolution</th>
                                    <th className="text-right">Realized P&L</th>
                                </tr>
                            </thead>
                            <tbody>
                                {closedPositions.map(pos => {
                                    const totalPnl = pos.resolutions.reduce((sum, r) => sum + r.realizedPnl, 0);
                                    const lastResolution = pos.resolutions[pos.resolutions.length - 1];
                                    return (
                                        <tr key={pos.id}>
                                            <td style={{ maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {pos.title || pos.marketKey}
                                            </td>
                                            <td>
                                                <span className={`badge ${pos.outcome === 'YES' ? 'badge-green' : 'badge-gray'}`}>
                                                    {pos.outcome}
                                                </span>
                                            </td>
                                            <td>{lastResolution?.resolvedOutcome || '-'}</td>
                                            <td className="text-right code-mono" style={{ color: totalPnl >= 0 ? 'var(--success-text)' : 'var(--error-text)' }}>
                                                {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}

// Simple SVG-based P&L Chart (no external dependencies needed)
function PnLChart({ data }: { data: Array<{ timestamp: string; totalPnl: number }> }) {
    if (data.length < 2) {
        return (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
                Need at least 2 data points to render chart
            </div>
        );
    }

    const values = data.map(d => d.totalPnl);
    const minVal = Math.min(...values);
    const maxVal = Math.max(...values);
    const range = maxVal - minVal || 1;

    const width = 800;
    const height = 250;
    const padding = 40;

    const points = data.map((d, i) => {
        const x = padding + (i / (data.length - 1)) * (width - 2 * padding);
        const y = height - padding - ((d.totalPnl - minVal) / range) * (height - 2 * padding);
        return `${x},${y}`;
    }).join(' ');

    const isPositive = values[values.length - 1] >= 0;
    const strokeColor = isPositive ? 'var(--success-text)' : 'var(--error-text)';

    return (
        <svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
            {/* Grid lines */}
            <line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke="var(--border-color)" strokeWidth="1" />
            <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="var(--border-color)" strokeWidth="1" />

            {/* Zero line if applicable */}
            {minVal < 0 && maxVal > 0 && (
                <line
                    x1={padding}
                    y1={height - padding - ((0 - minVal) / range) * (height - 2 * padding)}
                    x2={width - padding}
                    y2={height - padding - ((0 - minVal) / range) * (height - 2 * padding)}
                    stroke="var(--text-muted)"
                    strokeWidth="1"
                    strokeDasharray="4"
                />
            )}

            {/* P&L line */}
            <polyline
                fill="none"
                stroke={strokeColor}
                strokeWidth="2"
                points={points}
            />

            {/* Y-axis labels */}
            <text x={padding - 5} y={padding} fontSize="10" fill="var(--text-muted)" textAnchor="end" dominantBaseline="middle">
                ${maxVal.toFixed(2)}
            </text>
            <text x={padding - 5} y={height - padding} fontSize="10" fill="var(--text-muted)" textAnchor="end" dominantBaseline="middle">
                ${minVal.toFixed(2)}
            </text>

            {/* Current value indicator */}
            <circle
                cx={padding + (width - 2 * padding)}
                cy={height - padding - ((values[values.length - 1] - minVal) / range) * (height - 2 * padding)}
                r="4"
                fill={strokeColor}
            />
        </svg>
    );
}
