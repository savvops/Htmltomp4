const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { Writable } = require('node:stream');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  monitorFfmpegProcess,
  writeWithBackpressure,
  publishOutput,
  convertHtmlToVideo,
} = require('../convert');

function childWith(code) {
  return spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'ignore', 'pipe'] });
}

test('an encoder that closes before wait is observed does not hang', { timeout: 5000 }, async () => {
  const monitor = monitorFfmpegProcess(childWith("process.stderr.write('encoder init failed'); process.exitCode = 7;"), { timeoutMs: 4000 });
  await monitor.done;
  assert.equal(monitor.state.closed, true);
  await assert.rejects(monitor.wait(), /code 7[\s\S]*encoder init failed/);
});

test('a missing encoder reports ENOENT without an uncaught stream error', { timeout: 5000 }, async () => {
  const child = spawn(path.join(os.tmpdir(), `missing-htmltomp4-encoder-${process.pid}`), [], { stdio: ['pipe', 'ignore', 'pipe'] });
  const monitor = monitorFfmpegProcess(child, { timeoutMs: 4000 });
  await assert.rejects(monitor.wait(), { code: 'ENOENT' });
});

test('a stalled encoder is killed and reports the timeout', { timeout: 5000 }, async () => {
  const child = childWith('setInterval(() => {}, 1000);');
  let notified = false;
  const monitor = monitorFfmpegProcess(child, { timeoutMs: 100, onFailure: () => { notified = true; } });
  await assert.rejects(monitor.wait(), { code: 'ETIMEDOUT' });
  assert.equal(notified, true);
  assert.equal(monitor.state.closed, true);
  assert.equal(child.killed, true);
});

test('explicit cancellation reaps the encoder', { timeout: 5000 }, async () => {
  const child = childWith('setInterval(() => {}, 1000);');
  const monitor = monitorFfmpegProcess(child, { timeoutMs: 4000 });
  monitor.terminate(Object.assign(new Error('cancelled by caller'), { code: 'ABORT_ERR' }));
  await assert.rejects(monitor.wait(), { code: 'ABORT_ERR' });
  assert.equal(monitor.state.closed, true);
});

test('encoder diagnostics retain a bounded tail', { timeout: 5000 }, async () => {
  const monitor = monitorFfmpegProcess(childWith("process.stderr.write('x'.repeat(100000) + 'THE_END', () => { process.exitCode = 3; });"), { timeoutMs: 4000 });
  await assert.rejects(monitor.wait(), /THE_END/);
  assert.equal(monitor.state.stderr.length, 65536);
  assert.equal(monitor.state.stderr.endsWith('THE_END'), true);
});

test('successful early close is awaitable and cancels its watchdog', { timeout: 5000 }, async () => {
  let notified = false;
  const monitor = monitorFfmpegProcess(childWith('process.exitCode = 0;'), { timeoutMs: 1000, onFailure: () => { notified = true; } });
  await monitor.done;
  await monitor.wait();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(notified, false);
});

test('a failed backpressured write rejects and removes temporary listeners', async () => {
  const stream = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) { setImmediate(() => callback(new Error('encoder pipe failed'))); },
  });
  // The monitor owns the permanent error handler in production.
  stream.on('error', () => {});
  const errorListeners = stream.listenerCount('error');
  await assert.rejects(writeWithBackpressure(stream, Buffer.alloc(8192)), /encoder pipe failed/);
  assert.equal(stream.listenerCount('error'), errorListeners);
  assert.equal(stream.listenerCount('drain'), 0);
  assert.equal(stream.listenerCount('close'), 0);
});

test('backpressured writes wait for the sink to accept the chunk', async () => {
  let accepted = false;
  const stream = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) { setImmediate(() => { accepted = true; callback(); }); },
  });
  await writeWithBackpressure(stream, Buffer.alloc(8192));
  assert.equal(accepted, true);
  assert.equal(stream.listenerCount('drain'), 0);
  stream.end();
});

