
import { prisma } from '@polymarket-bot/db';
import { generatePaperIntentForTrade } from './paper';
import { createPaperExecutor } from './execution';
import { setExecutor } from './execution/executorService';
import { randomUUID } from 'crypto';

async function run() {
    console.log('--- STARTING MANUAL VERIFICATION: RISK CONTROLS ---');

    // Setup Mock Executor for paper module
    // We pass null bookstore as we don't expect it to check orderbook for *skips*
    // but if it tries to execute, it might need it.
    // For this test, we only care about Skip Risk, which happens BEFORE execution.
    // But generatePaperIntentForTrade uses executor.store... methods? No, paper.ts uses it to submit.
    // Let's set it just in case.
    const executor = createPaperExecutor(null as any);
    setExecutor(executor);


    // 1. Setup Test Leader
    const leaderId = `RISK_TESTER_LEADER`;

    await prisma.leader.upsert({
        where: { id: leaderId },
        create: { id: leaderId, label: 'Risk Tester', wallet: '0x9999999999999999999999999999999999999999', enabled: true },
        update: { enabled: true }
    });
    console.log(`✅ Test Leader ready: ${leaderId}`);

    // --- TEST 1: MAKER SKIP ---
    console.log('\n--- TEST 1: MAKER SKIP ---');
    // Enable Skip Maker (Explicitly true)
    await prisma.leader.update({
        where: { id: leaderId },
        data: { skipMakerTrades: true, maxUsdcPerEvent: 10000 }
    });

    const txHash1 = `0xMaker${randomUUID().slice(0, 10)}`;

    // Create Fill with Leader and Raw relations
    await prisma.leaderFill.create({
        data: {
            leader: { connect: { id: leaderId } },
            raw: {
                create: {
                    source: 'polygon',
                    payload: { note: 'manual_verification_dummy' }
                }
            },
            txHash: txHash1,
            source: 'polygon',
            blockNumber: 100,
            logIndex: 1,
            orderHash: '0x',
            maker: '0x',
            taker: '0x',
            leaderRole: 'maker', // <--- KEY: Must be 'maker'
            fillTs: new Date(),
            detectedAt: new Date(),
            tokenId: 'T1',
            conditionId: 'C1',
            outcome: 'Yes',
            side: 'BUY',
            leaderPrice: 0.5,
            leaderSize: 100,
            leaderUsdc: 50,
            exchangeAddress: '0x',
            dedupeKey: `dedupe_${txHash1}`
        }
    });

    const trade1 = await prisma.trade.create({
        data: {
            leader: { connect: { id: leaderId } },
            raw: {
                create: {
                    source: 'manual',
                    payload: {},
                    leader: { connect: { id: leaderId } }
                }
            },
            txHash: txHash1,
            // status: 'PENDING', // REMOVED
            // token: 'T1', // REMOVED
            // entryPrice: 0.5, // REMOVED
            // size: 100, // REMOVED
            outcome: 'Yes',
            side: 'BUY',

            leaderPrice: 0.5,
            leaderSize: 100,
            leaderUsdc: 50,

            conditionId: 'C1',
            tradeTs: new Date(),
            detectedAt: new Date(),
            dedupeKey: `dedupe_${txHash1}`
        }
    });

    console.log(`Processing Maker trade ${trade1.id} (tx: ${txHash1})...`);
    const intent1Id = await generatePaperIntentForTrade(trade1.id);

    if (intent1Id) {
        const intent1 = await prisma.paperIntent.findUnique({ where: { id: intent1Id } });
        if (intent1?.decision === 'SKIP' && intent1.decisionReason.includes('MAKER')) {
            console.log(`✅ SUCCESS: Trade skipped. Reason: ${intent1.decisionReason}`);
        } else {
            console.error(`❌ FAILURE: Unexpected decision. Got: ${intent1?.decision} (${intent1?.decisionReason})`);
        }
    } else {
        console.error('❌ FAILURE: No intent generated.');
    }

    // --- TEST 2: EVENT LIMIT ---
    console.log('\n--- TEST 2: EVENT LIMIT ---');
    await prisma.leader.update({
        where: { id: leaderId },
        data: {
            skipMakerTrades: false,
            maxUsdcPerEvent: 10
        }
    });

    const txHash2 = `0xLimit${randomUUID().slice(0, 10)}`;

    await prisma.leaderFill.create({
        data: {
            leader: { connect: { id: leaderId } },
            raw: {
                create: {
                    source: 'polygon',
                    payload: { note: 'manual_verification_dummy_2' }
                }
            },
            txHash: txHash2,
            source: 'polygon',
            blockNumber: 101,
            logIndex: 2,
            orderHash: '0x',
            maker: '0x',
            taker: '0x',
            leaderRole: 'taker', // <--- Valid Role
            fillTs: new Date(),
            detectedAt: new Date(),
            tokenId: 'T2',
            conditionId: 'C2_LIMIT_TEST',
            outcome: 'Yes',
            side: 'BUY',
            leaderPrice: 0.5,
            leaderSize: 100,
            leaderUsdc: 50, // 50 > 10 (Limit)
            exchangeAddress: '0x',
            dedupeKey: `dedupe_${txHash2}`
        }
    });

    const trade2 = await prisma.trade.create({
        data: {
            leader: { connect: { id: leaderId } },
            raw: {
                create: {
                    source: 'manual',
                    payload: {},
                    leader: { connect: { id: leaderId } }
                }
            },
            txHash: txHash2,
            // status: 'PENDING', // REMOVED
            // token: 'T2', // REMOVED
            // entryPrice: 0.5, // REMOVED
            // size: 100, // REMOVED
            outcome: 'Yes',
            side: 'BUY',

            leaderPrice: 0.5,
            leaderSize: 100,
            leaderUsdc: 50,

            conditionId: 'C2_LIMIT_TEST',
            tradeTs: new Date(),
            detectedAt: new Date(),
            dedupeKey: `dedupe_${txHash2}`
        }
    });

    console.log(`Processing Large trade ${trade2.id} (tx: ${txHash2}) against Limit $10...`);
    const intent2Id = await generatePaperIntentForTrade(trade2.id);

    if (intent2Id) {
        const intent2 = await prisma.paperIntent.findUnique({ where: { id: intent2Id } });
        // Keeping looser check
        if (intent2?.decision === 'SKIP' && intent2.decisionReason.includes('LIMIT')) {
            console.log(`✅ SUCCESS: Trade skipped. Reason: ${intent2.decisionReason}`);
        } else {
            console.error(`❌ FAILURE: Unexpected decision. Got: ${intent2?.decision} (${intent2?.decisionReason})`);
        }
    } else {
        console.error('❌ FAILURE: No intent generated.');
    }

    console.log('\n--- VERIFICATION COMPLETE ---');
}

run().catch((e) => {
    console.error('Error running verification:', e);
    process.exit(1);
}).finally(async () => {
    await prisma.$disconnect();
});
