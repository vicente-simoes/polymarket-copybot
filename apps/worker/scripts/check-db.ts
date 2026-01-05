// Script to check database state and reset unfilled paper fills for reprocessing
import { prisma } from '@polymarket-bot/db';

async function main() {
    console.log('=== Database State ===');

    const paperIntents = await prisma.paperIntent.count();
    const paperFills = await prisma.paperFill.count();
    const filledFills = await prisma.paperFill.count({ where: { filled: true } });
    const unfilledFills = await prisma.paperFill.count({ where: { filled: false } });
    const positions = await prisma.position.count();
    const quotes = await prisma.quote.count();
    const pnlSnapshots = await prisma.pnlSnapshot.count();

    console.log(`Paper Intents: ${paperIntents}`);
    console.log(`Paper Fills: ${paperFills} (${filledFills} filled, ${unfilledFills} unfilled)`);
    console.log(`Positions: ${positions}`);
    console.log(`Quotes: ${quotes}`);
    console.log(`P&L Snapshots: ${pnlSnapshots}`);

    // Delete unfilled paper fills so they can be reprocessed with fresh quotes
    if (unfilledFills > 0) {
        console.log(`\n=== Deleting ${unfilledFills} unfilled paper fills for reprocessing ===`);
        const deleted = await prisma.paperFill.deleteMany({ where: { filled: false } });
        console.log(`Deleted ${deleted.count} paper fills`);
    }

    console.log('\nDone. Run the worker to reprocess fills with fresh quotes.');
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
