require('dotenv').config();
const { Redis } = require('@upstash/redis');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const JOB_QUEUE_KEY = 'conversion_queue';

async function processJob(job) {
    console.log(`[Worker] Picking up job: ${job.id}`);
    const { filename, width, height, fps, duration, format } = job.data;
    const statusKey = `job:${job.id}:status`;

    // Initialize status
    await redis.set(statusKey, JSON.stringify({ state: 'processing', log: 'Starting conversion...' }));

    return new Promise((resolve, reject) => {
        const scriptPath = path.join(__dirname, 'convert.js');
        const args = [
            scriptPath,
            `--filename=${filename}`,
            `--width=${width}`,
            `--height=${height}`,
            `--fps=${fps}`,
            `--duration=${duration}`,
            `--format=${format || 'mp4'}`
        ];

        console.log(`[Worker] Spawning convert.js for ${filename}...`);
        const child = spawn('node', args);

        child.stdout.on('data', async (data) => {
            const line = data.toString().trim();
            // Log locally
            console.log(`[Worker] [${filename}] ${line}`);
            // Update Redis (Fire and forget to not block)
            redis.set(statusKey, JSON.stringify({ state: 'processing', log: line }));
        });

        child.stderr.on('data', (data) => {
            console.error(`[Worker Error] ${data.toString()}`);
            redis.set(statusKey, JSON.stringify({ state: 'processing', log: `[Error] ${data.toString()}` }));
        });

        child.on('close', async (code) => {
            if (code === 0) {
                console.log(`[Worker] Job ${job.id} completed successfully.`);
                await redis.set(statusKey, JSON.stringify({ state: 'completed', log: 'Finished successfully.' }));
                resolve();
            } else {
                console.error(`[Worker] Job ${job.id} failed with code ${code}`);
                await redis.set(statusKey, JSON.stringify({ state: 'failed', log: `Failed with code ${code}` }));
                reject(new Error(`Conversion failed with code ${code}`));
            }
        });
    });
}

async function startWorker() {
    console.log('[Worker] Connecting to Upstash Redis...');
    console.log('[Worker] Listening for jobs...');

    while (true) {
        try {
            // "RPOP" removes the last element from the list. 
            // We sleep if no job to avoid hammering the free tier database.
            const jobDataStr = await redis.rpop(JOB_QUEUE_KEY);

            if (jobDataStr) {
                // Fix: Upstash SDK might auto-parse JSON. Use as is if object, parse if string.
                let job;
                if (typeof jobDataStr === 'string') {
                    job = JSON.parse(jobDataStr);
                } else {
                    job = jobDataStr; // It's already an object
                }
                await processJob(job);
            } else {
                // Wait 2 seconds before checking again (Polling)
                await new Promise(r => setTimeout(r, 2000));
            }
        } catch (error) {
            console.error('[Worker] Error:', error);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

startWorker();
