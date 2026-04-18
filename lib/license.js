'use strict';

/**
 * License validation via Cloudflare Worker.
 *
 * Cloudflare Worker contract:
 *   POST /activate  { key, machineId }
 *     → 200 { valid: true }  |  { valid: false, error: "KEY_INVALID" | "KEY_USED" | ... }
 *   POST /check     { key, machineId }
 *     → 200 { valid: true }  |  { valid: false, error: "..." }
 *
 * Set the Worker URL in .env:
 *   HTMLTOMP4_LICENSE_URL=https://license.your-worker.workers.dev
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const LICENSE_URL = process.env.HTMLTOMP4_LICENSE_URL || 'https://license.htmltomp4.com';
const CACHE_DIR = path.join(os.homedir(), '.html2mp4');
const CACHE_FILE = path.join(CACHE_DIR, 'license.json');
const RECHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getMachineId() {
  return `${os.hostname()}-${os.platform()}-${os.arch()}`;
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function post(endpoint, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, LICENSE_URL);
    const payload = JSON.stringify(body);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid response from license server')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function activateLicense(key) {
  const machineId = getMachineId();
  console.log('Activating license...');

  let result;
  try {
    result = await post('/activate', { key, machineId });
  } catch (err) {
    console.error(`Could not reach license server: ${err.message}`);
    process.exit(1);
  }

  if (!result.valid) {
    console.error(`Activation failed: ${result.error || 'invalid key'}`);
    process.exit(1);
  }

  writeCache({ key, machineId, activatedAt: Date.now(), lastChecked: Date.now(), valid: true });
  console.log('License activated successfully.');
}

async function checkLicense() {
  const cache = readCache();

  if (!cache || !cache.valid) {
    printNoLicenseError();
    process.exit(1);
  }

  if (cache.machineId !== getMachineId()) {
    console.error('License is bound to a different machine. Run: html2mp4 activate <KEY>');
    process.exit(1);
  }

  const age = Date.now() - (cache.lastChecked || 0);
  if (age < RECHECK_INTERVAL_MS) return; // Still fresh — allow offline use

  // Periodic re-validation
  try {
    const result = await post('/check', { key: cache.key, machineId: cache.machineId });
    if (!result.valid) {
      writeCache({ ...cache, valid: false });
      console.error(`License revoked: ${result.error || 'contact support'}`);
      process.exit(1);
    }
    writeCache({ ...cache, lastChecked: Date.now(), valid: true });
  } catch {
    // Network unavailable — allow use, warn user
    console.warn('[license] Could not reach license server, continuing offline.');
  }
}

async function showStatus() {
  const cache = readCache();
  if (!cache) {
    console.log('Status: NOT ACTIVATED');
    console.log('Run: html2mp4 activate <LICENSE_KEY>');
    return;
  }
  const activated = new Date(cache.activatedAt).toLocaleDateString();
  const checked = new Date(cache.lastChecked).toLocaleDateString();
  console.log(`Status:       ${cache.valid ? 'ACTIVE' : 'INVALID'}`);
  console.log(`Machine ID:   ${cache.machineId}`);
  console.log(`Activated:    ${activated}`);
  console.log(`Last checked: ${checked}`);
}

function printNoLicenseError() {
  console.error('');
  console.error('  html2mp4 requires a valid license.');
  console.error('  Purchase at: https://htmltomp4astro.pages.dev');
  console.error('  Then run:    html2mp4 activate <LICENSE_KEY>');
  console.error('');
}

module.exports = { activateLicense, checkLicense, showStatus };
