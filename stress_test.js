const https = require('https');
const http = require('http');

// Config
const FILES = ['stress_1.html', 'stress_2.html', 'stress_3.html', 'stress_4.html', 'stress_5.html'];
const CONCURRENT_REQUESTS = 5; // Hit all at once

const authData = JSON.stringify({
    email: 'test@example.com',
    password: 'password'
});

const authOptions = {
    hostname: 'pcrumthbyecczeumvvzu.supabase.co',
    port: 443,
    path: '/auth/v1/token?grant_type=password',
    method: 'POST',
    headers: {
        'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBjcnVtdGhieWVjY3pldW12dnp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg0ODY3MzAsImV4cCI6MjA4NDA2MjczMH0.hbC34EXo8J8LilmStRGQV-bbaNI8-QHy5rmXh97yVhE',
        'Content-Type': 'application/json',
        'Content-Length': authData.length
    }
};

function getAuthToken() {
    return new Promise((resolve, reject) => {
        const req = https.request(authOptions, res => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    if (json.access_token) resolve(json.access_token);
                    else reject('No token found');
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.write(authData);
        req.end();
    });
}

function runConversion(token, filename) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: 3000,
            path: `/convert?filename=${filename}&width=640&height=480&fps=30&duration=3&token=${token}`,
            method: 'GET'
        };

        const req = http.request(options, res => {
            let output = '';
            res.on('data', chunk => {
                const text = chunk.toString();
                output += text;
                // Basic SSE parsing to detect 'done'
                if (text.includes('event: done')) {
                    console.log(`[SUCCESS] ${filename} finished.`);
                    resolve();
                }
                if (text.includes('Simulated Failure') || text.includes('Error')) {
                    console.error(`[FAILURE] ${filename} failed.`);
                    //    reject(text); // Don't reject, just log to keep batch going
                    resolve(); // Treat as handled
                }
            });
            res.on('end', () => {
                if (!output.includes('event: done')) {
                    console.log(`[END] ${filename} stream ended without explicit done (might be queued or error).`);
                }
                resolve();
            });
        });
        req.on('error', (e) => {
            console.error(`[NET ERROR] ${filename}: ${e.message}`);
            resolve();
        });
        req.end();
    });
}

async function main() {
    console.log('--- Starting Stress Test ---');
    try {
        const token = await getAuthToken();
        console.log('Authenticated.');

        const promises = FILES.map(f => {
            console.log(`Queuing ${f}...`);
            return runConversion(token, f);
        });

        await Promise.all(promises);
        console.log('--- Stress Test Complete ---');
        process.exit(0);

    } catch (e) {
        console.error('Test Failed:', e);
        process.exit(1);
    }
}

main();
