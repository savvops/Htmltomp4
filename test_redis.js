require('dotenv').config();
const { Redis } = require('@upstash/redis');

async function test() {
    console.log('Testing Redis Connection...');
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    console.log('URL:', url);
    console.log('Token Length:', token ? token.length : 0);

    const redis = new Redis({ url, token });

    try {
        console.log('Checking queue length...');
        const len = await redis.llen('conversion_queue');
        console.log('Queue Length:', len);

        const jobs = await redis.lrange('conversion_queue', 0, -1);
        console.log('Jobs in Queue:', jobs);

    } catch (e) {
        console.error('❌ Redis Test FAILED with error:', e);
    }
}

test();
