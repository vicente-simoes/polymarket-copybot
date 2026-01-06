'use client'

import { useEffect, useState } from 'react'
import { PageLayout, StatCard } from '@/components/page-layout'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { DollarSign, TrendingUp, TrendingDown } from 'lucide-react'
import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    ReferenceLine,
} from 'recharts'

type TimeRange = '24h' | '7d' | '30d' | 'all'
type ChartRange = '1m' | '5m' | '30m' | '1h' | '6h' | '12h' | '24h' | '7d'

interface PnlData {
    openPositions: Array<{
        id: string
        marketKey: string
        outcome: string
        title: string | null
        shares: number
        avgEntryPrice: number
        totalCostBasis: number
        currentPrice: number | null
        unrealizedPnl: number | null
        currentValue: number | null
        updatedAt: string
    }>
    closedPositions: Array<{
        id: string
        marketKey: string
        outcome: string
        title: string | null
        resolutions: Array<{
            realizedPnl: number
            resolvedOutcome: string
            resolvedAt: string
        }>
    }>
    pnlHistory: Array<{
        timestamp: string
        totalPnl: number
        unrealizedPnl: number
        realizedPnl: number
    }>
    summary: {
        totalCostBasis: number
        totalRealizedPnl: number
        totalUnrealizedPnl: number
        totalCurrentValue: number
        openPositionCount: number
        closedPositionCount: number
    }
}

