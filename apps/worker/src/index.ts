// Worker entry point - trade ingestion polling loop
import 'dotenv/config';
import pino from 'pino';
import { ingestAllLeaders } from './ingester';

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

let isRunning = true;

/**
 * Main polling loop
 */
async function runPollLoop(): Promise<void> {
    logger.info({ pollIntervalMs: POLL_INTERVAL_MS }, 'Worker starting...');

    while (isRunning) {
        const startTime = Date.now();

        try {
            const result = await ingestAllLeaders();

            if (result.leadersProcessed > 0) {
                logger.info({
                    leadersProcessed: result.leadersProcessed,
                    newTrades: result.totalNew,
                    durationMs: Date.now() - startTime,
                }, 'Poll cycle complete');
            }
        } catch (error) {
            logger.error({ error }, 'Poll cycle failed');
        }

        // Wait for next poll interval
        await sleep(POLL_INTERVAL_MS);
    }

    logger.info('Worker stopped');
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Graceful shutdown handlers
process.on('SIGINT', () => {
    logger.info('Received SIGINT, shutting down...');
    isRunning = false;
});

process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down...');
    isRunning = false;
});

// Start the worker
runPollLoop().catch((error) => {
    logger.fatal({ error }, 'Worker crashed');
    process.exit(1);
});
