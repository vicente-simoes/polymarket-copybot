import { prisma } from '@polymarket-bot/db'
import Link from 'next/link'
import { PageLayout } from '@/components/page-layout'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table'
import { TrendingUp, ExternalLink, ChevronRight, Zap, Globe } from 'lucide-react'

const PAGE_SIZE = 50

interface TradesPageProps {
    searchParams: Promise<{ leader?: string; showHistorical?: string; page?: string }>
}

async function getTrades(leaderId?: string, showHistorical: boolean = false, page: number = 1) {
    const skip = (page - 1) * PAGE_SIZE * 2 // Fetch extra to handle dedupe in memory

    const where = {
        ...(leaderId && { leaderId }),
        ...(!showHistorical && { isBackfill: false }),
    }

    // Fetch fills from both sources (LeaderFill is the unified registry)
    const [fills, totalCount] = await Promise.all([
        prisma.leaderFill.findMany({
            where,
            include: {
                leader: {
                    select: { label: true, wallet: true },
                },
            },
            orderBy: { detectedAt: 'desc' }, // Order by detection time (newest first)
            skip,
            take: PAGE_SIZE * 2, // Fetch double to handle potential duplicates (one per source)
        }),
        prisma.leaderFill.count({ where }),
    ])

    // Client-side deduplication to find the "First Instance" per transaction
    // Group by txHash, keep the one with earliest detectedAt
    const uniqueTradesMap = new Map<string, typeof fills[0] & { latency: number, firstSource: string }>()

    for (const fill of fills) {
        // Use txHash as the primary dedupe key for valid transactions, fallback to dedupeKey if no hash
        const key = fill.txHash || fill.dedupeKey

        // Calculate latency: detectedAt - fillTs (how long it took us to see it)
        const latency = fill.detectedAt.getTime() - fill.fillTs.getTime()

        if (!uniqueTradesMap.has(key)) {
            uniqueTradesMap.set(key, { ...fill, latency, firstSource: fill.source })
        } else {
            const existing = uniqueTradesMap.get(key)!
            // If this fill was detected earlier, replace the existing one
            if (fill.detectedAt < existing.detectedAt) {
                uniqueTradesMap.set(key, { ...fill, latency, firstSource: fill.source })
            }
        }
    }

    const uniqueTrades = Array.from(uniqueTradesMap.values())
        // Re-sort by latest detected (since map insertion order might differ slightly after merge)
        .sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime())
        .slice(0, PAGE_SIZE)

    return { trades: uniqueTrades, totalCount, hasMore: skip + uniqueTrades.length < totalCount } // Approximation
}

async function getLeaders() {
    return prisma.leader.findMany({
        select: { id: true, label: true },
        orderBy: { label: 'asc' },
    })
}

