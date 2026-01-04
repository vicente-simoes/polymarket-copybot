// Worker entry point - trade ingestion polling loop with hardening
import 'dotenv/config';
import pino from 'pino';
import { ingestAllLeaders } from './ingester.js';
import { sleep } from './retry.js';
import {
    waitForDatabase,
    recordPollCycle,
    logHealthStatus,
    getHealthSummary
} from './health.js';
import { generateMissingPaperIntents } from './paper.js';

const logger = pino({
    name: 'worker',
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
        },
    },
});

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '5000', 10);
const HEALTH_LOG_INTERVAL = parseInt(process.env.HEALTH_LOG_INTERVAL || '60000', 10); // 1 minute
const PNL_SNAPSHOT_INTERVAL = parseInt(process.env.PNL_SNAPSHOT_INTERVAL || '3600000', 10); // 1 hour

let isRunning = true;
let lastHealthLog = 0;
let lastPnlSnapshot = 0;

/**
 * Main polling loop with hardening
 */
async function runPollLoop(): Promise<void> {
    logger.info({
        pollIntervalMs: POLL_INTERVAL_MS,
        healthLogIntervalMs: HEALTH_LOG_INTERVAL,
        pnlSnapshotIntervalMs: PNL_SNAPSHOT_INTERVAL,
    }, 'Worker starting...');

    // Wait for database to be available
    const dbReady = await waitForDatabase();
    if (!dbReady) {
        logger.fatal('Cannot start worker without database connection');
        process.exit(1);
    }

    logger.info('Database connected, starting poll loop');

    while (isRunning) {
        const startTime = Date.now();

        try {
            const result = await ingestAllLeaders();

            // Record successful poll
            recordPollCycle();

            if (result.leadersProcessed > 0 || result.totalNew > 0) {
                logger.info({
                    leadersProcessed: result.leadersProcessed,
                    newTrades: result.totalNew,
                    durationMs: Date.now() - startTime,
                }, 'Poll cycle complete');
            }

            // Generate paper intents for any trades that are missing them
            // (e.g., after bug fixes or for trades that had mapping issues)
            const missingIntents = await generateMissingPaperIntents();
            if (missingIntents > 0) {
                logger.info({ count: missingIntents }, 'Generated missing paper intents');
            }
        } catch (error) {
            logger.error({ error }, 'Poll cycle failed');
        }

        // Periodic health logging
        const now = Date.now();
        if (now - lastHealthLog >= HEALTH_LOG_INTERVAL) {
            logHealthStatus();
            lastHealthLog = now;
        }

        // Periodic P&L snapshot for historical charts
        if (now - lastPnlSnapshot >= PNL_SNAPSHOT_INTERVAL) {
            try {
                const { recordPnlSnapshot, checkMarketResolutions } = await import('@polymarket-bot/core');

                // Record P&L snapshot
                await recordPnlSnapshot();
                logger.info('P&L snapshot recorded');

                // Check for market resolutions
                const resolutionResult = await checkMarketResolutions();
                if (resolutionResult.positionsResolved > 0) {
                    logger.info({
                        positionsChecked: resolutionResult.positionsChecked,
                        positionsResolved: resolutionResult.positionsResolved,
                        totalRealizedPnl: resolutionResult.totalRealizedPnl,
                    }, 'Market resolutions processed');
                }
            } catch (error) {
                logger.error({ error }, 'Failed to record P&L snapshot or check resolutions');
            }
            lastPnlSnapshot = now;
        }

        // Wait for next poll interval with jitter to avoid thundering herd
        await sleep(POLL_INTERVAL_MS, 500);
    }

    logger.info('Worker stopped');
}

/**
 * Graceful shutdown handler
 */
async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, 'Received shutdown signal');
    isRunning = false;

    // Log final health status
    const health = getHealthSummary();
    logger.info(health, 'Final worker health status');

    // Give time for cleanup
    await sleep(1000);
    process.exit(0);
}

// Graceful shutdown handlers
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Unhandled rejection handler
process.on('unhandledRejection', (reason, promise) => {
    logger.error({ reason }, 'Unhandled promise rejection');
});

// Uncaught exception handler
process.on('uncaughtException', (error) => {
    logger.fatal({ error }, 'Uncaught exception - shutting down');
    process.exit(1);
});

// Start the worker
runPollLoop().catch((error) => {
    logger.fatal({ error }, 'Worker crashed');
    process.exit(1);
});
