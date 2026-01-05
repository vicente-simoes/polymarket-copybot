import { prisma } from '@polymarket-bot/db'
import Link from 'next/link'
import { PageLayout } from '@/components/page-layout'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Bug, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'

interface DebugPageProps {
    searchParams: Promise<{ trade?: string }>
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
    })
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
    })

    if (!trade) return null

    let quoteRaw = null
    const intentWithQuote = trade.paperIntents.find(i => i.paperFill?.quoteId)
    if (intentWithQuote?.paperFill?.quoteId) {
        const quote = await prisma.quote.findUnique({
            where: { id: intentWithQuote.paperFill.quoteId },
            include: { raw: true },
        })
        quoteRaw = quote?.raw
    }

    if (!quoteRaw) {
        const mapping = await prisma.marketMapping.findUnique({
            where: {
                conditionId_outcome: {
                    conditionId: trade.conditionId,
                    outcome: trade.outcome,
                },
            },
        })
        if (mapping) {
            const quote = await prisma.quote.findFirst({
                where: { marketKey: mapping.marketKey },
                orderBy: { capturedAt: 'desc' },
                include: { raw: true },
            })
            quoteRaw = quote?.raw
        }
    }

    return { trade, quoteRaw }
}

export default async function DebugPage({ searchParams }: DebugPageProps) {
    const params = await searchParams
    const selectedTradeId = params.trade

    const recentTrades = await getRecentTrades()
    const details = selectedTradeId ? await getTradeDetails(selectedTradeId) : null

    return (
        <PageLayout
            title="Debug Inspector"
            description="Granular audit trail and raw payload inspector"
            icon={Bug}
        >
            <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-6">
                {/* Trade Picker */}
                <Card className="h-fit max-h-[800px] overflow-hidden">
                    <CardHeader className="py-3 border-b border-border">
                        <CardTitle className="text-sm">Recent Trades</CardTitle>
                    </CardHeader>
                    <ScrollArea className="h-[700px]">
                        {recentTrades.length === 0 ? (
                            <div className="py-12 text-center text-muted-foreground">
                                No trades found
                            </div>
                        ) : (
                            recentTrades.map(trade => (
                                <Link
                                    key={trade.id}
                                    href={`/debug?trade=${trade.id}`}
                                    className={cn(
                                        "block p-3 border-b border-border transition-colors hover:bg-muted/50",
                                        selectedTradeId === trade.id && "bg-primary/10 border-l-2 border-l-primary"
                                    )}
                                >
                                    <div className="flex justify-between items-center mb-1">
                                        <span className="font-medium text-sm">{trade.leader.label}</span>
                                        <span className="text-xs text-muted-foreground">
                                            {new Date(trade.tradeTs).toLocaleTimeString()}
                                        </span>
                                    </div>
                                    <div className="text-xs text-muted-foreground truncate">
                                        {trade.title || 'Unknown Market'}
                                    </div>
                                </Link>
                            ))
                        )}
                    </ScrollArea>
                </Card>

                {/* Trade Details */}
                <div className="space-y-4">
                    {!selectedTradeId ? (
                        <Card className="border-dashed">
                            <CardContent className="py-16 text-center text-muted-foreground">
                                Select a trade from the list to begin inspection.
                            </CardContent>
                        </Card>
                    ) : !details ? (
                        <Card>
                            <CardContent className="py-16 text-center text-destructive">
                                Trade not found.
                            </CardContent>
                        </Card>
                    ) : (
                        <>
                            {/* Trade Summary */}
                            <Section title="Trade Summary">
                                <InfoRow label="ID" value={details.trade.id} mono />
                                <InfoRow label="Leader" value={details.trade.leader.label} />
                                <InfoRow label="Wallet" value={details.trade.leader.wallet} mono />
                                <InfoRow label="Time" value={new Date(details.trade.tradeTs).toLocaleString()} />
                                <InfoRow label="Side" value={details.trade.side} badge={details.trade.side === 'BUY' ? 'success' : 'destructive'} />
                                <InfoRow label="Market" value={details.trade.title || 'Unknown'} />
                                <InfoRow label="Outcome" value={details.trade.outcome} />
                                <InfoRow label="Condition ID" value={details.trade.conditionId} mono />
                                <InfoRow label="Price" value={Number(details.trade.leaderPrice).toFixed(4)} mono />
                                <InfoRow label="Size" value={Number(details.trade.leaderSize).toFixed(4)} mono />
                                <InfoRow label="USDC" value={`$${Number(details.trade.leaderUsdc).toFixed(2)}`} mono />
                                <InfoRow
                                    label="Tx Hash"
                                    value={details.trade.txHash}
                                    mono
                                    link={`https://polygonscan.com/tx/${details.trade.txHash}`}
                                />
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
                                    <div className="text-muted-foreground italic p-4">No quote captured for this trade</div>
                                )}
                            </Section>

                            {/* Paper Intents */}
                            {details.trade.paperIntents.map((intent, i) => (
                                <Section key={intent.id} title={`Paper Intent ${i + 1}`}>
                                    <InfoRow label="ID" value={intent.id} mono />
                                    <InfoRow label="Decision" value={intent.decision} badge={intent.decision === 'TRADE' ? 'default' : 'warning'} />
                                    <InfoRow label="Reason" value={intent.decisionReason} />
                                    <InfoRow label="Your Side" value={intent.yourSide} />
                                    <InfoRow label="Your USDC" value={`$${Number(intent.yourUsdcTarget).toFixed(2)}`} mono />
                                    <InfoRow label="Limit Price" value={Number(intent.limitPrice).toFixed(4)} mono />
                                    <InfoRow label="Ratio" value={Number(intent.ratio).toFixed(4)} mono />
                                    <InfoRow label="Created" value={new Date(intent.createdAt).toLocaleString()} />

                                    {intent.paperFill && (
                                        <div className="mt-4 pt-4 border-t border-dashed border-border">
                                            <div className="font-medium mb-3 text-sm">Paper Fill Simulation</div>
                                            <InfoRow label="Filled" value={intent.paperFill.filled ? 'Yes' : 'No'} badge={intent.paperFill.filled ? 'success' : 'muted'} />
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
                                    <div className="text-muted-foreground italic p-4">No paper intent generated for this trade</div>
                                </Section>
                            )}
                        </>
                    )}
                </div>
            </div>
        </PageLayout>
    )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <Card>
            <CardHeader className="py-3 border-b border-border bg-muted/50">
                <CardTitle className="text-sm">{title}</CardTitle>
            </CardHeader>
            <CardContent className="p-4">
                {children}
            </CardContent>
        </Card>
    )
}

function InfoRow({ label, value, mono, link, badge }: {
    label: string
    value: string
    mono?: boolean
    link?: string
    badge?: 'success' | 'destructive' | 'warning' | 'default' | 'muted'
}) {
    const content = badge ? (
        <Badge variant={badge}>{value}</Badge>
    ) : link ? (
        <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline inline-flex items-center gap-1"
        >
            {value} <ExternalLink className="size-3" />
        </a>
    ) : (
        <span className={cn(mono && "font-mono text-xs")}>{value}</span>
    )

    return (
        <div className="flex items-start mb-2 text-sm">
            <div className="w-36 text-muted-foreground shrink-0">{label}</div>
            <div className={cn("flex-1 break-all", mono && "font-mono text-xs")}>{content}</div>
        </div>
    )
}

function JsonBlock({ data }: { data: unknown }) {
    if (!data) {
        return <div className="text-muted-foreground italic p-4">No data</div>
    }

    return (
        <pre className="bg-background p-4 overflow-auto text-xs max-h-[400px] font-mono rounded border border-border">
            {JSON.stringify(data, null, 2)}
        </pre>
    )
}