export default async function TradesPage({ searchParams }: TradesPageProps) {
    const params = await searchParams
    const selectedLeaderId = params.leader
    const showHistorical = params.showHistorical === 'true'
    const currentPage = Math.max(1, parseInt(params.page || '1', 10))

    const [{ trades, totalCount, hasMore }, leaders] = await Promise.all([
        getTrades(selectedLeaderId, showHistorical, currentPage),
        getLeaders(),
    ])

    // Build base URL for pagination links
    const baseParams = new URLSearchParams()
    if (selectedLeaderId) baseParams.set('leader', selectedLeaderId)
    if (showHistorical) baseParams.set('showHistorical', 'true')
    const baseUrl = `/trades?${baseParams.toString()}${baseParams.toString() ? '&' : ''}`

    const startIndex = (currentPage - 1) * PAGE_SIZE + 1
    const endIndex = Math.min(currentPage * PAGE_SIZE, totalCount)

    return (
        <PageLayout
            title="Trade Registry"
            description="First-detected instance of every trade (Polygon vs Data API)"
            icon={TrendingUp}
        >
            {/* Filter Bar */}
            <Card>
                <CardContent className="p-4">
                    <div className="flex flex-wrap items-center gap-3">
                        <span className="text-sm font-medium text-muted-foreground">Filter:</span>
                        <div className="flex flex-wrap gap-2">
                            <Link href={showHistorical ? '/trades?showHistorical=true' : '/trades'}>
                                <Badge variant={!selectedLeaderId ? 'default' : 'muted'} className="cursor-pointer">
                                    All
                                </Badge>
                            </Link>
                            {leaders.map(l => (
                                <Link
                                    key={l.id}
                                    href={`/trades?leader=${l.id}${showHistorical ? '&showHistorical=true' : ''}`}
                                >
                                    <Badge
                                        variant={selectedLeaderId === l.id ? 'default' : 'muted'}
                                        className="cursor-pointer"
                                    >
                                        {l.label}
                                    </Badge>
                                </Link>
                            ))}
                        </div>
                        <div className="ml-auto">
                            <Link
                                href={showHistorical
                                    ? `/trades${selectedLeaderId ? `?leader=${selectedLeaderId}` : ''}`
                                    : `/trades?showHistorical=true${selectedLeaderId ? `&leader=${selectedLeaderId}` : ''}`
                                }
                            >
                                <Badge variant={showHistorical ? 'warning' : 'muted'} className="cursor-pointer">
                                    {showHistorical ? '✓ Showing Historical' : 'Show Historical'}
                                </Badge>
                            </Link>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Trades Table */}
            <Card>
                <CardContent className="p-0">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Detected At</TableHead>
                                <TableHead>Leader</TableHead>
                                <TableHead className="max-w-[200px]">Market</TableHead>
                                <TableHead>Side</TableHead>
                                <TableHead className="text-right">Price</TableHead>
                                <TableHead className="text-right">USDC</TableHead>
                                <TableHead className="text-right">Size</TableHead>
                                <TableHead>Source</TableHead>
                                <TableHead className="text-right">Latency</TableHead>
                                <TableHead className="text-right">Tx</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {trades.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={10} className="text-center py-12 text-muted-foreground">
                                        No trades found.
                                    </TableCell>
                                </TableRow>
                            ) : (
                                trades.map(trade => {
                                    const latencyVariant = trade.latency < 500 ? 'success' : trade.latency < 2000 ? 'warning' : 'destructive'

                                    return (
                                        <TableRow key={trade.id}>
                                            <TableCell>
                                                <div className="font-mono text-sm">
                                                    {new Date(trade.detectedAt).toLocaleTimeString()}
                                                </div>
                                                <div className="text-xs text-muted-foreground">
                                                    {new Date(trade.detectedAt).toLocaleDateString()}
                                                </div>
                                            </TableCell>
                                            <TableCell>
                                                <div className="font-medium">{trade.leader.label}</div>
                                                <div className="text-xs text-muted-foreground font-mono">
                                                    {trade.leader.wallet.substring(0, 6)}...
                                                </div>
                                            </TableCell>
                                            <TableCell className="max-w-[200px]">
                                                <div className="truncate" title={trade.title || ''}>
                                                    {trade.title || 'Unknown Market'}
                                                </div>
                                                <div className="text-xs text-muted-foreground">
                                                    {trade.outcome}
                                                </div>
                                            </TableCell>
                                            <TableCell>
                                                <div className="flex items-center gap-1">
                                                    <Badge variant={trade.side === 'BUY' ? 'success' : 'destructive'}>
                                                        {trade.side}
                                                    </Badge>
                                                    {trade.isBackfill && (
                                                        <Badge variant="muted" className="text-[10px]">Backfill</Badge>
                                                    )}
                                                </div>
                                            </TableCell>
                                            <TableCell className="text-right font-mono">
                                                {Number(trade.leaderPrice).toFixed(3)}
                                            </TableCell>
                                            <TableCell className="text-right font-mono font-semibold">
                                                ${Number(trade.leaderUsdc).toFixed(2)}
                                            </TableCell>
                                            <TableCell className="text-right font-mono text-muted-foreground">
                                                {Number(trade.leaderSize).toFixed(1)}
                                            </TableCell>
                                            <TableCell>
                                                <div className="flex items-center gap-1.5">
                                                    {trade.firstSource === 'polygon' ? (
                                                        <Zap className="size-3 text-purple-500" />
                                                    ) : (
                                                        <Globe className="size-3 text-blue-500" />
                                                    )}
                                                    <span className={`text-xs font-medium ${trade.firstSource === 'polygon' ? 'text-purple-600' : 'text-blue-600'
                                                        }`}>
                                                        {trade.firstSource === 'polygon' ? 'Polygon' : 'API'}
                                                    </span>
                                                </div>
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <Badge variant={latencyVariant} className="font-mono">
                                                    {trade.latency > 0 ? `${trade.latency}ms` : '<1ms'}
                                                </Badge>
                                            </TableCell>
                                            <TableCell className="text-right">
                                                {trade.txHash ? (
                                                    <a
                                                        href={`https://polygonscan.com/tx/${trade.txHash}`}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                    >
                                                        <Button variant="ghost" size="sm" className="h-7 px-2">
                                                            <ExternalLink className="size-3" />
                                                        </Button>
                                                    </a>
                                                ) : (
                                                    <span className="text-muted-foreground">-</span>
                                                )}
                                            </TableCell>
                                        </TableRow>
                                    )
                                })
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>

            {/* Pagination */}
            {totalCount > 0 && (
                <div className="flex items-center justify-between">
                    <div className="text-sm text-muted-foreground">
                        Approx {totalCount / 2} unique trades
                    </div>
                    <div className="flex gap-2">
                        {currentPage > 1 && (
                            <Link href={`${baseUrl}page=${currentPage - 1}`}>
                                <Button variant="secondary" size="sm">
                                    Previous
                                </Button>
                            </Link>
                        )}
                        {hasMore && (
                            <Link href={`${baseUrl}page=${currentPage + 1}`}>
                                <Button variant="secondary" size="sm">
                                    Next <ChevronRight className="size-4 ml-1" />
                                </Button>
                            </Link>
                        )}
                    </div>
                </div>
            )}
        </PageLayout>
    )
}
