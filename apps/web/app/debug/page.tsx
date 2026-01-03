import { prisma } from '@polymarket-bot/db';
import Link from 'next/link';

interface DebugPageProps {
    searchParams: Promise<{ trade?: string }>;
}

async function getRecentTrades() {
    return prisma.trade.findMany({
        select: {
            id: true,
            title: true,
            outcome: true,
            tradeTs: true,
            leader: { select: { label: true } },
        },
        orderBy: { tradeTs: 'desc' },
        take: 50,
    });
}

async function getTradeDetails(tradeId: string) {
    const trade = await prisma.trade.findUnique({
        where: { id: tradeId },
        include: {
            leader: true,
            raw: true,
            paperIntents: {
                include: {
                    paperFill: true,
                },
            },
        },
    });

    if (!trade) return null;

    // Get quote raw if we have a paper intent with quote
    let quoteRaw = null;
    const intentWithQuote = trade.paperIntents.find(i => i.paperFill?.quoteId);
    if (intentWithQuote?.paperFill?.quoteId) {
        const quote = await prisma.quote.findUnique({
            where: { id: intentWithQuote.paperFill.quoteId },
            include: { raw: true },
        });
        quoteRaw = quote?.raw;
    }

    // Try to find quote by market key
    if (!quoteRaw) {
        const mapping = await prisma.marketMapping.findUnique({
            where: {
                conditionId_outcome: {
                    conditionId: trade.conditionId,
                    outcome: trade.outcome,
                },
            },
        });
        if (mapping) {
            const quote = await prisma.quote.findFirst({
                where: { marketKey: mapping.marketKey },
                orderBy: { capturedAt: 'desc' },
                include: { raw: true },
            });
            quoteRaw = quote?.raw;
        }
    }

    return { trade, quoteRaw };
}

