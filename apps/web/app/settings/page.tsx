import { prisma } from '@polymarket-bot/db';
import { revalidatePath } from 'next/cache';

async function getSettings() {
    let settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings) {
        settings = await prisma.settings.create({ data: { id: 1 } });
    }
    return settings;
}

// Server Action: Update settings
async function updateSettings(formData: FormData) {
    'use server';

    // Parse and validate all fields
    const updates = {
        ratioDefault: Math.max(0.001, Math.min(0.5, parseFloat(formData.get('ratioDefault') as string) || 0.01)),
        maxUsdcPerTrade: Math.max(0.01, Math.min(100, parseFloat(formData.get('maxUsdcPerTrade') as string) || 2)),
        maxUsdcPerDay: Math.max(0.1, Math.min(1000, parseFloat(formData.get('maxUsdcPerDay') as string) || 10)),
        maxPriceMovePct: Math.max(0.001, Math.min(0.1, parseFloat(formData.get('maxPriceMovePct') as string) || 0.01)),
        maxSpread: Math.max(0.001, Math.min(0.1, parseFloat(formData.get('maxSpread') as string) || 0.02)),
        // Operation-specific
        sellMaxPriceMovePct: Math.max(0.001, Math.min(0.2, parseFloat(formData.get('sellMaxPriceMovePct') as string) || 0.05)),
        sellMaxSpread: Math.max(0.001, Math.min(0.2, parseFloat(formData.get('sellMaxSpread') as string) || 0.1)),
        sellAlwaysAttempt: formData.get('sellAlwaysAttempt') === 'on',
        splitMergeAlwaysFollow: formData.get('splitMergeAlwaysFollow') === 'on',
    };

    await prisma.settings.upsert({
        where: { id: 1 },
        update: updates,
        create: { id: 1, ...updates },
    });

    revalidatePath('/settings');
}

