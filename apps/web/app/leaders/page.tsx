import { prisma } from '@polymarket-bot/db';
import { revalidatePath } from 'next/cache';
import Link from 'next/link';

async function getLeaders() {
    return prisma.leader.findMany({
        orderBy: { createdAt: 'desc' },
    });
}

async function addLeader(formData: FormData) {
    'use server';

    const label = formData.get('label') as string;
    let wallet = formData.get('wallet') as string;

    // Normalize wallet
    wallet = wallet.trim().toLowerCase();

    // Validate
    if (!label || label.trim().length === 0) {
        throw new Error('Label is required');
    }

    if (!wallet.startsWith('0x') || wallet.length !== 42) {
        throw new Error('Wallet must be a valid Ethereum address (0x... with 42 characters)');
    }

    // Check for existing
    const existing = await prisma.leader.findUnique({ where: { wallet } });
    if (existing) {
        throw new Error('This wallet is already being tracked');
    }

    await prisma.leader.create({
        data: {
            label: label.trim(),
            wallet,
            enabled: true,
        },
    });

    revalidatePath('/leaders');
}

async function toggleLeader(formData: FormData) {
    'use server';

    const id = formData.get('id') as string;
    const currentEnabled = formData.get('enabled') === 'true';

    await prisma.leader.update({
        where: { id },
        data: { enabled: !currentEnabled },
    });

    revalidatePath('/leaders');
}

async function deleteLeader(formData: FormData) {
    'use server';

    const id = formData.get('id') as string;

    await prisma.leader.delete({
        where: { id },
    });

    revalidatePath('/leaders');
}

export default async function LeadersPage() {
    const leaders = await getLeaders();

    return (
        <div style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif', maxWidth: '1000px', margin: '0 auto' }}>
            {/* Header */}
            <div style={{ marginBottom: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                    <Link href="/" style={{ color: '#3b82f6', textDecoration: 'none', fontSize: '0.875rem' }}>
                        ← Back to Dashboard
                    </Link>
                    <h1 style={{ fontSize: '1.75rem', fontWeight: 600, marginTop: '0.5rem' }}>
                        👥 Leaders
                    </h1>
                    <p style={{ color: '#666' }}>
                        Manage wallets to copy-trade. Add leader wallets and enable/disable tracking.
                    </p>
                </div>
            </div>

            {/* Add Leader Form */}
            <div style={{
                padding: '1.5rem',
                backgroundColor: '#f9fafb',
                borderRadius: '8px',
                border: '1px solid #e5e7eb',
                marginBottom: '2rem'
            }}>
                <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem' }}>Add New Leader</h2>
                <form action={addLeader} style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <div style={{ flex: '1', minWidth: '150px' }}>
                        <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.25rem' }}>
                            Label
                        </label>
                        <input
                            type="text"
                            name="label"
                            placeholder="e.g., TheoriqTrader"
                            required
                            style={{
                                width: '100%',
                                padding: '0.5rem 0.75rem',
                                border: '1px solid #d1d5db',
                                borderRadius: '6px',
                                fontSize: '0.875rem',
                            }}
                        />
                    </div>
                    <div style={{ flex: '2', minWidth: '300px' }}>
                        <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.25rem' }}>
                            Wallet Address
                        </label>
                        <input
                            type="text"
                            name="wallet"
                            placeholder="0x..."
                            required
                            pattern="^0x[a-fA-F0-9]{40}$"
                            title="Valid Ethereum address (0x followed by 40 hex characters)"
                            style={{
                                width: '100%',
                                padding: '0.5rem 0.75rem',
                                border: '1px solid #d1d5db',
                                borderRadius: '6px',
                                fontSize: '0.875rem',
                                fontFamily: 'monospace',
                            }}
                        />
                    </div>
                    <button
                        type="submit"
                        style={{
                            padding: '0.5rem 1.5rem',
                            backgroundColor: '#10b981',
                            color: 'white',
                            border: 'none',
                            borderRadius: '6px',
                            fontWeight: 500,
                            cursor: 'pointer',
                        }}
                    >
                        Add Leader
                    </button>
                </form>
            </div>

            {/* Leaders List */}
            <div>
                <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem' }}>
                    Tracked Leaders ({leaders.length})
                </h2>

                {leaders.length === 0 ? (
                    <div style={{
                        padding: '2rem',
                        textAlign: 'center',
                        color: '#6b7280',
                        backgroundColor: '#f9fafb',
                        borderRadius: '8px',
                        border: '1px dashed #d1d5db',
                    }}>
                        No leaders added yet. Add a wallet address above to start tracking.
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                        {leaders.map((leader) => (
                            <div
                                key={leader.id}
                                style={{
                                    padding: '1rem 1.25rem',
                                    backgroundColor: leader.enabled ? '#ffffff' : '#f3f4f6',
                                    borderRadius: '8px',
                                    border: `1px solid ${leader.enabled ? '#e5e7eb' : '#d1d5db'}`,
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    opacity: leader.enabled ? 1 : 0.7,
                                }}
                            >
                                <div>
                                    <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
                                        {leader.label}
                                        {!leader.enabled && (
                                            <span style={{
                                                marginLeft: '0.5rem',
                                                fontSize: '0.75rem',
                                                padding: '0.125rem 0.5rem',
                                                backgroundColor: '#fef3c7',
                                                color: '#92400e',
                                                borderRadius: '4px',
                                            }}>
                                                Disabled
                                            </span>
                                        )}
                                    </div>
                                    <div style={{ fontFamily: 'monospace', fontSize: '0.875rem', color: '#6b7280' }}>
                                        {leader.wallet}
                                    </div>
                                    <div style={{ fontSize: '0.75rem', color: '#9ca3af', marginTop: '0.25rem' }}>
                                        Added {new Date(leader.createdAt).toLocaleDateString()}
                                    </div>
                                </div>
                                <div style={{ display: 'flex', gap: '0.5rem' }}>
                                    <form action={toggleLeader}>
                                        <input type="hidden" name="id" value={leader.id} />
                                        <input type="hidden" name="enabled" value={String(leader.enabled)} />
                                        <button
                                            type="submit"
                                            style={{
                                                padding: '0.375rem 0.75rem',
                                                backgroundColor: leader.enabled ? '#fef3c7' : '#d1fae5',
                                                color: leader.enabled ? '#92400e' : '#065f46',
                                                border: 'none',
                                                borderRadius: '4px',
                                                fontSize: '0.75rem',
                                                fontWeight: 500,
                                                cursor: 'pointer',
                                            }}
                                        >
                                            {leader.enabled ? 'Disable' : 'Enable'}
                                        </button>
                                    </form>
                                    <form action={deleteLeader}>
                                        <input type="hidden" name="id" value={leader.id} />
                                        <button
                                            type="submit"
                                            style={{
                                                padding: '0.375rem 0.75rem',
                                                backgroundColor: '#fee2e2',
                                                color: '#991b1b',
                                                border: 'none',
                                                borderRadius: '4px',
                                                fontSize: '0.75rem',
                                                fontWeight: 500,
                                                cursor: 'pointer',
                                            }}
                                        >
                                            Delete
                                        </button>
                                    </form>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