export default async function DebugPage({ searchParams }: DebugPageProps) {
    const params = await searchParams;
    const selectedTradeId = params.trade;

    const recentTrades = await getRecentTrades();
    const details = selectedTradeId ? await getTradeDetails(selectedTradeId) : null;

    return (
        <div className="animate-fade-in">
            <div className="page-header">
                <h1 className="page-title">Debug Inspector</h1>
                <p className="page-subtitle">Granular audit trail and raw payload inspector</p>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 1fr) 3fr', gap: 'var(--space-8)' }}>
                {/* Trade Picker */}
                <div className="card" style={{ padding: 0, overflow: 'hidden', height: 'fit-content', maxHeight: '1000px', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ padding: 'var(--space-4)', borderBottom: '1px solid var(--border-subtle)', backgroundColor: 'var(--bg-panel)' }}>
                        <h3 style={{ fontSize: '1rem' }}>Recent Trades</h3>
                    </div>
                    <div style={{ overflowY: 'auto', flex: 1 }}>
                        {recentTrades.length === 0 ? (
                            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                                No trades found
                            </div>
                        ) : (
                            recentTrades.map(trade => (
                                <Link
                                    key={trade.id}
                                    href={`/debug?trade=${trade.id}`}
                                    style={{
                                        display: 'block',
                                        padding: 'var(--space-4)',
                                        borderBottom: '1px solid var(--border-subtle)',
                                        textDecoration: 'none',
                                        color: 'inherit',
                                        backgroundColor: selectedTradeId === trade.id ? 'rgba(31, 111, 235, 0.1)' : 'transparent',
                                        borderLeft: selectedTradeId === trade.id ? '3px solid var(--accent-secondary)' : '3px solid transparent',
                                        transition: 'all 0.2s',
                                    }}
                                    className="hover:bg-hover"
                                >
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                                        <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{trade.leader.label}</span>
                                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                            {new Date(trade.tradeTs).toLocaleTimeString()}
                                        </span>
                                    </div>
                                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {trade.title || 'Unknown Market'}
                                    </div>
                                </Link>
                            ))
                        )}
                    </div>
                </div>

                {/* Trade Details */}
                <div>
                    {!selectedTradeId ? (
                        <div className="card text-center" style={{ padding: '4rem', color: 'var(--text-muted)', borderStyle: 'dashed' }}>
                            Select a trade from the list to begin inspection.
                        </div>
                    ) : !details ? (
                        <div className="card text-center" style={{ padding: '4rem', color: 'var(--error-text)' }}>
                            Trade not found.
                        </div>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
                            {/* Trade Summary */}
                            <Section title="Trade Summary">
                                <InfoRow label="ID" value={details.trade.id} mono />
                                <InfoRow label="Leader" value={details.trade.leader.label} />
                                <InfoRow label="Wallet" value={details.trade.leader.wallet} mono />
                                <InfoRow label="Time" value={new Date(details.trade.tradeTs).toLocaleString()} />
                                <InfoRow label="Side" value={details.trade.side} badge={details.trade.side === 'BUY' ? 'green' : 'red'} />
                                <InfoRow label="Market" value={details.trade.title || 'Unknown'} />
                                <InfoRow label="Outcome" value={details.trade.outcome} />
                                <InfoRow label="Condition ID" value={details.trade.conditionId} mono />
                                <InfoRow label="Price" value={Number(details.trade.leaderPrice).toFixed(4)} mono />
                                <InfoRow label="Size" value={Number(details.trade.leaderSize).toFixed(4)} mono />
                                <InfoRow label="USDC" value={`$${Number(details.trade.leaderUsdc).toFixed(2)}`} mono />
                                <InfoRow label="Tx Hash" value={details.trade.txHash} mono link={`https://polygonscan.com/tx/${details.trade.txHash}`} />
                            </Section>

                            {/* Trade Raw Payload */}
                            <Section title="Trade Raw Payload">
                                <JsonBlock data={details.trade.raw?.payload} />
                            </Section>

                            {/* Quote Raw Payload */}
                            <Section title="Quote Raw Payload">
                                {details.quoteRaw ? (
                                    <JsonBlock data={details.quoteRaw.payload} />
                                ) : (
                                    <div style={{ color: 'var(--text-muted)', fontStyle: 'italic', padding: '1rem' }}>No quote captured for this trade</div>
                                )}
                            </Section>

                            {/* Paper Intents */}
                            {details.trade.paperIntents.map((intent, i) => (
                                <Section key={intent.id} title={`Paper Intent ${i + 1}`}>
                                    <InfoRow label="ID" value={intent.id} mono />
                                    <InfoRow label="Decision" value={intent.decision} badge={intent.decision === 'TRADE' ? 'blue' : 'yellow'} />
                                    <InfoRow label="Reason" value={intent.decisionReason} />
                                    <InfoRow label="Your Side" value={intent.yourSide} />
                                    <InfoRow label="Your USDC" value={`$${Number(intent.yourUsdcTarget).toFixed(2)}`} mono />
                                    <InfoRow label="Limit Price" value={Number(intent.limitPrice).toFixed(4)} mono />
                                    <InfoRow label="Ratio" value={Number(intent.ratio).toFixed(4)} mono />
                                    <InfoRow label="Created" value={new Date(intent.createdAt).toLocaleString()} />

                                    {intent.paperFill && (
                                        <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px dashed var(--border-subtle)' }}>
                                            <div style={{ fontWeight: 600, marginBottom: '0.75rem', color: 'var(--text-primary)' }}>Paper Fill Simulation</div>
                                            <InfoRow label="Filled" value={intent.paperFill.filled ? 'Yes' : 'No'} badge={intent.paperFill.filled ? 'green' : 'gray'} />
                                            <InfoRow label="Match Same Price" value={intent.paperFill.matchSamePrice ? 'Yes' : 'No'} />
                                            {intent.paperFill.fillPrice && (
                                                <InfoRow label="Fill Price" value={Number(intent.paperFill.fillPrice).toFixed(4)} mono />
                                            )}
                                            {intent.paperFill.slippagePct && (
                                                <InfoRow label="Slippage" value={`${(Number(intent.paperFill.slippagePct) * 100).toFixed(2)}%`} mono />
                                            )}
                                        </div>
                                    )}
                                </Section>
                            ))}

                            {details.trade.paperIntents.length === 0 && (
                                <Section title="Paper Intent">
                                    <div style={{ color: 'var(--text-muted)', fontStyle: 'italic', padding: '1rem' }}>No paper intent generated for this trade</div>
                                </Section>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '0.75rem 1rem', backgroundColor: 'var(--bg-panel)', borderBottom: '1px solid var(--border-subtle)', fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                {title}
            </div>
            <div style={{ padding: '1rem' }}>
                {children}
            </div>
        </div>
    );
}

function InfoRow({ label, value, mono, link, badge }: { label: string; value: string; mono?: boolean; link?: string; badge?: string }) {
    const valueStyle = {
        fontFamily: mono ? 'var(--font-mono)' : 'inherit',
        fontSize: mono ? '0.8rem' : '0.9rem',
        wordBreak: 'break-all' as const,
    };

    const content = badge ? (
        <span className={`badge badge-${badge}`}>{value}</span>
    ) : link ? (
        <a href={link} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-secondary)' }}>
            {value} ↗
        </a>
    ) : (
        value
    );

    return (
        <div style={{ display: 'flex', marginBottom: '0.5rem', fontSize: '0.9rem', alignItems: 'center' }}>
            <div style={{ width: '140px', color: 'var(--text-secondary)', flexShrink: 0 }}>{label}</div>
            <div style={{ ...valueStyle, flex: 1 }}>{content}</div>
        </div>
    );
}

function JsonBlock({ data }: { data: unknown }) {
    if (!data) {
        return <div style={{ color: 'var(--text-muted)', fontStyle: 'italic', padding: '1rem' }}>No data</div>;
    }

    return (
        <pre style={{
            backgroundColor: '#0d1117',
            color: '#c9d1d9',
            padding: '1rem',
            overflow: 'auto',
            fontSize: '0.8rem',
            maxHeight: '400px',
            fontFamily: 'var(--font-mono)',
            borderTop: '1px solid var(--border-subtle)',
        }}>
            {JSON.stringify(data, null, 2)}
        </pre>
    );
}
