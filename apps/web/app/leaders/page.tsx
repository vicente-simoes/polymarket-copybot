import { prisma } from '@polymarket-bot/db';
import { revalidatePath } from 'next/cache';

async function getLeaders() {
    return prisma.leader.findMany({
        orderBy: { createdAt: 'desc' },
    });
}

async function getGlobalSettings() {
    let settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings) {
        settings = await prisma.settings.create({ data: { id: 1 } });
    }
    return settings;
}

// Server Actions
async function addLeader(formData: FormData) {
    'use server';
    const label = formData.get('label') as string;
    const wallet = formData.get('wallet') as string;

    if (!label || !wallet) return;

    try {
        await prisma.leader.create({
            data: { label, wallet, enabled: true },
        });
        revalidatePath('/leaders');
    } catch (error) {
        console.error('Failed to add leader', error);
    }
}

async function toggleLeader(id: string, enabled: boolean) {
    'use server';
    await prisma.leader.update({
        where: { id },
        data: { enabled },
    });
    revalidatePath('/leaders');
}

async function deleteLeader(id: string) {
    'use server';
    await prisma.leader.delete({
        where: { id },
    });
    revalidatePath('/leaders');
}

async function updateLeaderOverrides(formData: FormData) {
    'use server';
    const id = formData.get('id') as string;
    const ratioStr = formData.get('ratio') as string;
    const maxTradeStr = formData.get('maxUsdcPerTrade') as string;
    const maxDayStr = formData.get('maxUsdcPerDay') as string;

    // Parse values - empty string means null (use global)
    const ratio = ratioStr?.trim() ? parseFloat(ratioStr) : null;
    const maxUsdcPerTrade = maxTradeStr?.trim() ? parseFloat(maxTradeStr) : null;
    const maxUsdcPerDay = maxDayStr?.trim() ? parseFloat(maxDayStr) : null;

    await prisma.leader.update({
        where: { id },
        data: { ratio, maxUsdcPerTrade, maxUsdcPerDay },
    });
    revalidatePath('/leaders');
}

