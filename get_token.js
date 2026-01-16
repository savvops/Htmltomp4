const https = require('https');

const data = JSON.stringify({
    email: 'test@example.com',
    password: 'password'
});

const options = {
    hostname: 'pcrumthbyecczeumvvzu.supabase.co',
    port: 443,
    path: '/auth/v1/token?grant_type=password',
    method: 'POST',
    headers: {
        'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBjcnVtdGhieWVjY3pldW12dnp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg0ODY3MzAsImV4cCI6MjA4NDA2MjczMH0.hbC34EXo8J8LilmStRGQV-bbaNI8-QHy5rmXh97yVhE',
        'Content-Type': 'application/json',
        'Content-Length': data.length
    }
};

const req = https.request(options, res => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
        try {
            const json = JSON.parse(body);
            if (json.access_token) {
                console.log('Token acquired. Testing conversion...');
                const token = json.access_token;

                // Call Local Server
                const http = require('http');
                const convertOptions = {
                    hostname: 'localhost',
                    port: 3000,
                    path: `/convert?filename=queue_test.html&width=1920&height=1080&token=${token}`,
                    method: 'GET'
                };

                const req2 = http.request(convertOptions, res2 => {
                    console.log(`Response Status: ${res2.statusCode}`);
                    res2.on('data', chunk => process.stdout.write(chunk));
                    res2.on('end', () => console.log('\nResponse Ended'));
                });
                req2.on('error', e => console.error('Convert Request Failed:', e));
                req2.end();

            } else {
                console.error('No token found:', json);
                process.exit(1);
            }
        } catch (e) {
            console.error('Failed to parse auth response:', body);
            process.exit(1);
        }
    });
});

req.on('error', error => {
    console.error(error);
    process.exit(1);
});

req.write(data);
req.end();
