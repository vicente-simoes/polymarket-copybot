import { prisma } from '@polymarket-bot/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { PageLayout } from '@/components/page-layout'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Settings as SettingsIcon, Check, AlertCircle } from 'lucide-react'
import { ResetButton } from './reset-button'

async function getSettings() {
    let settings = await prisma.settings.findUnique({ where: { id: 1 } })
    if (!settings) {
        settings = await prisma.settings.create({ data: { id: 1 } })
    }
    return settings
}

async function updateSettings(formData: FormData) {
    'use server'

    const updates = {
        ratioDefault: Math.max(0.001, Math.min(0.5, parseFloat(formData.get('ratioDefault') as string) || 0.01)),
        maxUsdcPerTrade: Math.max(0.01, Math.min(100, parseFloat(formData.get('maxUsdcPerTrade') as string) || 2)),
        maxUsdcPerDay: Math.max(0.1, Math.min(1000, parseFloat(formData.get('maxUsdcPerDay') as string) || 10)),
        maxPriceMovePct: Math.max(0.001, Math.min(0.1, parseFloat(formData.get('maxPriceMovePct') as string) || 0.01)),
        maxSpread: Math.max(0.001, Math.min(0.1, parseFloat(formData.get('maxSpread') as string) || 0.02)),
        sellMaxPriceMovePct: Math.max(0.001, Math.min(0.2, parseFloat(formData.get('sellMaxPriceMovePct') as string) || 0.05)),
        sellMaxSpread: Math.max(0.001, Math.min(0.2, parseFloat(formData.get('sellMaxSpread') as string) || 0.1)),
        sellAlwaysAttempt: formData.get('sellAlwaysAttempt') === 'on',
        splitMergeAlwaysFollow: formData.get('splitMergeAlwaysFollow') === 'on',
        skipMakerTrades: formData.get('skipMakerTrades') === 'on',
        maxUsdcPerEvent: Math.max(1, Math.min(1000, parseFloat(formData.get('maxUsdcPerEvent') as string) || 50)),
        maxOpenPositions: Math.max(1, Math.min(100, parseFloat(formData.get('maxOpenPositions') as string) || 10)),
        skipAbovePrice: formData.get('skipAbovePrice')?.toString().trim() ? Math.max(0.01, Math.min(0.99, parseFloat(formData.get('skipAbovePrice') as string))) : null,
        // Stage 9.1: Catch-up policies
        maxLiveLagSec: Math.max(1, Math.min(120, parseInt(formData.get('maxLiveLagSec') as string) || 15)),
        catchUpBuyMaxAgeSec: Math.max(0, Math.min(3600, parseInt(formData.get('catchUpBuyMaxAgeSec') as string) || 300)),
        catchUpBuyRequireBetter: formData.get('catchUpBuyRequireBetter') === 'on',
        catchUpBuyMaxWorseBps: Math.max(0, Math.min(500, parseInt(formData.get('catchUpBuyMaxWorseBps') as string) || 20)),
    }

    await prisma.settings.upsert({
        where: { id: 1 },
        update: updates,
        create: { id: 1, ...updates },
    })

    revalidatePath('/settings')
    redirect('/settings?success=true')
}

