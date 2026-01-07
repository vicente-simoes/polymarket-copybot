import { prisma } from '@polymarket-bot/db'
import { revalidatePath } from 'next/cache'
import { PageLayout } from '@/components/page-layout'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Users, Plus, Pause, Play, Trash2 } from 'lucide-react'

async function getLeaders() {
    return prisma.leader.findMany({
        orderBy: { createdAt: 'desc' },
    })
}

async function getGlobalSettings() {
    let settings = await prisma.settings.findUnique({ where: { id: 1 } })
    if (!settings) {
        settings = await prisma.settings.create({ data: { id: 1 } })
    }
    return settings
}

// Server Actions
async function addLeader(formData: FormData) {
    'use server'
    const label = formData.get('label') as string
    const wallet = formData.get('wallet') as string

    if (!label || !wallet) return

    try {
        await prisma.leader.create({
            data: { label, wallet, enabled: true },
        })
        revalidatePath('/leaders')
    } catch (error) {
        console.error('Failed to add leader', error)
    }
}

async function toggleLeader(id: string, enabled: boolean) {
    'use server'
    await prisma.leader.update({
        where: { id },
        data: { enabled },
    })
    revalidatePath('/leaders')
}

async function deleteLeader(id: string) {
    'use server'
    await prisma.$transaction(async (tx) => {
        const trades = await tx.trade.findMany({
            where: { leaderId: id },
            select: { id: true },
        })
        const tradeIds = trades.map(t => t.id)

        if (tradeIds.length > 0) {
            await tx.paperFill.deleteMany({
                where: { intent: { tradeId: { in: tradeIds } } },
            })
            await tx.paperIntent.deleteMany({
                where: { tradeId: { in: tradeIds } },
            })
        }

        await tx.trade.deleteMany({ where: { leaderId: id } })
        await tx.tradeRaw.deleteMany({ where: { leaderId: id } })
        await tx.leader.delete({ where: { id } })
    })

    revalidatePath('/leaders')
}

async function updateLeaderOverrides(formData: FormData) {
    'use server'
    const id = formData.get('id') as string
    const ratioStr = formData.get('ratio') as string
    const maxTradeStr = formData.get('maxUsdcPerTrade') as string
    const maxDayStr = formData.get('maxUsdcPerDay') as string
    const skipMakerStr = formData.get('skipMakerTrades') as string

    const ratio = ratioStr?.trim() ? parseFloat(ratioStr) : null
    const maxUsdcPerTrade = maxTradeStr?.trim() ? parseFloat(maxTradeStr) : null
    const maxUsdcPerDay = maxDayStr?.trim() ? parseFloat(maxDayStr) : null
    // Tri-state: 'true' = override to true, 'false' = override to false, '' = null (use global)
    const skipMakerTrades = skipMakerStr === 'true' ? true : skipMakerStr === 'false' ? false : null

    await prisma.leader.update({
        where: { id },
        data: { ratio, maxUsdcPerTrade, maxUsdcPerDay, skipMakerTrades },
    })
    revalidatePath('/leaders')
}

