// Verification script for packages/core and packages/db
// Run with: npx tsx verify-packages.ts

import { decidePaperIntent, DecisionReasons, DEFAULT_GUARDRAIL_CONFIG } from '@polymarket-bot/core';
import type { NormalizedTrade, Quote, RiskState, GuardrailConfig } from '@polymarket-bot/core';
import { prisma } from '@polymarket-bot/db';

async function main() {
    console.log('=== Verifying packages/core ===\n');

    // Test 1: Decision reasons are available
    console.log('Decision reasons:', Object.keys(DecisionReasons).length, 'reasons defined');
    console.log('  Sample:', DecisionReasons.SKIP_PRICE_MOVED);

    // Test 2: Default config is available
    console.log('\nDefault guardrail config:');
    console.log('  Ratio:', DEFAULT_GUARDRAIL_CONFIG.ratio);
    console.log('  Max USDC per trade:', DEFAULT_GUARDRAIL_CONFIG.maxUsdcPerTrade);
    console.log('  Max USDC per day:', DEFAULT_GUARDRAIL_CONFIG.maxUsdcPerDay);

    // Test 3: Strategy function works
    const mockTrade: NormalizedTrade = {
        id: 'test-id',
        leaderId: 'leader-id',
        dedupeKey: 'test|key',
        txHash: '0x123',
        tradeTs: new Date(),
        detectedAt: new Date(),
        side: 'BUY',
        conditionId: 'condition-123',
        outcome: 'YES',
        leaderPrice: 0.50,
        leaderSize: 100,
        leaderUsdc: 50,
        title: 'Test Market',
        rawId: 'raw-id',
    };

    const mockQuote: Quote = {
        id: 'quote-id',
        marketKey: 'market-key',
        capturedAt: new Date(),
        bestBid: 0.49,
        bestAsk: 0.51, // 1 cent spread
        bidSize: 1000,
        askSize: 1000,
        rawId: 'quote-raw-id',
    };

    const config: GuardrailConfig = {
        ...DEFAULT_GUARDRAIL_CONFIG,
    };

    const riskState: RiskState = {
        dailyUsdcSpent: 0,
        date: new Date().toISOString().split('T')[0],
    };

    const decision = decidePaperIntent({
        trade: mockTrade,
        quote: mockQuote,
        config,
        riskState,
    });

    console.log('\nStrategy decision test:');
    console.log('  Decision:', decision.decision);
    console.log('  Reason:', decision.decisionReason);
    console.log('  Target USDC:', decision.yourUsdcTarget);
    console.log('  Match same price:', decision.matchSamePrice);

    console.log('\n=== Verifying packages/db ===\n');

    // Test 4: Prisma client is available and connected
    try {
        const leaderCount = await prisma.leader.count();
        console.log('Database connection: OK');
        console.log('  Current leader count:', leaderCount);

        const tradeCount = await prisma.trade.count();
        console.log('  Current trade count:', tradeCount);
    } catch (error) {
        console.error('Database connection failed:', error);
        process.exit(1);
    }

    console.log('\n✅ All package verifications passed!');
    await prisma.$disconnect();
}

main().catch(console.error);
