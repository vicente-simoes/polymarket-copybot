import { prisma } from '@polymarket-bot/db';
import { revalidatePath } from 'next/cache';
import { StatCard } from '../components';

async function getLeaders() {
    return prisma.leader.findMany({
        orderBy: { createdAt: 'desc' },
    });
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

export default async function LeadersPage() {
    const leaders = await getLeaders();

    return (
        <div className="animate-fade-in">
            <div className="page-header">
                <h1 className="page-title">Leader Management</h1>
                <p className="page-subtitle">Configure wallets to copy trade</p>
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

            <div className="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Status</th>
                            <th>Label</th>
                            <th>Wallet</th>
                            <th>Added</th>
                            <th className="text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {leaders.length === 0 ? (
                            <tr>
                                <td colSpan={5} className="text-center" style={{ padding: '3rem', color: 'var(--text-muted)' }}>
                                    No leaders configured yet.
                                </td>
                            </tr>
                        ) : (
                            leaders.map(leader => (
                                <tr key={leader.id}>
                                    <td>
                                        {leader.enabled ? (
                                            <span className="badge badge-green">Active</span>
                                        ) : (
                                            <span className="badge badge-gray">Paused</span>
                                        )}
                                    </td>
                                    <td style={{ fontWeight: 500 }}>{leader.label}</td>
                                    <td className="code-mono">{leader.wallet}</td>
                                    <td>{new Date(leader.createdAt).toLocaleDateString()}</td>
                                    <td className="text-right">
                                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
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
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