export default async function SettingsPage() {
    const settings = await getSettings();

    return (
        <div className="animate-fade-in">
            <div className="page-header">
                <h1 className="page-title">Settings</h1>
                <p className="page-subtitle">Configure global guardrails for copy trading</p>
            </div>

            <form action={updateSettings}>
                {/* Base Guardrails */}
                <div className="card mb-4">
                    <h3 className="mb-4">Base Guardrails</h3>
                    <p className="text-muted mb-4" style={{ fontSize: '0.9rem' }}>
                        These settings apply to BUY operations by default. Changes take effect immediately.
                    </p>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '1.5rem' }}>
                        <div>
                            <label className="stat-label" style={{ display: 'block', marginBottom: '0.5rem' }}>
                                Copy Ratio
                                <span style={{ fontWeight: 'normal', color: 'var(--text-muted)', marginLeft: '0.5rem' }}>
                                    (leader $100 → you ${(settings.ratioDefault * 100).toFixed(0)})
                                </span>
                            </label>
                            <input
                                name="ratioDefault"
                                type="number"
                                step="0.001"
                                min="0.001"
                                max="0.5"
                                defaultValue={settings.ratioDefault}
                                className="input-field"
                            />
                        </div>

                        <div>
                            <label className="stat-label" style={{ display: 'block', marginBottom: '0.5rem' }}>
                                Max USDC Per Trade
                            </label>
                            <input
                                name="maxUsdcPerTrade"
                                type="number"
                                step="0.1"
                                min="0.01"
                                max="100"
                                defaultValue={settings.maxUsdcPerTrade}
                                className="input-field"
                            />
                        </div>

                        <div>
                            <label className="stat-label" style={{ display: 'block', marginBottom: '0.5rem' }}>
                                Max USDC Per Day
                            </label>
                            <input
                                name="maxUsdcPerDay"
                                type="number"
                                step="1"
                                min="0.1"
                                max="1000"
                                defaultValue={settings.maxUsdcPerDay}
                                className="input-field"
                            />
                        </div>

                        <div>
                            <label className="stat-label" style={{ display: 'block', marginBottom: '0.5rem' }}>
                                Max Price Move %
                                <span style={{ fontWeight: 'normal', color: 'var(--text-muted)', marginLeft: '0.5rem' }}>
                                    ({(settings.maxPriceMovePct * 100).toFixed(1)}%)
                                </span>
                            </label>
                            <input
                                name="maxPriceMovePct"
                                type="number"
                                step="0.001"
                                min="0.001"
                                max="0.1"
                                defaultValue={settings.maxPriceMovePct}
                                className="input-field"
                            />
                        </div>

                        <div>
                            <label className="stat-label" style={{ display: 'block', marginBottom: '0.5rem' }}>
                                Max Spread (USDC)
                            </label>
                            <input
                                name="maxSpread"
                                type="number"
                                step="0.001"
                                min="0.001"
                                max="0.1"
                                defaultValue={settings.maxSpread}
                                className="input-field"
                            />
                        </div>
                    </div>
                </div>

                {/* Operation-Specific Settings */}
                <div className="card mb-4">
                    <h3 className="mb-4">SELL Operation Settings</h3>
                    <p className="text-muted mb-4" style={{ fontSize: '0.9rem' }}>
                        More lenient settings for SELL operations. When the leader exits, you should too.
                    </p>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '1.5rem' }}>
                        <div>
                            <label className="stat-label" style={{ display: 'block', marginBottom: '0.5rem' }}>
                                SELL Max Price Move %
                                <span style={{ fontWeight: 'normal', color: 'var(--text-muted)', marginLeft: '0.5rem' }}>
                                    ({(settings.sellMaxPriceMovePct * 100).toFixed(1)}%)
                                </span>
                            </label>
                            <input
                                name="sellMaxPriceMovePct"
                                type="number"
                                step="0.01"
                                min="0.001"
                                max="0.2"
                                defaultValue={settings.sellMaxPriceMovePct}
                                className="input-field"
                            />
                        </div>

                        <div>
                            <label className="stat-label" style={{ display: 'block', marginBottom: '0.5rem' }}>
                                SELL Max Spread (USDC)
                            </label>
                            <input
                                name="sellMaxSpread"
                                type="number"
                                step="0.01"
                                min="0.001"
                                max="0.2"
                                defaultValue={settings.sellMaxSpread}
                                className="input-field"
                            />
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                            <input
                                name="sellAlwaysAttempt"
                                type="checkbox"
                                id="sellAlwaysAttempt"
                                defaultChecked={settings.sellAlwaysAttempt}
                                style={{ width: '1.25rem', height: '1.25rem' }}
                            />
                            <label htmlFor="sellAlwaysAttempt" className="stat-label" style={{ margin: 0 }}>
                                Always Attempt SELL
                                <span style={{ fontWeight: 'normal', color: 'var(--text-muted)', display: 'block', fontSize: '0.8rem' }}>
                                    Never skip SELL for price/spread
                                </span>
                            </label>
                        </div>
                    </div>
                </div>

                {/* SPLIT/MERGE Settings */}
                <div className="card mb-4">
                    <h3 className="mb-4">SPLIT/MERGE Operation Settings</h3>
                    <p className="text-muted mb-4" style={{ fontSize: '0.9rem' }}>
                        Structural operations that should typically be followed exactly.
                    </p>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <input
                            name="splitMergeAlwaysFollow"
                            type="checkbox"
                            id="splitMergeAlwaysFollow"
                            defaultChecked={settings.splitMergeAlwaysFollow}
                            style={{ width: '1.25rem', height: '1.25rem' }}
                        />
                        <label htmlFor="splitMergeAlwaysFollow" className="stat-label" style={{ margin: 0 }}>
                            Always Follow SPLIT/MERGE
                            <span style={{ fontWeight: 'normal', color: 'var(--text-muted)', display: 'block', fontSize: '0.8rem' }}>
                                Mirror leader's structural operations exactly
                            </span>
                        </label>
                    </div>
                </div>

                {/* Save Button */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem' }}>
                    <button type="submit" className="btn btn-primary">
                        Save Settings
                    </button>
                </div>
            </form>

            {/* Current Values Summary */}
            <div className="card" style={{ marginTop: '2rem', background: 'var(--bg-secondary)' }}>
                <h4 className="mb-3">Current Configuration Summary</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
                    <div>
                        <span className="stat-label">Copy Ratio</span>
                        <div className="code-mono">{(settings.ratioDefault * 100).toFixed(2)}%</div>
                    </div>
                    <div>
                        <span className="stat-label">Max/Trade</span>
                        <div className="code-mono">${settings.maxUsdcPerTrade.toFixed(2)}</div>
                    </div>
                    <div>
                        <span className="stat-label">Max/Day</span>
                        <div className="code-mono">${settings.maxUsdcPerDay.toFixed(2)}</div>
                    </div>
                    <div>
                        <span className="stat-label">SELL Always</span>
                        <div>
                            {settings.sellAlwaysAttempt ? (
                                <span className="badge badge-green">Yes</span>
                            ) : (
                                <span className="badge badge-gray">No</span>
                            )}
                        </div>
                    </div>
                    <div>
                        <span className="stat-label">SPLIT/MERGE Follow</span>
                        <div>
                            {settings.splitMergeAlwaysFollow ? (
                                <span className="badge badge-green">Yes</span>
                            ) : (
                                <span className="badge badge-gray">No</span>
                            )}
                        </div>
                    </div>
                </div>
                <div style={{ marginTop: '1rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Last updated: {settings.updatedAt.toLocaleString()}
                </div>
            </div>
        </div>
    );
}
