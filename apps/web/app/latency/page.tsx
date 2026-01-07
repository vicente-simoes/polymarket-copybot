'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import { Zap, Activity, Clock, Trophy } from 'lucide-react';
import { cn } from '@/lib/utils';

interface LatencyStats {
    polygonWins: number;
    dataApiWins: number;
    ties: number;
    avgDeltaMs: number | null;
    totalEvents: number;
}

interface RecentComparison {
    dedupeKey: string;
    polygonAt: string | null;
    dataApiAt: string | null;
    deltaMs: number | null;
    winner: string;
    usdcAmount: number;
    side: string;
}

interface LatencyData {
    current: {
        triggerMode: string;
        polygonHealthy: boolean;
        polygonLastEvent: string | null;
        dataApiHealthy: boolean;
        dataApiLastEvent: string | null;
    };
    stats: {
        last24h: LatencyStats;
        lastWeek: LatencyStats;
    };
    recentComparisons: RecentComparison[];
}

export default function LatencyPage() {
    const [data, setData] = useState<LatencyData | null>(null);
    const [loading, setLoading] = useState(true);
    const [changingMode, setChangingMode] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchData = async () => {
        try {
            const res = await fetch('/api/latency');
            if (!res.ok) throw new Error('Failed to fetch');
            const json = await res.json();
            setData(json);
            setError(null);
        } catch (err) {
            setError('Failed to load latency data');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 5000);
        return () => clearInterval(interval);
    }, []);

    const changeMode = async (mode: string) => {
        setChangingMode(true);
        try {
            const res = await fetch('/api/trigger-mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode }),
            });
            if (!res.ok) throw new Error('Failed to update');
            await fetchData();
        } catch (err) {
            setError('Failed to change mode');
        } finally {
            setChangingMode(false);
        }
    };

    if (loading) {
        return (
            <div className="p-8 space-y-8">
                <div className="flex items-center gap-3">
                    <div className="h-10 w-10 bg-muted rounded-full animate-pulse" />
                    <div className="h-10 w-48 bg-muted rounded animate-pulse" />
                </div>
                <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
                    {[1, 2, 3, 4].map((i) => (
                        <Card key={i} className="animate-pulse">
                            <CardHeader className="h-24 bg-muted/50" />
                            <CardContent className="h-12" />
                        </Card>
                    ))}
                </div>
            </div>
        );
    }

    if (error || !data) {
        return (
            <div className="p-8">
                <Card className="border-destructive/50 bg-destructive/10">
                    <CardHeader>
                        <CardTitle className="text-destructive">Error Loading Data</CardTitle>
                        <CardDescription>{error || 'No data available'}</CardDescription>
                    </CardHeader>
                </Card>
            </div>
        );
    }

    const formatDelta = (ms: number | null) => {
        if (ms === null) return '—';
        const seconds = Math.abs(ms) / 1000;
        const sign = ms > 0 ? '+' : '';
        return `${sign}${seconds.toFixed(2)}s`;
    };

    const formatTime = (iso: string | null) => {
        if (!iso) return '—';
        return new Date(iso).toLocaleTimeString();
    };

    const winRate = data.stats.last24h.totalEvents > 0
        ? Math.round((data.stats.last24h.polygonWins / data.stats.last24h.totalEvents) * 100)
        : 0;

    return (
        <div className="flex-1 space-y-8 p-8 pt-6">
            <div className="flex items-center justify-between space-y-2">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">Latency Monitoring</h2>
                    <p className="text-muted-foreground">
                        Real-time comparison between Polygon RPC and Data API
                    </p>
                </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
                {/* Mode Control */}
                <Card className="col-span-3">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Activity className="h-5 w-5 text-primary" />
                            Trigger Mode
                        </CardTitle>
                        <CardDescription>
                            Current mode: <span className="font-semibold text-primary capitalize">{data.current.triggerMode}</span>
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="flex gap-2">
                            {['data_api', 'polygon', 'both'].map((mode) => (
                                <Button
                                    key={mode}
                                    variant={data.current.triggerMode === mode ? 'default' : 'outline'}
                                    onClick={() => changeMode(mode)}
                                    disabled={changingMode}
                                    className="flex-1 capitalize"
                                >
                                    {mode.replace('_', ' ')}
                                </Button>
                            ))}
                        </div>
                    </CardContent>
                </Card>

                {/* Health Status */}
                <Card className="col-span-4">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Zap className="h-5 w-5 text-yellow-500" />
                            Source Health
                        </CardTitle>
                        <CardDescription>Status of event streams</CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-4 md:grid-cols-2">
                        <div className="flex flex-col space-y-2 p-3 bg-muted/50 rounded-lg">
                            <div className="flex items-center gap-2">
                                <div className={cn("h-2.5 w-2.5 rounded-full", data.current.polygonHealthy ? "bg-green-500" : "bg-red-500")} />
                                <span className="font-medium">Polygon RPC</span>
                            </div>
                            <span className="text-xs text-muted-foreground">Last: {formatTime(data.current.polygonLastEvent)}</span>
                        </div>
                        <div className="flex flex-col space-y-2 p-3 bg-muted/50 rounded-lg">
                            <div className="flex items-center gap-2">
                                <div className={cn("h-2.5 w-2.5 rounded-full", data.current.dataApiHealthy ? "bg-green-500" : "bg-red-500")} />
                                <span className="font-medium">Data API</span>
                            </div>
                            <span className="text-xs text-muted-foreground">Last: {formatTime(data.current.dataApiLastEvent)}</span>
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Stats Cards */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Polygon Wins (24h)</CardTitle>
                        <Trophy className="h-4 w-4 text-green-500" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold text-green-500">{data.stats.last24h.polygonWins}</div>
                        <p className="text-xs text-muted-foreground">Faster detections</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Data API Wins (24h)</CardTitle>
                        <Activity className="h-4 w-4 text-orange-500" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold text-orange-500">{data.stats.last24h.dataApiWins}</div>
                        <p className="text-xs text-muted-foreground">Faster detections</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Polygon Win Rate</CardTitle>
                        <Zap className="h-4 w-4 text-blue-500" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold text-blue-500">{winRate}%</div>
                        <p className="text-xs text-muted-foreground">vs Data API</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Avg Advantage</CardTitle>
                        <Clock className="h-4 w-4 text-purple-500" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold text-purple-500">
                            {formatDelta(data.stats.last24h.avgDeltaMs)}
                        </div>
                        <p className="text-xs text-muted-foreground">Time saved per trade</p>
                    </CardContent>
                </Card>
            </div>

            {/* Recent Comparisons Table */}
            <Card>
                <CardHeader>
                    <CardTitle>Recent Detections</CardTitle>
                    <CardDescription>
                        Comparison of detection times for the last 100 trades
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Trade</TableHead>
                                <TableHead>Polygon Time</TableHead>
                                <TableHead>Data API Time</TableHead>
                                <TableHead>Delta</TableHead>
                                <TableHead>Winner</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {data.recentComparisons.map((comp, i) => (
                                <TableRow key={i}>
                                    <TableCell>
                                        <div className="flex flex-col">
                                            <span className={cn("font-medium", comp.side === 'BUY' ? 'text-green-500' : 'text-red-500')}>
                                                {comp.side}
                                            </span>
                                            <span className="text-xs text-muted-foreground">${comp.usdcAmount.toFixed(2)}</span>
                                        </div>
                                    </TableCell>
                                    <TableCell className="font-mono text-xs">
                                        {formatTime(comp.polygonAt)}
                                    </TableCell>
                                    <TableCell className="font-mono text-xs">
                                        {formatTime(comp.dataApiAt)}
                                    </TableCell>
                                    <TableCell>
                                        <Badge variant="outline" className={cn(
                                            "font-mono",
                                            comp.deltaMs && comp.deltaMs > 0 ? "text-green-500 border-green-500/30 bg-green-500/10" : "text-muted-foreground"
                                        )}>
                                            {formatDelta(comp.deltaMs)}
                                        </Badge>
                                    </TableCell>
                                    <TableCell>
                                        {comp.winner === 'polygon' && <Badge variant="default" className="bg-green-500 hover:bg-green-600">Polygon</Badge>}
                                        {comp.winner === 'data_api' && <Badge variant="secondary" className="bg-orange-500/10 text-orange-500 hover:bg-orange-500/20">Data API</Badge>}
                                        {comp.winner === 'tie' && <Badge variant="outline">Tie</Badge>}
                                        {comp.winner === 'incomplete' && <Badge variant="outline" className="text-muted-foreground animate-pulse">Pending</Badge>}
                                    </TableCell>
                                </TableRow>
                            ))}
                            {data.recentComparisons.length === 0 && (
                                <TableRow>
                                    <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                                        No recent detections. Run with TRIGGER_MODE=both to capture data.
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    );
}