export default async function SettingsPage(
    props: {
        searchParams?: Promise<{ [key: string]: string | string[] | undefined }>
    }
) {
    const searchParams = await props.searchParams
    const settings = await getSettings()
    const showSuccess = searchParams?.success === 'true'

    return (
        <PageLayout
            title="Settings"
            description="Configure global guardrails for copy trading"
            icon={SettingsIcon}
        >
            {showSuccess && (
                <Card className="border-success/30 bg-success/10">
                    <CardContent className="p-4 flex items-center gap-3">
                        <div className="size-8 rounded-full bg-success/20 flex items-center justify-center">
                            <Check className="size-4 text-success" />
                        </div>
                        <div>
                            <div className="font-medium text-success">Settings saved successfully!</div>
                            <div className="text-sm text-muted-foreground">Your changes have been applied.</div>
                        </div>
                    </CardContent>
                </Card>
            )}

            <form action={updateSettings} className="space-y-6">
                {/* Base Guardrails */}
                <Card>
                    <CardHeader>
                        <CardTitle>Base Guardrails</CardTitle>
                        <CardDescription>
                            These settings apply to BUY operations by default. Changes take effect immediately.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                            <div className="space-y-2">
                                <Label htmlFor="ratioDefault">
                                    Copy Ratio
                                    <span className="text-muted-foreground ml-2 font-normal">
                                        (leader $100 → you ${(settings.ratioDefault * 100).toFixed(0)})
                                    </span>
                                </Label>
                                <Input
                                    id="ratioDefault"
                                    name="ratioDefault"
                                    type="number"
                                    step="0.001"
                                    min="0.001"
                                    max="0.5"
                                    defaultValue={settings.ratioDefault}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="maxUsdcPerTrade">Max USDC Per Trade</Label>
                                <Input
                                    id="maxUsdcPerTrade"
                                    name="maxUsdcPerTrade"
                                    type="number"
                                    step="any"
                                    min="0.01"
                                    max="100"
                                    defaultValue={settings.maxUsdcPerTrade}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="maxUsdcPerDay">Max USDC Per Day</Label>
                                <Input
                                    id="maxUsdcPerDay"
                                    name="maxUsdcPerDay"
                                    type="number"
                                    step="any"
                                    min="0.1"
                                    max="1000"
                                    defaultValue={settings.maxUsdcPerDay}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="maxPriceMovePct">
                                    Max Price Move %
                                    <span className="text-muted-foreground ml-2 font-normal">
                                        ({(settings.maxPriceMovePct * 100).toFixed(1)}%)
                                    </span>
                                </Label>
                                <Input
                                    id="maxPriceMovePct"
                                    name="maxPriceMovePct"
                                    type="number"
                                    step="0.001"
                                    min="0.001"
                                    max="0.1"
                                    defaultValue={settings.maxPriceMovePct}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="maxSpread">Max Spread (USDC)</Label>
                                <Input
                                    id="maxSpread"
                                    name="maxSpread"
                                    type="number"
                                    step="0.001"
                                    min="0.001"
                                    max="0.1"
                                    defaultValue={settings.maxSpread}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="maxOpenPositions">Max Open Positions</Label>
                                <Input
                                    id="maxOpenPositions"
                                    name="maxOpenPositions"
                                    type="number"
                                    step="1"
                                    min="1"
                                    max="100"
                                    defaultValue={settings.maxOpenPositions}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="maxUsdcPerEvent">Max USDC Per Event</Label>
                                <Input
                                    id="maxUsdcPerEvent"
                                    name="maxUsdcPerEvent"
                                    type="number"
                                    step="1"
                                    min="1"
                                    max="1000"
                                    defaultValue={settings.maxUsdcPerEvent}
                                />
                            </div>
                            <div className="flex items-center gap-3 pt-6">
                                <input
                                    id="skipMakerTrades"
                                    name="skipMakerTrades"
                                    type="checkbox"
                                    defaultChecked={settings.skipMakerTrades}
                                    className="size-4 rounded border-border"
                                />
                                <Label htmlFor="skipMakerTrades" className="font-normal cursor-pointer">
                                    <span className="font-medium">Skip Maker Trades (Global)</span>
                                    <span className="block text-xs text-muted-foreground">Skip trades where leader provided liquidity</span>
                                </Label>
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="skipAbovePrice">
                                    Skip Above Price (Probability)
                                    <span className="text-muted-foreground ml-2 font-normal">
                                        {settings.skipAbovePrice ? `(${(settings.skipAbovePrice * 100).toFixed(0)}¢)` : '(disabled)'}
                                    </span>
                                </Label>
                                <Input
                                    id="skipAbovePrice"
                                    name="skipAbovePrice"
                                    type="number"
                                    step="0.01"
                                    min="0.01"
                                    max="0.99"
                                    placeholder="e.g. 0.97 = skip 97¢ or higher"
                                    defaultValue={settings.skipAbovePrice ?? ''}
                                />
                                <p className="text-xs text-muted-foreground">Leave empty to disable. Skip BUY trades where share price is at or above this threshold.</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* SELL Operation Settings */}
                <Card>
                    <CardHeader>
                        <CardTitle>SELL Operation Settings</CardTitle>
                        <CardDescription>
                            More lenient settings for SELL operations. When the leader exits, you should too.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                            <div className="space-y-2">
                                <Label htmlFor="sellMaxPriceMovePct">
                                    SELL Max Price Move %
                                    <span className="text-muted-foreground ml-2 font-normal">
                                        ({(settings.sellMaxPriceMovePct * 100).toFixed(1)}%)
                                    </span>
                                </Label>
                                <Input
                                    id="sellMaxPriceMovePct"
                                    name="sellMaxPriceMovePct"
                                    type="number"
                                    step="any"
                                    min="0.001"
                                    max="0.2"
                                    defaultValue={settings.sellMaxPriceMovePct}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="sellMaxSpread">SELL Max Spread (USDC)</Label>
                                <Input
                                    id="sellMaxSpread"
                                    name="sellMaxSpread"
                                    type="number"
                                    step="any"
                                    min="0.001"
                                    max="0.2"
                                    defaultValue={settings.sellMaxSpread}
                                />
                            </div>
                            <div className="flex items-center gap-3 pt-6">
                                <input
                                    id="sellAlwaysAttempt"
                                    name="sellAlwaysAttempt"
                                    type="checkbox"
                                    defaultChecked={settings.sellAlwaysAttempt}
                                    className="size-4 rounded border-border"
                                />
                                <Label htmlFor="sellAlwaysAttempt" className="font-normal cursor-pointer">
                                    <span className="font-medium">Always Attempt SELL</span>
                                    <span className="block text-xs text-muted-foreground">Never skip SELL for price/spread</span>
                                </Label>
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* SPLIT/MERGE Settings */}
                <Card>
                    <CardHeader>
                        <CardTitle>SPLIT/MERGE Operation Settings</CardTitle>
                        <CardDescription>
                            Structural operations that should typically be followed exactly.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="flex items-center gap-3">
                            <input
                                id="splitMergeAlwaysFollow"
                                name="splitMergeAlwaysFollow"
                                type="checkbox"
                                defaultChecked={settings.splitMergeAlwaysFollow}
                                className="size-4 rounded border-border"
                            />
                            <Label htmlFor="splitMergeAlwaysFollow" className="font-normal cursor-pointer">
                                <span className="font-medium">Always Follow SPLIT/MERGE</span>
                                <span className="block text-xs text-muted-foreground">Mirror leader's structural operations exactly</span>
                            </Label>
                        </div>
                    </CardContent>
                </Card>

                {/* Stage 9.1: Catch-Up Policies */}
                <Card>
                    <CardHeader>
                        <CardTitle>Catch-Up Policies</CardTitle>
                        <CardDescription>
                            Controls for how "stale" trades are handled. Trades older than maxLiveLagSec are considered catch-up trades.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                            <div className="space-y-2">
                                <Label htmlFor="maxLiveLagSec">
                                    Max Live Lag (sec)
                                    <span className="text-muted-foreground ml-2 font-normal">
                                        ({settings.maxLiveLagSec}s)
                                    </span>
                                </Label>
                                <Input
                                    id="maxLiveLagSec"
                                    name="maxLiveLagSec"
                                    type="number"
                                    step="1"
                                    min="1"
                                    max="120"
                                    defaultValue={settings.maxLiveLagSec}
                                />
                                <p className="text-xs text-muted-foreground">Trades within this window are &quot;live&quot;</p>
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="catchUpBuyMaxAgeSec">
                                    Catch-Up Buy Max Age (sec)
                                    <span className="text-muted-foreground ml-2 font-normal">
                                        ({settings.catchUpBuyMaxAgeSec}s)
                                    </span>
                                </Label>
                                <Input
                                    id="catchUpBuyMaxAgeSec"
                                    name="catchUpBuyMaxAgeSec"
                                    type="number"
                                    step="1"
                                    min="0"
                                    max="3600"
                                    defaultValue={settings.catchUpBuyMaxAgeSec}
                                />
                                <p className="text-xs text-muted-foreground">Max age for catch-up buys (0 = disabled)</p>
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="catchUpBuyMaxWorseBps">
                                    Max Worse (bps)
                                    <span className="text-muted-foreground ml-2 font-normal">
                                        ({settings.catchUpBuyMaxWorseBps} bps)
                                    </span>
                                </Label>
                                <Input
                                    id="catchUpBuyMaxWorseBps"
                                    name="catchUpBuyMaxWorseBps"
                                    type="number"
                                    step="1"
                                    min="0"
                                    max="500"
                                    defaultValue={settings.catchUpBuyMaxWorseBps}
                                />
                                <p className="text-xs text-muted-foreground">Max bps worse than leader price</p>
                            </div>
                            <div className="flex items-center gap-3 pt-6">
                                <input
                                    id="catchUpBuyRequireBetter"
                                    name="catchUpBuyRequireBetter"
                                    type="checkbox"
                                    defaultChecked={settings.catchUpBuyRequireBetter}
                                    className="size-4 rounded border-border"
                                />
                                <Label htmlFor="catchUpBuyRequireBetter" className="font-normal cursor-pointer">
                                    <span className="font-medium">Require Better Price</span>
                                    <span className="block text-xs text-muted-foreground">Only catch-up if price is same or better</span>
                                </Label>
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* Submit */}
                <div className="flex justify-end">
                    <Button type="submit" size="lg">
                        Save Settings
                    </Button>
                </div>
            </form>

            {/* Stage 9.3: Reset Paper State */}
            <Card className="border-destructive/30">
                <CardHeader>
                    <CardTitle className="text-destructive">Danger Zone</CardTitle>
                    <CardDescription>
                        Reset paper trading state. This will delete all paper intents, fills, and positions.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <form id="reset-form" action="/api/reset" method="POST">
                        <input type="hidden" name="confirm" value="true" />
                        <ResetButton />
                    </form>
                </CardContent>
            </Card>

            {/* Current Values Summary */}
            <Card className="bg-muted/50">
                <CardHeader>
                    <CardTitle className="text-base">Current Configuration Summary</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
                        <div>
                            <div className="text-xs text-muted-foreground mb-1">Copy Ratio</div>
                            <div className="font-mono text-sm">{(settings.ratioDefault * 100).toFixed(2)}%</div>
                        </div>
                        <div>
                            <div className="text-xs text-muted-foreground mb-1">Max/Trade</div>
                            <div className="font-mono text-sm">${settings.maxUsdcPerTrade.toFixed(2)}</div>
                        </div>
                        <div>
                            <div className="text-xs text-muted-foreground mb-1">Max/Day</div>
                            <div className="font-mono text-sm">${settings.maxUsdcPerDay.toFixed(2)}</div>
                        </div>
                        <div>
                            <div className="text-xs text-muted-foreground mb-1">SELL Always</div>
                            <Badge variant={settings.sellAlwaysAttempt ? 'success' : 'muted'}>
                                {settings.sellAlwaysAttempt ? 'Yes' : 'No'}
                            </Badge>
                        </div>
                        <div>
                            <div className="text-xs text-muted-foreground mb-1">SPLIT/MERGE Follow</div>
                            <Badge variant={settings.splitMergeAlwaysFollow ? 'success' : 'muted'}>
                                {settings.splitMergeAlwaysFollow ? 'Yes' : 'No'}
                            </Badge>
                        </div>
                        <div>
                            <div className="text-xs text-muted-foreground mb-1">Max Positions</div>
                            <div className="font-mono text-sm">{settings.maxOpenPositions}</div>
                        </div>
                        <div>
                            <div className="text-xs text-muted-foreground mb-1">Skip Maker</div>
                            <Badge variant={settings.skipMakerTrades ? 'destructive' : 'muted'}>
                                {settings.skipMakerTrades ? 'Skip' : 'Allow'}
                            </Badge>
                        </div>
                    </div>
                    <div className="mt-4 text-xs text-muted-foreground">
                        Last updated: {settings.updatedAt.toLocaleString()}
                    </div>
                </CardContent>
            </Card>
        </PageLayout>
    )
}
