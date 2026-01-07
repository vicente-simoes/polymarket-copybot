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
import { simulateMissingFills } from './fills.js';
import { getConfig, logConfig } from './config.js';
import { createPolygonSource } from './polygon/index.js';
import type { LeaderFillSource } from './ports/index.js';
import type { BookStore } from './ports/BookStore.js';
import type { ExecutionAdapter } from './ports/ExecutionAdapter.js';
import { createClobWsBookStore } from './marketdata/index.js';
import { createPaperExecutor } from './execution/index.js';
import { getTriggerMode, setTriggerMode } from './latencyTracker.js';
import { setExecutor } from './execution/executorService.js';
import { riskEngine } from './execution/risk.js';

const logger = pino({
    name: 'worker',
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
        },
    },
});

// Load configuration from centralized config module
const config = getConfig();

let isRunning = true;
let lastHealthLog = 0;
let lastPnlSnapshot = 0;
let polygonSource: LeaderFillSource | null = null;
let bookStore: BookStore | null = null;
let executor: ExecutionAdapter | null = null;

/**
 * Main polling loop with hardening
 */
async function runPollLoop(): Promise<void> {
    // Log full configuration on startup
    logConfig(logger);

    logger.info({
        pollIntervalMs: config.pollIntervalMs,
        healthLogIntervalMs: config.healthLogIntervalMs,
        pnlSnapshotIntervalMs: config.pnlSnapshotIntervalMs,
    }, 'Worker starting...');

    // Wait for database to be available
    const dbReady = await waitForDatabase();
    if (!dbReady) {
        logger.fatal('Cannot start worker without database connection');
        process.exit(1);
    }

    logger.info('Database connected, starting poll loop');

    // Start BookStore if enabled (ws or ws+snapshot mode)
    if (config.bookStoreMode === 'ws' || config.bookStoreMode === 'ws+snapshot') {
        bookStore = createClobWsBookStore();
        await bookStore.start();
        logger.info({ mode: config.bookStoreMode }, 'Book store started');
    }

    // Start PaperExecutor if in paper mode
    if (config.executionMode === 'paper') {
        executor = createPaperExecutor(bookStore);
        setExecutor(executor);
        await executor.start();

        // Subscribe to fill events for logging
        executor.onFill(async (fill) => {
            logger.info({
                attemptId: fill.attemptId,
                filledShares: fill.filledShares.toFixed(4),
                fillPrice: fill.fillPrice.toFixed(4),
                isFinal: fill.isFinal,
            }, 'Execution fill received');
        });

        logger.info({ mode: config.executionMode }, 'Paper executor started');
    }

    // Initialize trigger mode from DB or Config
    // If DB is empty, seed it with Config
    let currentMode = await getTriggerMode();
    if (currentMode === 'data_api' && config.triggerMode !== 'data_api') {
        // Seed DB with env config if DB is default but env is specific
        await setTriggerMode(config.triggerMode);
        currentMode = config.triggerMode;
    }

    // Start Polygon watcher if needed
    if (currentMode === 'polygon' || currentMode === 'both') {
        try {
            await startPolygonWatcher();
        } catch (error) {
            const serialized = error instanceof Error
                ? { message: error.message, name: error.name }
                : error;
            logger.warn({ error: serialized }, 'Failed to start Polygon watcher, falling back to data_api mode');

            // If polygon-only mode, fallback to data_api
            if (currentMode === 'polygon') {
                currentMode = 'data_api';
                await setTriggerMode('data_api');
                logger.info('Switched to data_api mode due to Polygon failure');
            } else {
                // In 'both' mode, just continue with data_api (polygon is optional)
                logger.info('Continuing with data_api only (Polygon unavailable)');
            }
        }
    }

    // Wire dependencies for RiskEngine (Phase 6 Data Health Gate)
    riskEngine.setDependencies(bookStore, polygonSource);

    // Log trigger mode
    logger.info({
        triggerMode: currentMode,
        dataApiEnabled: currentMode === 'data_api' || currentMode === 'both',
        polygonEnabled: polygonSource !== null,
    }, 'Trigger sources configured');

    while (isRunning) {
        // Check for mode changes
        const targetMode = await getTriggerMode();

        if (targetMode !== currentMode) {
            logger.info({ from: currentMode, to: targetMode }, 'Switching trigger mode');

            // Handle transition
            if (targetMode === 'data_api') {
                // Stop Polygon
                await stopPolygonWatcher();
            } else if (targetMode === 'polygon') {
                // Start Polygon (if not already), Data API loop will simply be skipped below
                if (!polygonSource) await startPolygonWatcher();
            } else if (targetMode === 'both') {
                // Start Polygon (if not already)
                if (!polygonSource) await startPolygonWatcher();
            }

            currentMode = targetMode;
        }

        const startTime = Date.now();

        try {
            // Only run Data API ingestion if enabled
            if (currentMode === 'data_api' || currentMode === 'both') {
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
            } else {
                // In Polygon-only mode, we still need to record poll cycles for health checks
                recordPollCycle();
            }

            // Generate paper intents for any trades that are missing them
            // (e.g., after bug fixes or for trades that had mapping issues)
            const missingIntents = await generateMissingPaperIntents();
            if (missingIntents > 0) {
                logger.info({ count: missingIntents }, 'Generated missing paper intents');
            }

            // Simulate fills for any paper intents that don't have them yet
            // This updates position tracking for P&L
            const simulatedFills = await simulateMissingFills();
            if (simulatedFills > 0) {
                logger.info({ count: simulatedFills }, 'Simulated paper fills');
            }
        } catch (error) {
            logger.error({ error }, 'Poll cycle failed');
        }

        // Periodic health logging
        const now = Date.now();
        if (now - lastHealthLog >= config.healthLogIntervalMs) {
            logHealthStatus();
            lastHealthLog = now;
        }

        // Periodic P&L snapshot for historical charts
        if (now - lastPnlSnapshot >= config.pnlSnapshotIntervalMs) {
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
                logger.error({ err: error }, 'Failed to record P&L snapshot or check resolutions');
            }
            lastPnlSnapshot = now;
        }

        // Wait for next poll interval with jitter to avoid thundering herd
        await sleep(config.pollIntervalMs, 500);
    }

    logger.info('Worker stopped');
}

