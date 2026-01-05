import { prisma } from '@polymarket-bot/db'
import Link from 'next/link'
import { PageLayout, StatCard } from '@/components/page-layout'
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
import { TrendingUp, ExternalLink, ChevronRight } from 'lucide-react'

const PAGE_SIZE = 50

interface TradesPageProps {
    searchParams: Promise<{ leader?: string; showHistorical?: string; page?: string }>
}

async function getTrades(leaderId?: string, showHistorical: boolean = false, page: number = 1) {
    const skip = (page - 1) * PAGE_SIZE

    const where = {
        ...(leaderId && { leaderId }),
        ...(!showHistorical && { isBackfill: false }),
    }

    const [trades, totalCount] = await Promise.all([
        prisma.trade.findMany({
            where,
            include: {
                leader: {
                    select: { label: true, wallet: true },
                },
                paperIntents: {
                    select: { id: true },
                },
            },
            orderBy: { tradeTs: 'desc' },
            skip,
            take: PAGE_SIZE,
        }),
        prisma.trade.count({ where }),
    ])

    return { trades, totalCount, hasMore: skip + trades.length < totalCount }
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
            title="Trade Ingestion"
            description="Real-time trade feed from monitored wallets"
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
                                <TableHead>Time</TableHead>
                                <TableHead>Leader</TableHead>
                                <TableHead className="max-w-[200px]">Market</TableHead>
                                <TableHead>Side</TableHead>
                                <TableHead className="text-right">Price</TableHead>
                                <TableHead className="text-right">USDC</TableHead>
                                <TableHead className="text-right">Size</TableHead>
                                <TableHead className="text-right">Latency</TableHead>
                                <TableHead className="text-right">Tx</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {trades.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={9} className="text-center py-12 text-muted-foreground">
                                        No trades found.
                                    </TableCell>
                                </TableRow>
                            ) : (
                                trades.map(trade => {
                                    const latency = trade.detectedAt.getTime() - trade.tradeTs.getTime()
                                    const latencyVariant = latency < 2000 ? 'success' : latency < 5000 ? 'warning' : 'destructive'

                                    return (
                                        <TableRow key={trade.id}>
                                            <TableCell>
                                                <div className="font-mono text-sm">
                                                    {new Date(trade.tradeTs).toLocaleTimeString()}
                                                </div>
                                                <div className="text-xs text-muted-foreground">
                                                    {new Date(trade.tradeTs).toLocaleDateString()}
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
                                                        <Badge variant="muted" className="text-[10px]">Historical</Badge>
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
                                            <TableCell className="text-right">
                                                <Badge variant={latencyVariant} className="font-mono">
                                                    {latency}ms
                                                </Badge>
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <a
                                                    href={`https://polygonscan.com/tx/${trade.txHash}`}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                >
                                                    <Button variant="ghost" size="sm" className="h-7 px-2">
                                                        <ExternalLink className="size-3" />
                                                    </Button>
                                                </a>
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
                        Showing {startIndex}–{endIndex} of {totalCount} trades
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
