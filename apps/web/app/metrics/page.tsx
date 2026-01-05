import { prisma } from '@polymarket-bot/db'
import { PageLayout, StatCard } from '@/components/page-layout'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table'
import { BarChart3, TrendingUp, AlertCircle, CheckCircle2, XCircle } from 'lucide-react'

async function getMetrics() {
    const intents = await prisma.paperIntent.findMany({
        where: {
            trade: {
                isBackfill: false,
            },
        },
        include: {
            paperFill: true,
            trade: {
                include: { leader: { select: { id: true, label: true } } },
            },
        },
    })

    const tradeDecisions = intents.filter(i => i.decision === 'TRADE')
    const skipDecisions = intents.filter(i => i.decision === 'SKIP')
    const filledTrades = tradeDecisions.filter(i => i.paperFill?.filled)
    const matchedPrice = tradeDecisions.filter(i => i.paperFill?.matchSamePrice)

    const slippages = filledTrades
        .map(i => i.paperFill?.slippagePct ? Number(i.paperFill.slippagePct) * 100 : null)
        .filter((s): s is number => s !== null)

    const avgSlippage = slippages.length > 0 ? slippages.reduce((a, b) => a + b, 0) / slippages.length : 0
    const worstSlippage = slippages.length > 0 ? Math.max(...slippages) : 0

    const totalUsdcCopied = filledTrades.reduce((sum, i) => sum + Number(i.yourUsdcTarget), 0)
    const totalUsdcSkipped = skipDecisions.reduce((sum, i) => sum + Number(i.yourUsdcTarget), 0)

    const leaderMap = new Map<string, { label: string; trades: number; skips: number; filled: number; usdc: number }>()
    for (const intent of intents) {
        const leaderId = intent.trade.leader.id
        const label = intent.trade.leader.label
        if (!leaderMap.has(leaderId)) {
            leaderMap.set(leaderId, { label, trades: 0, skips: 0, filled: 0, usdc: 0 })
        }
        const stats = leaderMap.get(leaderId)!
        if (intent.decision === 'TRADE') {
            stats.trades++
            if (intent.paperFill?.filled) {
                stats.filled++
                stats.usdc += Number(intent.yourUsdcTarget)
            }
        } else {
            stats.skips++
        }
    }

    const skipReasons = new Map<string, number>()
    for (const intent of skipDecisions) {
        const reason = intent.decisionReason
        skipReasons.set(reason, (skipReasons.get(reason) || 0) + 1)
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
            totalUsdcCopied,
            totalUsdcSkipped,
        },
        byLeader: Array.from(leaderMap.entries()).map(([id, stats]) => ({ id, ...stats })),
        skipReasons: Array.from(skipReasons.entries()).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    }
}

