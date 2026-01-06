// Backfill script - creates positions from existing filled paper trades
// Run with: npx tsx scripts/backfill-positions.ts

import { prisma } from '@polymarket-bot/db';
import { updatePosition, OperationType } from '@polymarket-bot/core';

async function backfillPositions() {
    console.log('Starting position backfill...');

    // Get all filled paper trades that don't have corresponding positions
    const filledIntents = await prisma.paperIntent.findMany({
        where: {
            decision: 'TRADE',
            paperFill: {
                filled: true,
            },
        },
        include: {
            paperFill: true,
            trade: true,
        },
    });

    console.log(`Found ${filledIntents.length} filled paper intents to process`);

    let created = 0;
    let errors = 0;

    for (const intent of filledIntents) {
        const fill = intent.paperFill;
        if (!fill || !fill.filled || !fill.fillPrice) continue;

        const trade = intent.trade;

        // Build marketKey (same format as mapping.ts)
        const marketKey = `${trade.conditionId}:${trade.outcome.toUpperCase()}`;

        try {
            await updatePosition({
                marketKey,
                conditionId: trade.conditionId,
                outcome: trade.outcome.toUpperCase(),
                title: trade.title ?? undefined,
                operationType: intent.yourSide as OperationType,
                shares: Number(intent.yourUsdcTarget) / Number(fill.fillPrice),
                price: Number(fill.fillPrice),
            });

            console.log(`Created position for ${trade.title?.substring(0, 40) || trade.conditionId} - ${intent.yourSide} ${trade.outcome}`);
            created++;
        } catch (error) {
            console.error(`Failed to create position for ${trade.conditionId}:`, error);
            errors++;
        }
    }

    console.log(`\nBackfill complete: ${created} positions created, ${errors} errors`);

    // Show current positions
    const positions = await prisma.position.findMany({
        where: { isClosed: false },
    });
    console.log(`\nCurrent open positions: ${positions.length}`);
    for (const pos of positions) {
        console.log(`  - ${pos.title?.substring(0, 40) || pos.marketKey} | ${pos.outcome} | ${pos.shares.toFixed(4)} shares @ $${pos.avgEntryPrice.toFixed(4)} | Cost: $${pos.totalCostBasis.toFixed(2)}`);
    }

    await prisma.$disconnect();
}

backfillPositions().catch(console.error);
