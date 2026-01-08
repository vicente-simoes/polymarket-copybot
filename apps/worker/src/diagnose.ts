import { ethers } from 'ethers';
import 'dotenv/config';

// Hardcoded for diagnosis if env is missing
const URL = process.env.POLYGON_WS_URL || 'wss://polygon-mainnet.g.alchemy.com/v2/LteqhfIP7-ftUQH57eaMD';
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';

const ORDER_FILLED_TOPIC = ethers.id(
    'OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)'
);

async function main() {
    console.log('--- Polygon Diagnostic ---');
    console.log('Env Trigger Mode:', process.env.TRIGGER_MODE);
    console.log('Connecting to:', URL.replace(/\/v2\/[^/]+/, '/v2/***'));
    console.log('Exchange:', CTF_EXCHANGE);

    try {
        const provider = new ethers.WebSocketProvider(URL);

        provider.on('error', (err) => {
            console.error('Provider Error:', err);
        });

        // Wait for ready
        console.log('Connecting...');
        await provider.ready;
        console.log('Connected to Polygon!');

        const block = await provider.getBlockNumber();
        console.log('Current Block:', block);

        // Subscribe to all OrderFilled events on CTF Exchange
        const filter = {
            address: CTF_EXCHANGE,
            topics: [ORDER_FILLED_TOPIC],
        };

        console.log('Subscribing to OrderFilled events...');
        let count = 0;
        provider.on(filter, (log) => {
            count++;
            console.log(`[${count}] EVENT RECEIVED! Tx: ${log.transactionHash}`);
        });

        // Keep alive for 8 seconds
        console.log('Listening for 8 seconds...');
        await new Promise(resolve => setTimeout(resolve, 8000));

        console.log(`\nDiagnosis complete. Received ${count} events.`);
        await provider.destroy();
        process.exit(0);

    } catch (error) {
        console.error('Fatal Error:', error);
        process.exit(1);
    }
}

main();