export default async function MetricsPage() {
    const metrics = await getMetrics()

    const getVariantFromRate = (rate: number): 'success' | 'warning' | 'destructive' => {
        if (rate >= 80) return 'success'
        if (rate >= 50) return 'warning'
        return 'destructive'
    }

    return (
        <PageLayout
            title="Performance Metrics"
            description="Detailed analysis of paper trading results"
            icon={BarChart3}
        >
            {metrics.overview.total === 0 ? (
                <Card>
                    <CardContent className="py-16 text-center text-muted-foreground">
                        <BarChart3 className="size-12 mx-auto mb-4 opacity-50" />
                        <p>No metrics available. Start the worker to process trades and generate data.</p>
                    </CardContent>
                </Card>
            ) : (
                <>
                    {/* Overview */}
                    <div>
                        <h2 className="text-lg font-semibold mb-4">Overview</h2>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <StatCard label="Total Intents" value={metrics.overview.total} />
                            <StatCard label="Trade Decisions" value={metrics.overview.tradeDecisions} />
                            <StatCard label="Skip Decisions" value={metrics.overview.skipDecisions} variant="warning" />
                            <StatCard label="Filled Trades" value={metrics.overview.filledTrades} variant="success" />
                        </div>
                    </div>

                    {/* Execution Quality */}
                    <div>
                        <h2 className="text-lg font-semibold mb-4">Execution Quality</h2>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <StatCard
                                label="Match Rate"
                                value={`${metrics.overview.matchRate.toFixed(1)}%`}
                                description="Same-price matches"
                                variant={getVariantFromRate(metrics.overview.matchRate)}
                            />
                            <StatCard
                                label="Fill Rate"
                                value={`${metrics.overview.fillRate.toFixed(1)}%`}
                                description="Successfully filled"
                                variant={getVariantFromRate(metrics.overview.fillRate)}
                            />
                            <StatCard
                                label="Avg Slippage"
                                value={`${metrics.overview.avgSlippage >= 0 ? '+' : ''}${metrics.overview.avgSlippage.toFixed(2)}%`}
                                description="When filled"
                                variant={metrics.overview.avgSlippage > 1 ? 'destructive' : metrics.overview.avgSlippage > 0 ? 'warning' : 'success'}
                            />
                            <StatCard
                                label="Worst Slippage"
                                value={`+${metrics.overview.worstSlippage.toFixed(2)}%`}
                                variant="destructive"
                            />
                        </div>
                    </div>

                    {/* Capital Flow */}
                    <div>
                        <h2 className="text-lg font-semibold mb-4">Capital Flow</h2>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <StatCard
                                label="Total Copied USDC"
                                value={`$${metrics.overview.totalUsdcCopied.toFixed(2)}`}
                                description="Paper traded volume"
                                variant="success"
                                icon={CheckCircle2}
                            />
                            <StatCard
                                label="Total Skipped USDC"
                                value={`$${metrics.overview.totalUsdcSkipped.toFixed(2)}`}
                                description="Filtered out volume"
                                icon={XCircle}
                            />
                        </div>
                    </div>

                    {/* Leader Performance */}
                    {metrics.byLeader.length > 0 && (
                        <Card>
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <TrendingUp className="size-4" />
                                    Leader Performance
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="p-0">
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>Leader</TableHead>
                                            <TableHead className="text-right">Trades</TableHead>
                                            <TableHead className="text-right">Filled</TableHead>
                                            <TableHead className="text-right">Skips</TableHead>
                                            <TableHead className="text-right">Fill Rate</TableHead>
                                            <TableHead className="text-right">Volume (USDC)</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {metrics.byLeader.map(leader => {
                                            const fillRate = leader.trades > 0 ? (leader.filled / leader.trades) * 100 : 0
                                            return (
                                                <TableRow key={leader.id}>
                                                    <TableCell className="font-medium">{leader.label}</TableCell>
                                                    <TableCell className="text-right">{leader.trades}</TableCell>
                                                    <TableCell className="text-right">{leader.filled}</TableCell>
                                                    <TableCell className="text-right">{leader.skips}</TableCell>
                                                    <TableCell className="text-right">
                                                        {leader.trades > 0 ? (
                                                            <Badge variant={getVariantFromRate(fillRate)}>
                                                                {fillRate.toFixed(0)}%
                                                            </Badge>
                                                        ) : '-'}
                                                    </TableCell>
                                                    <TableCell className="text-right font-mono text-success">
                                                        ${leader.usdc.toFixed(2)}
                                                    </TableCell>
                                                </TableRow>
                                            )
                                        })}
                                    </TableBody>
                                </Table>
                            </CardContent>
                        </Card>
                    )}

                    {/* Skip Reasons */}
                    {metrics.skipReasons.length > 0 && (
                        <Card>
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <AlertCircle className="size-4" />
                                    Skip Reasons
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="flex flex-wrap gap-2">
                                    {metrics.skipReasons.map(({ reason, count }) => (
                                        <Badge key={reason} variant="warning" className="text-sm py-1.5 px-3">
                                            {reason}: <strong className="ml-1">{count}</strong>
                                        </Badge>
                                    ))}
                                </div>
                            </CardContent>
                        </Card>
                    )}
                </>
            )}
        </PageLayout>
    )
}
