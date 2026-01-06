import { prisma } from '@polymarket-bot/db'
import Link from 'next/link'
import { PageLayout, StatCard } from '@/components/page-layout'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table'
import { FileText, Filter, X, ChevronRight } from 'lucide-react'
import { ResetButton } from './reset-button'

const PAGE_SIZE = 50

interface PaperPageProps {
    searchParams: Promise<{
        leader?: string
        decision?: string
        filled?: string
        page?: string
    }>
}

// Get stats for ALL non-backfill paper intents (not filtered, not paginated)
async function getGlobalStats() {
    const allIntents = await prisma.paperIntent.findMany({
        where: {
            trade: {
                isBackfill: false,
            },
        },
        select: {
            decision: true,
            paperFill: {
                select: { filled: true },
            },
        },
    })

    return {
        total: allIntents.length,
        trades: allIntents.filter(i => i.decision === 'TRADE').length,
        skips: allIntents.filter(i => i.decision === 'SKIP').length,
        filled: allIntents.filter(i => i.paperFill?.filled).length,
        notFilled: allIntents.filter(i => i.paperFill && !i.paperFill.filled).length,
    }
}

// Get paginated paper intents for display (with filters applied)
async function getPaperIntents(filters: {
    leader?: string
    decision?: string
    filled?: string
}, page: number = 1) {
    const skip = (page - 1) * PAGE_SIZE

    const where = {
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
    }

    const [intents, totalCount] = await Promise.all([
        prisma.paperIntent.findMany({
            where,
            include: {
                trade: {
                    include: {
                        leader: { select: { label: true } },
                    },
                },
                paperFill: true,
            },
            orderBy: { createdAt: 'desc' },
            skip,
            take: PAGE_SIZE,
        }),
        prisma.paperIntent.count({ where }),
    ])

    return { intents, totalCount, hasMore: skip + intents.length < totalCount }
}

async function getLeadersForFilter() {
    return prisma.leader.findMany({
        select: { id: true, label: true },
        orderBy: { label: 'asc' },
    })
}

