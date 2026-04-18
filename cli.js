#!/usr/bin/env node
'use strict';

require('dotenv').config();

const { activateLicense, checkLicense, showStatus } = require('./lib/license.js');

const subcmd = process.argv[2];

async function run() {
  if (subcmd === 'activate') {
    const key = process.argv[3];
    if (!key) {
      console.error('Usage: html2mp4 activate <LICENSE_KEY>');
      process.exit(1);
    }
    await activateLicense(key);
    return;
  }

  if (subcmd === 'license') {
    await showStatus();
    return;
  }

  const helpFlags = ['--help', '-h', '--version', '-v'];
  const needsLicense = !process.argv.slice(2).some(a => helpFlags.includes(a));
  if (needsLicense) await checkLicense();

  // Delegate all parsing and conversion to convert.js's main()
  const { main } = require('./convert.js');
  await main();
}

run().catch(err => {
  console.error('Fatal:', err.message || err);
  process.exit(1);
});
