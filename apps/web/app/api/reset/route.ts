import { NextResponse } from 'next/server';
import { prisma } from '@polymarket-bot/db';

/**
 * Stage 9.3: Reset Paper State API
 * Deletes all paper trading data while preserving Leaders and Settings.
 */
export async function POST(request: Request) {
    try {
        // Delete in correct order for FK constraints
        // Stage 8.3: Include new position models
        await prisma.paperPosition.deleteMany({});
        await prisma.leaderPosition.deleteMany({});

        // Paper trading records
        await prisma.resolution.deleteMany({});
        await prisma.pnlSnapshot.deleteMany({});
        await prisma.paperFill.deleteMany({});
        await prisma.paperIntent.deleteMany({});
        await prisma.position.deleteMany({});
        await prisma.quote.deleteMany({});
        await prisma.marketMapping.deleteMany({});

        // Trades and raw payloads
        await prisma.trade.deleteMany({});
        await prisma.tradeRaw.deleteMany({});
        await prisma.quoteRaw.deleteMany({});

        // Reset leader API cursors to start fresh
        await prisma.leader.updateMany({
            data: {
                apiCursorTs: null,
                apiCursorInitialized: false,
                apiCursorUpdatedAt: null,
            }
        });

        console.log('[Reset API] Paper state reset complete');

        // Redirect back to settings page
        return NextResponse.redirect(new URL('/settings?reset=true', request.url));
    } catch (error) {
        console.error('Failed to reset paper trading data:', error);
        return NextResponse.json(
            { success: false, error: 'Failed to reset data' },
            { status: 500 }
        );
    }
}

export async function GET() {
    return NextResponse.json({
        message: 'Reset Paper State API',
        usage: 'POST to reset all paper trading data',
        warning: 'This action cannot be undone',
    });
}