export default async function PaperPage({ searchParams }: PaperPageProps) {
    const params = await searchParams
    const currentPage = Math.max(1, parseInt(params.page || '1', 10))

    const [stats, { intents, totalCount, hasMore }, leaders] = await Promise.all([
        getGlobalStats(),
        getPaperIntents(params, currentPage),
        getLeadersForFilter(),
    ])

    // Build base URL for pagination links
    const baseParams = new URLSearchParams()
    if (params.leader) baseParams.set('leader', params.leader)
    if (params.decision) baseParams.set('decision', params.decision)
    if (params.filled) baseParams.set('filled', params.filled)
    const baseUrl = `/paper?${baseParams.toString()}${baseParams.toString() ? '&' : ''}`

    const startIndex = (currentPage - 1) * PAGE_SIZE + 1
    const endIndex = Math.min(currentPage * PAGE_SIZE, totalCount)

    // Check if any filters are applied
    const hasFilters = params.leader || params.decision || params.filled

    return (
        <PageLayout
            title="Paper Trading Results"
            description="Simulated decisions and execution results"
            icon={FileText}
        >
            {/* Stats Grid - Always shows ALL non-backfill trades */}
            <div className="flex items-start justify-between gap-4">
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4 flex-1">
                    <StatCard label="Total" value={stats.total} description="All non-backfill" />
                    <StatCard label="TRADE" value={stats.trades} variant="default" />
                    <StatCard label="SKIP" value={stats.skips} variant="warning" />
                    <StatCard label="Filled" value={stats.filled} variant="success" />
                    <StatCard label="Not Filled" value={stats.notFilled} variant="destructive" />
                </div>
                <ResetButton />
            </div>

            {/* Filter Bar */}
            <Card>
                <CardContent className="p-4">
                    <form className="flex flex-wrap items-end gap-4">
                        <div className="space-y-2">
                            <Label>Leader</Label>
                            <Select name="leader" defaultValue={params.leader || ''}>
                                <option value="">All Leaders</option>
                                {leaders.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
                            </Select>
                        </div>
                        <div className="space-y-2">
                            <Label>Decision</Label>
                            <Select name="decision" defaultValue={params.decision || ''}>
                                <option value="">All Decisions</option>
                                <option value="TRADE">TRADE</option>
                                <option value="SKIP">SKIP</option>
                            </Select>
                        </div>
                        <div className="space-y-2">
                            <Label>Filled Status</Label>
                            <Select name="filled" defaultValue={params.filled || ''}>
                                <option value="">All Statuses</option>
                                <option value="true">Filled</option>
                                <option value="false">Not Filled</option>
                            </Select>
                        </div>
                        <Button type="submit">
                            <Filter className="size-4 mr-2" />
                            Filter
                        </Button>
                        {hasFilters && (
                            <Link href="/paper">
                                <Button type="button" variant="secondary">
                                    <X className="size-4 mr-2" />
                                    Clear
                                </Button>
                            </Link>
                        )}
                    </form>
                </CardContent>
            </Card>

            {/* Filtered count indicator */}
            {hasFilters && (
                <div className="text-sm text-muted-foreground">
                    Showing {totalCount} filtered result{totalCount !== 1 ? 's' : ''} (of {stats.total} total)
                </div>
            )}

            {/* Results Table */}
            <Card>
                <CardContent className="p-0">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Time</TableHead>
                                <TableHead>Leader</TableHead>
                                <TableHead className="max-w-[150px]">Market</TableHead>
                                <TableHead>Side</TableHead>
                                <TableHead>Decision</TableHead>
                                <TableHead className="max-w-[150px]">Reason</TableHead>
                                <TableHead className="text-right">Target USDC</TableHead>
                                <TableHead className="text-right">Limit Price</TableHead>
                                <TableHead>Filled</TableHead>
                                <TableHead className="text-right">Fill Price</TableHead>
                                <TableHead className="text-right">Slippage</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {intents.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={11} className="text-center py-12 text-muted-foreground">
                                        No paper trading records match your filters.
                                    </TableCell>
                                </TableRow>
                            ) : (
                                intents.map(intent => {
                                    const fill = intent.paperFill
                                    const slippagePct = fill?.slippagePct ? Number(fill.slippagePct) * 100 : null

                                    return (
                                        <TableRow key={intent.id}>
                                            <TableCell>
                                                <div className="font-mono text-sm">
                                                    {new Date(intent.createdAt).toLocaleTimeString()}
                                                </div>
                                                <div className="text-xs text-muted-foreground">
                                                    {new Date(intent.createdAt).toLocaleDateString()}
                                                </div>
                                            </TableCell>
                                            <TableCell className="font-medium">{intent.trade.leader.label}</TableCell>
                                            <TableCell className="max-w-[150px]">
                                                <div className="truncate" title={intent.trade.title || ''}>
                                                    {intent.trade.title || 'Unknown'}
                                                </div>
                                                <div className="text-xs text-muted-foreground">
                                                    {intent.trade.outcome}
                                                </div>
                                            </TableCell>
                                            <TableCell>
                                                <Badge variant={intent.yourSide === 'BUY' ? 'success' : 'destructive'}>
                                                    {intent.yourSide}
                                                </Badge>
                                            </TableCell>
                                            <TableCell>
                                                <Badge variant={intent.decision === 'TRADE' ? 'default' : 'warning'}>
                                                    {intent.decision}
                                                </Badge>
                                            </TableCell>
                                            <TableCell className="max-w-[150px]">
                                                <div className="text-sm truncate" title={intent.decisionReason}>
                                                    {intent.decisionReason}
                                                </div>
                                            </TableCell>
                                            <TableCell className="text-right font-mono font-semibold">
                                                ${Number(intent.yourUsdcTarget).toFixed(2)}
                                            </TableCell>
                                            <TableCell className="text-right font-mono">
                                                {Number(intent.limitPrice).toFixed(3)}
                                            </TableCell>
                                            <TableCell>
                                                {fill ? (
                                                    fill.filled
                                                        ? <Badge variant="success">Yes</Badge>
                                                        : <Badge variant="muted">No</Badge>
                                                ) : (
                                                    <span className="text-muted-foreground">-</span>
                                                )}
                                            </TableCell>
                                            <TableCell className="text-right font-mono">
                                                {fill?.fillPrice ? Number(fill.fillPrice).toFixed(3) : '-'}
                                            </TableCell>
                                            <TableCell className="text-right font-mono">
                                                {slippagePct !== null ? (
                                                    <span className={slippagePct > 0 ? 'text-destructive' : slippagePct < 0 ? 'text-success' : ''}>
                                                        {slippagePct > 0 ? '+' : ''}{slippagePct.toFixed(2)}%
                                                    </span>
                                                ) : '-'}
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
                        Showing {startIndex}–{endIndex} of {totalCount} records
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
