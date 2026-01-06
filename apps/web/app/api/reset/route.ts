import { NextResponse } from 'next/server';
import { prisma } from '@polymarket-bot/db';

export async function POST() {
    try {
        // Delete in correct order for FK constraints
        // Using deleteMany for each table

        // First: Delete dependent records
        await prisma.resolution.deleteMany({});
        await prisma.pnlSnapshot.deleteMany({});
        await prisma.paperFill.deleteMany({});
        await prisma.paperIntent.deleteMany({});
        await prisma.position.deleteMany({});
        await prisma.quote.deleteMany({});
        await prisma.marketMapping.deleteMany({});

        // Finally: Delete trades and raw payloads
        await prisma.trade.deleteMany({});
        await prisma.tradeRaw.deleteMany({});
        await prisma.quoteRaw.deleteMany({});

        return NextResponse.json({
            success: true,
            message: 'All paper trading data has been reset. Leaders and settings preserved.',
        });
    } catch (error) {
        console.error('Failed to reset paper trading data:', error);
        return NextResponse.json(
            { success: false, error: 'Failed to reset data' },
            { status: 500 }
        );
    }
}