test('publishing preserves existing files unless overwrite is explicit', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'htmltomp4-publish-test-'));
  try {
    const temporary = path.join(directory, 'temporary.mp4');
    const output = path.join(directory, 'output.mp4');
    await fs.writeFile(temporary, 'new render');
    await fs.writeFile(output, 'original render');
    await assert.rejects(publishOutput(temporary, output), /already exists/);
    assert.equal(await fs.readFile(output, 'utf8'), 'original render');
    await publishOutput(temporary, output, true);
    assert.equal(await fs.readFile(output, 'utf8'), 'new render');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('concurrent default publishes cannot overwrite one another', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'htmltomp4-publish-test-'));
  try {
    const first = path.join(directory, 'first.mp4');
    const second = path.join(directory, 'second.mp4');
    const output = path.join(directory, 'output.mp4');
    await fs.writeFile(first, 'first');
    await fs.writeFile(second, 'second');
    const results = await Promise.allSettled([publishOutput(first, output), publishOutput(second, output)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.ok(['first', 'second'].includes(await fs.readFile(output, 'utf8')));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('failed rendering preserves the original output and removes only its staging directory', { timeout: 5000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'htmltomp4-render-cleanup-test-'));
  let pageClosed = false;
  const page = Object.assign(new EventEmitter(), {
    setViewport: async () => {}, evaluateOnNewDocument: async () => {},
    goto: async () => {}, waitForNetworkIdle: async () => {}, evaluate: async () => false,
    screenshot: async () => { throw new Error('capture deliberately failed'); },
    close: async () => { pageClosed = true; },
  });
  try {
    const input = path.join(directory, 'source.html');
    const output = path.join(directory, 'source.mp4');
    await fs.writeFile(input, '<html></html>');
    await fs.writeFile(output, 'keep this original');
    await assert.rejects(convertHtmlToVideo(input, {
      browser: { newPage: async () => page }, outputDir: directory, overwrite: true,
      width: 16, height: 16, frameRate: 1, duration: 1, frameRetries: 0, gpu: 'cpu',
      _ffmpegResolved: process.execPath, _gpuSupport: {}, ffmpegTimeoutMs: 60000,
    }), /capture deliberately failed|FFmpeg ended early/);
    assert.equal(pageClosed, true);
    assert.equal(await fs.readFile(output, 'utf8'), 'keep this original');
    assert.deepEqual((await fs.readdir(directory)).sort(), ['source.html', 'source.mp4']);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('an already cancelled render stops before touching files or launching a browser', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(convertHtmlToVideo('missing.html', { signal: controller.signal }), { code: 'ABORT_ERR' });
});

test('cancellation during newPage waits for one complete owned-browser shutdown', { timeout: 5000 }, async () => {
  const puppeteer = require('puppeteer');
  const originalLaunch = puppeteer.launch;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'htmltomp4-cancel-close-test-'));
  const controller = new AbortController();
  let closeCalls = 0;
  let fullyClosed = false;
  let launchOptions;
  const browser = {
    async newPage() {
      controller.abort();
      throw new Error('newPage interrupted');
    },
    close() {
      closeCalls++;
      // Reproduce Puppeteer's behavior: subsequent calls return early while the
      // first call is still shutting down Chromium and cleaning its profile.
      if (closeCalls > 1) return Promise.resolve();
      return new Promise((resolve) => setTimeout(() => { fullyClosed = true; resolve(); }, 50));
    },
  };
  puppeteer.launch = async (options) => { launchOptions = options; return browser; };
  try {
    const input = path.join(directory, 'source.html');
    await fs.writeFile(input, '<html></html>');
    await assert.rejects(convertHtmlToVideo(input, {
      outputDir: directory, signal: controller.signal,
      _ffmpegResolved: process.execPath, _gpuSupport: {}, gpu: 'cpu',
    }), { code: 'ABORT_ERR' });
    assert.equal(closeCalls, 1, 'abort and finally must share one close promise');
    assert.equal(fullyClosed, true, 'conversion must not report completion while shutdown is pending');
    assert.equal(launchOptions.handleSIGINT, false, 'the CLI owns interruption and cleanup');
    assert.equal(launchOptions.handleSIGTERM, false);
    assert.deepEqual(await fs.readdir(directory), ['source.html']);
  } finally {
    puppeteer.launch = originalLaunch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('cancellation never closes a browser supplied by a desktop caller', { timeout: 5000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'htmltomp4-cancel-shared-test-'));
  const controller = new AbortController();
  let closeCalls = 0;
  const browser = {
    async newPage() { controller.abort(); throw new Error('newPage interrupted'); },
    async close() { closeCalls++; },
  };
  try {
    const input = path.join(directory, 'source.html');
    await fs.writeFile(input, '<html></html>');
    await assert.rejects(convertHtmlToVideo(input, {
      browser, outputDir: directory, signal: controller.signal,
      _ffmpegResolved: process.execPath, _gpuSupport: {}, gpu: 'cpu',
    }), { code: 'ABORT_ERR' });
    assert.equal(closeCalls, 0);
    assert.deepEqual(await fs.readdir(directory), ['source.html']);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