export default async function LeadersPage() {
    const leaders = await getLeaders();
    const globalSettings = await getGlobalSettings();

    return (
        <div className="animate-fade-in">
            <div className="page-header">
                <h1 className="page-title">Leader Management</h1>
                <p className="page-subtitle">Configure wallets to copy trade with optional per-leader overrides</p>
            </div>

            <div className="card mb-4">
                <h3 className="mb-4">Add New Leader</h3>
                <form action={addLeader} style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: '200px' }}>
                        <label className="stat-label" style={{ display: 'block', marginBottom: '0.5rem' }}>Label</label>
                        <input name="label" placeholder="e.g. Top Trader 1" className="input-field" required />
                    </div>
                    <div style={{ flex: 2, minWidth: '300px' }}>
                        <label className="stat-label" style={{ display: 'block', marginBottom: '0.5rem' }}>Wallet Address</label>
                        <input name="wallet" placeholder="0x..." className="input-field code-mono" required pattern="^0x[a-fA-F0-9]{40}$" />
                    </div>
                    <button type="submit" className="btn btn-primary">
                        + Add Leader
                    </button>
                </form>
            </div>

            {/* Global defaults info */}
            <div className="card mb-4" style={{ background: 'var(--bg-secondary)' }}>
                <h4 className="mb-2">Global Defaults</h4>
                <p className="text-muted" style={{ fontSize: '0.85rem', marginBottom: '0.75rem' }}>
                    Leaders use these values unless overridden below. <a href="/settings" style={{ color: 'var(--accent-blue)' }}>Edit in Settings →</a>
                </p>
                <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
                    <div>
                        <span className="stat-label">Ratio</span>
                        <span className="code-mono" style={{ marginLeft: '0.5rem' }}>{(globalSettings.ratioDefault * 100).toFixed(2)}%</span>
                    </div>
                    <div>
                        <span className="stat-label">Max/Trade</span>
                        <span className="code-mono" style={{ marginLeft: '0.5rem' }}>${globalSettings.maxUsdcPerTrade}</span>
                    </div>
                    <div>
                        <span className="stat-label">Max/Day</span>
                        <span className="code-mono" style={{ marginLeft: '0.5rem' }}>${globalSettings.maxUsdcPerDay}</span>
                    </div>
                </div>
            </div>

            {/* Leaders list with overrides */}
            {leaders.length === 0 ? (
                <div className="card text-center" style={{ padding: '3rem', color: 'var(--text-muted)' }}>
                    No leaders configured yet.
                </div>
            ) : (
                leaders.map(leader => (
                    <div key={leader.id} className="card mb-3">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
                            <div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.25rem' }}>
                                    {leader.enabled ? (
                                        <span className="badge badge-green">Active</span>
                                    ) : (
                                        <span className="badge badge-gray">Paused</span>
                                    )}
                                    <span style={{ fontWeight: 600, fontSize: '1.1rem' }}>{leader.label}</span>
                                </div>
                                <div className="code-mono text-muted" style={{ fontSize: '0.85rem' }}>{leader.wallet}</div>
                            </div>
                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                                <form action={toggleLeader.bind(null, leader.id, !leader.enabled)}>
                                    <button type="submit" className="btn btn-secondary" style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem' }}>
                                        {leader.enabled ? 'Pause' : 'Enable'}
                                    </button>
                                </form>
                                <form action={deleteLeader.bind(null, leader.id)}>
                                    <button type="submit" className="btn btn-secondary" style={{ color: 'var(--error-text)', fontSize: '0.8rem', padding: '0.25rem 0.5rem' }}>
                                        Delete
                                    </button>
                                </form>
                            </div>
                        </div>

                        {/* Override fields */}
                        <form action={updateLeaderOverrides}>
                            <input type="hidden" name="id" value={leader.id} />
                            <div style={{
                                display: 'grid',
                                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                                gap: '1rem',
                                padding: '1rem',
                                background: 'var(--bg-secondary)',
                                borderRadius: '0.5rem',
                                alignItems: 'end'
                            }}>
                                <div>
                                    <label className="stat-label" style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.75rem' }}>
                                        Copy Ratio
                                        <span style={{ color: 'var(--text-muted)', marginLeft: '0.25rem' }}>
                                            {leader.ratio !== null ? '(override)' : '(global)'}
                                        </span>
                                    </label>
                                    <input
                                        name="ratio"
                                        type="number"
                                        step="0.001"
                                        min="0.001"
                                        max="0.5"
                                        placeholder={String(globalSettings.ratioDefault)}
                                        defaultValue={leader.ratio ?? ''}
                                        className="input-field"
                                        style={{ fontSize: '0.85rem' }}
                                    />
                                </div>
                                <div>
                                    <label className="stat-label" style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.75rem' }}>
                                        Max USDC/Trade
                                        <span style={{ color: 'var(--text-muted)', marginLeft: '0.25rem' }}>
                                            {leader.maxUsdcPerTrade !== null ? '(override)' : '(global)'}
                                        </span>
                                    </label>
                                    <input
                                        name="maxUsdcPerTrade"
                                        type="number"
                                        step="0.1"
                                        min="0.01"
                                        max="100"
                                        placeholder={String(globalSettings.maxUsdcPerTrade)}
                                        defaultValue={leader.maxUsdcPerTrade ?? ''}
                                        className="input-field"
                                        style={{ fontSize: '0.85rem' }}
                                    />
                                </div>
                                <div>
                                    <label className="stat-label" style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.75rem' }}>
                                        Max USDC/Day
                                        <span style={{ color: 'var(--text-muted)', marginLeft: '0.25rem' }}>
                                            {leader.maxUsdcPerDay !== null ? '(override)' : '(global)'}
                                        </span>
                                    </label>
                                    <input
                                        name="maxUsdcPerDay"
                                        type="number"
                                        step="1"
                                        min="0.1"
                                        max="1000"
                                        placeholder={String(globalSettings.maxUsdcPerDay)}
                                        defaultValue={leader.maxUsdcPerDay ?? ''}
                                        className="input-field"
                                        style={{ fontSize: '0.85rem' }}
                                    />
                                </div>
                                <div>
                                    <button type="submit" className="btn btn-primary" style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem', width: '100%' }}>
                                        Save Overrides
                                    </button>
                                </div>
                            </div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                                Leave fields empty to use global defaults. Override values take precedence.
                            </div>
                        </form>
                    </div>
                ))
            )}
        </div>
    );
}