export default async function LeadersPage() {
    const leaders = await getLeaders()
    const globalSettings = await getGlobalSettings()

    return (
        <PageLayout
            title="Leader Management"
            description="Configure wallets to copy trade with optional per-leader overrides"
            icon={Users}
        >
            {/* Add New Leader Form */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Plus className="size-4" />
                        Add New Leader
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <form action={addLeader} className="flex flex-col md:flex-row gap-4">
                        <div className="flex-1 space-y-2">
                            <Label htmlFor="label">Label</Label>
                            <Input name="label" id="label" placeholder="e.g. Top Trader 1" required />
                        </div>
                        <div className="flex-[3] space-y-2">
                            <Label htmlFor="wallet">Wallet Address</Label>
                            <Input
                                name="wallet"
                                id="wallet"
                                placeholder="0x..."
                                className="font-mono"
                                required
                                pattern="^0x[a-fA-F0-9]{40}$"
                            />
                        </div>
                        <div className="flex items-end">
                            <Button type="submit">
                                <Plus className="size-4 mr-2" />
                                Add Leader
                            </Button>
                        </div>
                    </form>
                </CardContent>
            </Card>

            {/* Global Defaults Info */}
            <Card className="bg-muted/50">
                <CardContent className="p-4">
                    <h4 className="text-sm font-medium mb-2">Global Defaults</h4>
                    <p className="text-xs text-muted-foreground mb-3">
                        Leaders use these values unless overridden below.{' '}
                        <a href="/settings" className="text-primary hover:underline">Edit in Settings →</a>
                    </p>
                    <div className="flex flex-wrap gap-6">
                        <div>
                            <span className="text-xs text-muted-foreground">Ratio</span>
                            <div className="font-mono text-sm">{(globalSettings.ratioDefault * 100).toFixed(2)}%</div>
                        </div>
                        <div>
                            <span className="text-xs text-muted-foreground">Max/Trade</span>
                            <div className="font-mono text-sm">${globalSettings.maxUsdcPerTrade}</div>
                        </div>
                        <div>
                            <span className="text-xs text-muted-foreground">Max/Day</span>
                            <div className="font-mono text-sm">${globalSettings.maxUsdcPerDay}</div>
                        </div>
                        <div>
                            <span className="text-xs text-muted-foreground">Skip Maker</span>
                            <div className="font-mono text-sm">{globalSettings.skipMakerTrades ? 'Yes' : 'No'}</div>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Leaders List */}
            {leaders.length === 0 ? (
                <Card>
                    <CardContent className="py-12 text-center text-muted-foreground">
                        No leaders configured yet.
                    </CardContent>
                </Card>
            ) : (
                <div className="space-y-4">
                    {leaders.map(leader => (
                        <Card key={leader.id}>
                            <CardContent className="p-4">
                                <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
                                    <div>
                                        <div className="flex items-center gap-2 mb-1">
                                            <Badge variant={leader.enabled ? 'success' : 'muted'}>
                                                {leader.enabled ? 'Active' : 'Paused'}
                                            </Badge>
                                            <span className="font-semibold">{leader.label}</span>
                                        </div>
                                        <div className="text-sm text-muted-foreground font-mono">{leader.wallet}</div>
                                    </div>
                                    <div className="flex gap-2">
                                        <form action={toggleLeader.bind(null, leader.id, !leader.enabled)}>
                                            <Button type="submit" variant="secondary" size="sm">
                                                {leader.enabled ? <Pause className="size-3 mr-1" /> : <Play className="size-3 mr-1" />}
                                                {leader.enabled ? 'Pause' : 'Enable'}
                                            </Button>
                                        </form>
                                        <form action={deleteLeader.bind(null, leader.id)}>
                                            <Button type="submit" variant="secondary" size="sm" className="text-destructive hover:text-destructive">
                                                <Trash2 className="size-3 mr-1" />
                                                Delete
                                            </Button>
                                        </form>
                                    </div>
                                </div>

                                {/* Override Fields */}
                                <form action={updateLeaderOverrides}>
                                    <input type="hidden" name="id" value={leader.id} />
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 p-4 bg-muted/50 rounded-md">
                                        <div className="space-y-2">
                                            <Label className="text-xs">
                                                Copy Ratio
                                                <span className="text-muted-foreground ml-1">
                                                    {leader.ratio !== null ? '(override)' : '(global)'}
                                                </span>
                                            </Label>
                                            <Input
                                                name="ratio"
                                                type="number"
                                                step="0.001"
                                                min="0.001"
                                                max="0.5"
                                                placeholder={String(globalSettings.ratioDefault)}
                                                defaultValue={leader.ratio ?? ''}
                                                className="h-9"
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <Label className="text-xs">
                                                Max USDC/Trade
                                                <span className="text-muted-foreground ml-1">
                                                    {leader.maxUsdcPerTrade !== null ? '(override)' : '(global)'}
                                                </span>
                                            </Label>
                                            <Input
                                                name="maxUsdcPerTrade"
                                                type="number"
                                                step="0.1"
                                                min="0.01"
                                                max="100"
                                                placeholder={String(globalSettings.maxUsdcPerTrade)}
                                                defaultValue={leader.maxUsdcPerTrade ?? ''}
                                                className="h-9"
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <Label className="text-xs">
                                                Max USDC/Day
                                                <span className="text-muted-foreground ml-1">
                                                    {leader.maxUsdcPerDay !== null ? '(override)' : '(global)'}
                                                </span>
                                            </Label>
                                            <Input
                                                name="maxUsdcPerDay"
                                                type="number"
                                                step="1"
                                                min="0.1"
                                                max="1000"
                                                placeholder={String(globalSettings.maxUsdcPerDay)}
                                                defaultValue={leader.maxUsdcPerDay ?? ''}
                                                className="h-9"
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <Label className="text-xs">
                                                Skip Maker Trades
                                                <span className="text-muted-foreground ml-1">
                                                    {leader.skipMakerTrades !== null ? '(override)' : '(global)'}
                                                </span>
                                            </Label>
                                            <select
                                                name="skipMakerTrades"
                                                defaultValue={leader.skipMakerTrades === null ? '' : String(leader.skipMakerTrades)}
                                                className="w-full h-9 px-3 rounded-md border bg-background text-sm"
                                            >
                                                <option value="">Use Global ({globalSettings.skipMakerTrades ? 'Skip' : 'Allow'})</option>
                                                <option value="false">Allow Maker Trades</option>
                                                <option value="true">Skip Maker Trades</option>
                                            </select>
                                        </div>
                                        <div className="flex items-end">
                                            <Button type="submit" size="sm" className="w-full">
                                                Save Overrides
                                            </Button>
                                        </div>
                                    </div>
                                    <p className="text-xs text-muted-foreground mt-2">
                                        Leave fields empty to use global defaults.
                                    </p>
                                </form>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}
        </PageLayout>
    )
}