export default function PnLPage() {
    const [data, setData] = useState<PnlData | null>(null)
    const [range, setRange] = useState<TimeRange>('7d')
    const [loading, setLoading] = useState(true)
    const [chartRange, setChartRange] = useState<ChartRange>('1h')
    const [chartData, setChartData] = useState<Array<{ timestamp: string; unrealizedPnl: number }>>([])

    // Fetch main P&L data
    useEffect(() => {
        async function fetchData() {
            setLoading(true)
            try {
                const res = await fetch(`/api/pnl?range=${range}`)
                const json = await res.json()
                setData(json)
            } catch (error) {
                console.error('Failed to fetch P&L data:', error)
            }
            setLoading(false)
        }
        fetchData()
    }, [range])

    // Fetch chart data
    useEffect(() => {
        async function fetchChartData() {
            try {
                const res = await fetch(`/api/pnl/chart?range=${chartRange}`)
                const json = await res.json()
                setChartData(json.dataPoints || [])
            } catch (error) {
                console.error('Failed to fetch chart data:', error)
            }
        }
        fetchChartData()
        // Refresh chart data periodically
        const interval = setInterval(fetchChartData, 10000)
        return () => clearInterval(interval)
    }, [chartRange])

    // Record P&L snapshots every 30 seconds
    useEffect(() => {
        async function recordSnapshot() {
            try {
                await fetch('/api/pnl/snapshot', { method: 'POST' })
            } catch (error) {
                console.error('Failed to record snapshot:', error)
            }
        }
        // Record immediately on load
        recordSnapshot()
        // Then every 30 seconds
        const interval = setInterval(recordSnapshot, 30000)
        return () => clearInterval(interval)
    }, [])

    if (loading) {
        return (
            <PageLayout title="P&L Dashboard" description="Loading..." icon={DollarSign}>
                <div className="flex items-center justify-center py-12">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                </div>
            </PageLayout>
        )
    }

    if (!data) {
        return (
            <PageLayout title="P&L Dashboard" description="Failed to load data" icon={DollarSign}>
                <Card>
                    <CardContent className="py-12 text-center text-muted-foreground">
                        Failed to load P&L data. Please try again.
                    </CardContent>
                </Card>
            </PageLayout>
        )
    }

    const { openPositions, closedPositions, pnlHistory, summary } = data

    return (
        <PageLayout
            title="P&L Dashboard"
            description="Track your paper trading performance"
            icon={DollarSign}
        >
            {/* Summary Cards */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                <StatCard
                    label="Total Cost Basis"
                    value={`$${summary.totalCostBasis.toFixed(2)}`}
                />
                <StatCard
                    label="Current Value"
                    value={`$${summary.totalCurrentValue.toFixed(2)}`}
                />
                <StatCard
                    label="Unrealized P&L"
                    value={`${summary.totalUnrealizedPnl >= 0 ? '+' : ''}$${summary.totalUnrealizedPnl.toFixed(2)}`}
                    variant={summary.totalUnrealizedPnl >= 0 ? 'success' : 'destructive'}
                />
                <StatCard
                    label="Realized P&L"
                    value={`${summary.totalRealizedPnl >= 0 ? '+' : ''}$${summary.totalRealizedPnl.toFixed(2)}`}
                    variant={summary.totalRealizedPnl >= 0 ? 'success' : 'destructive'}
                />
                <StatCard label="Open Positions" value={summary.openPositionCount} />
                <StatCard label="Closed Positions" value={summary.closedPositionCount} />
            </div>

            {/* Unrealized P&L Chart */}
            <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                    <CardTitle className="flex items-center gap-2">
                        <TrendingUp className="size-4" />
                        Unrealized P&L Over Time
                    </CardTitle>
                    <div className="flex gap-1 flex-wrap">
                        {(['1m', '5m', '30m', '1h', '6h', '12h', '24h', '7d'] as const).map(r => (
                            <Button
                                key={r}
                                onClick={() => setChartRange(r)}
                                variant={chartRange === r ? 'default' : 'secondary'}
                                size="sm"
                            >
                                {r}
                            </Button>
                        ))}
                    </div>
                </CardHeader>
                <CardContent>
                    {chartData.length > 1 ? (
                        <div className="h-[250px]">
                            <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={chartData}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#444" />
                                    <XAxis
                                        dataKey="timestamp"
                                        stroke="#888"
                                        fontSize={12}
                                        tickFormatter={(value) => {
                                            const date = new Date(value)
                                            if (['1m', '5m', '30m', '1h'].includes(chartRange)) {
                                                return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                            }
                                            return date.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                                        }}
                                    />
                                    <YAxis
                                        stroke="#888"
                                        fontSize={12}
                                        tickFormatter={(value) => `$${value.toFixed(2)}`}
                                    />
                                    <Tooltip
                                        contentStyle={{
                                            backgroundColor: '#1a1a1a',
                                            border: '1px solid #333',
                                            borderRadius: '6px',
                                            color: '#fff',
                                        }}
                                        labelStyle={{ color: '#fff' }}
                                        formatter={(value: number | undefined) => [value != null ? `$${value.toFixed(2)}` : '$0.00', 'Unrealized P&L']}
                                        labelFormatter={(label) => new Date(label).toLocaleString()}
                                    />
                                    <ReferenceLine y={0} stroke="#666" strokeDasharray="3 3" />
                                    <Line
                                        type="monotone"
                                        dataKey="unrealizedPnl"
                                        stroke={chartData[chartData.length - 1]?.unrealizedPnl >= 0 ? '#22c55e' : '#ef4444'}
                                        strokeWidth={3}
                                        dot={{ fill: chartData[chartData.length - 1]?.unrealizedPnl >= 0 ? '#22c55e' : '#ef4444', r: 3 }}
                                    />
                                </LineChart>
                            </ResponsiveContainer>
                        </div>
                    ) : (
                        <div className="h-[200px] flex items-center justify-center text-muted-foreground text-center">
                            <div>
                                <p>Collecting data points...</p>
                                <p className="text-sm">Snapshots are recorded every 30 seconds while this page is open.</p>
                            </div>
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* P&L Chart */}
            <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                    <CardTitle className="flex items-center gap-2">
                        <TrendingUp className="size-4" />
                        Total P&L Over Time
                        <span className="text-xs font-normal text-muted-foreground">(Realized + Unrealized)</span>
                    </CardTitle>
                    <div className="flex gap-1">
                        {(['24h', '7d', '30d', 'all'] as const).map(r => (
                            <Button
                                key={r}
                                onClick={() => setRange(r)}
                                variant={range === r ? 'default' : 'secondary'}
                                size="sm"
                            >
                                {r === 'all' ? 'All' : r.toUpperCase()}
                            </Button>
                        ))}
                    </div>
                </CardHeader>
                <CardContent>
                    {pnlHistory.length > 1 ? (
                        <div className="h-[300px]">
                            <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={pnlHistory}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#444" />
                                    <XAxis
                                        dataKey="timestamp"
                                        stroke="#888"
                                        fontSize={12}
                                        tickFormatter={(value) => new Date(value).toLocaleDateString()}
                                    />
                                    <YAxis
                                        stroke="#888"
                                        fontSize={12}
                                        tickFormatter={(value) => `$${value}`}
                                    />
                                    <Tooltip
                                        contentStyle={{
                                            backgroundColor: '#1a1a1a',
                                            border: '1px solid #333',
                                            borderRadius: '6px',
                                            color: '#fff',
                                        }}
                                        labelStyle={{ color: '#fff' }}
                                        formatter={(value: number | undefined) => [value != null ? `$${value.toFixed(2)}` : '$0.00', 'P&L']}
                                        labelFormatter={(label) => new Date(label).toLocaleString()}
                                    />
                                    <ReferenceLine y={0} stroke="#666" strokeDasharray="3 3" />
                                    <Line
                                        type="monotone"
                                        dataKey="totalPnl"
                                        stroke={pnlHistory[pnlHistory.length - 1]?.totalPnl >= 0 ? '#22c55e' : '#ef4444'}
                                        strokeWidth={3}
                                        dot={{ fill: pnlHistory[pnlHistory.length - 1]?.totalPnl >= 0 ? '#22c55e' : '#ef4444', r: 3 }}
                                    />
                                </LineChart>
                            </ResponsiveContainer>
                        </div>
                    ) : (
                        <div className="h-[200px] flex items-center justify-center text-muted-foreground">
                            No P&L history data yet. Data is recorded hourly.
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Open Positions */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <TrendingUp className="size-4" />
                        Open Positions
                    </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                    {openPositions.length === 0 ? (
                        <div className="py-12 text-center text-muted-foreground">
                            No open positions
                        </div>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Market</TableHead>
                                    <TableHead>Outcome</TableHead>
                                    <TableHead className="text-right">Shares</TableHead>
                                    <TableHead className="text-right">Avg Entry</TableHead>
                                    <TableHead className="text-right">Current</TableHead>
                                    <TableHead className="text-right">Cost Basis</TableHead>
                                    <TableHead className="text-right">P&L</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {openPositions.map(pos => (
                                    <TableRow key={pos.id}>
                                        <TableCell className="max-w-[250px] truncate">
                                            {pos.title || pos.marketKey}
                                        </TableCell>
                                        <TableCell>
                                            <Badge variant={pos.outcome === 'YES' ? 'success' : 'muted'}>
                                                {pos.outcome}
                                            </Badge>
                                        </TableCell>
                                        <TableCell className="text-right font-mono">{pos.shares.toFixed(2)}</TableCell>
                                        <TableCell className="text-right font-mono">${pos.avgEntryPrice.toFixed(3)}</TableCell>
                                        <TableCell className="text-right font-mono">
                                            {pos.currentPrice !== null ? `$${pos.currentPrice.toFixed(3)}` : '-'}
                                        </TableCell>
                                        <TableCell className="text-right font-mono">${pos.totalCostBasis.toFixed(2)}</TableCell>
                                        <TableCell className={`text-right font-mono ${pos.unrealizedPnl !== null ? (pos.unrealizedPnl >= 0 ? 'text-success' : 'text-destructive') : ''}`}>
                                            {pos.unrealizedPnl !== null ? `${pos.unrealizedPnl >= 0 ? '+' : ''}$${pos.unrealizedPnl.toFixed(2)}` : '-'}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                </CardContent>
            </Card>

            {/* Closed Positions */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <TrendingDown className="size-4" />
                        Closed Positions
                    </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                    {closedPositions.length === 0 ? (
                        <div className="py-12 text-center text-muted-foreground">
                            No closed positions yet
                        </div>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Market</TableHead>
                                    <TableHead>Outcome</TableHead>
                                    <TableHead>Resolution</TableHead>
                                    <TableHead className="text-right">Realized P&L</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {closedPositions.map(pos => {
                                    const totalPnl = pos.resolutions.reduce((sum, r) => sum + r.realizedPnl, 0)
                                    const lastResolution = pos.resolutions[pos.resolutions.length - 1]
                                    return (
                                        <TableRow key={pos.id}>
                                            <TableCell className="max-w-[300px] truncate">
                                                {pos.title || pos.marketKey}
                                            </TableCell>
                                            <TableCell>
                                                <Badge variant={pos.outcome === 'YES' ? 'success' : 'muted'}>
                                                    {pos.outcome}
                                                </Badge>
                                            </TableCell>
                                            <TableCell>{lastResolution?.resolvedOutcome || '-'}</TableCell>
                                            <TableCell className={`text-right font-mono ${totalPnl >= 0 ? 'text-success' : 'text-destructive'}`}>
                                                {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
                                            </TableCell>
                                        </TableRow>
                                    )
                                })}
                            </TableBody>
                        </Table>
                    )}
                </CardContent>
            </Card>
        </PageLayout>
    )
}