/**
 * Graceful shutdown handler
 */
async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, 'Received shutdown signal');
    isRunning = false;

    // Stop Polygon watcher if running
    if (polygonSource) {
        try {
            await polygonSource.stop();
            logger.info('Polygon watcher stopped');
        } catch (error) {
            logger.error({ error }, 'Error stopping Polygon watcher');
        }
    }

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
    // Serialize error properly
    const serialized = reason instanceof Error
        ? { message: reason.message, stack: reason.stack, name: reason.name }
        : reason;
    logger.error({ reason: serialized }, 'Unhandled promise rejection');
});

// Uncaught exception handler
process.on('uncaughtException', (error) => {
    // Serialize error properly for logging
    const serialized = error instanceof Error
        ? { message: error.message, stack: error.stack, name: error.name }
        : error;
    logger.fatal({ error: serialized }, 'Uncaught exception - shutting down');
    process.exit(1);
});

// Start the worker
runPollLoop().catch((error) => {
    logger.fatal({ error }, 'Worker crashed');
    process.exit(1);
});

// Helper functions for hot-swapping
async function startPolygonWatcher() {
    if (polygonSource) return; // Already running

    try {
        polygonSource = createPolygonSource();
        await polygonSource.start();

        // Subscribe to fill events
        polygonSource.onFill(async (event) => {
            logger.info({
                leader: event.leaderWallet.slice(0, 10) + '...',
                side: event.side,
                price: event.leaderPrice.toFixed(4),
                usdc: event.leaderUsdc.toFixed(2),
                title: event.title?.slice(0, 30),
                source: event.source,
            }, 'Leader fill detected from Polygon');
        });

        logger.info({ source: 'polygon' }, 'Polygon watcher started');
    } catch (error) {
        logger.error({ error }, 'Failed to start Polygon watcher');
        polygonSource = null;
    }
}

async function stopPolygonWatcher() {
    if (!polygonSource) return;

    try {
        await polygonSource.stop();
        polygonSource = null;
        logger.info('Polygon watcher stopped');
    } catch (error) {
        logger.error({ error }, 'Error stopping Polygon watcher');
    }
}

/**
 * Get the active book store instance (or null if not enabled)
 */
export function getBookStore(): BookStore | null {
    return bookStore;
}

/**
 * Get the active execution adapter (or null if not started)
 */

