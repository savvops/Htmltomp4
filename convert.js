// convert.js
/**
 * Robust HTML->MP4 frame encoder with Puppeteer + FFmpeg (piped).
 * SPEED PROFILE (defaults tuned for RTX 2060+):
 * - Parallel 2 (override with --parallel)
 * - 4K/60 ready (start script passes flags)
 * - NVENC (GPU) by default; falls back to CPU if NVENC missing
 * - JPEG piping (smaller frames) for faster capture/encode
 * - GPU rendering enabled with automatic fallback to --disable-gpu
 * - Deterministic animation stepping (RAF/CSS)
 * - 30-minute default FFmpeg timeout; timeouts are skipped (batch continues)
 */

const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { pathToFileURL } = require('url');

const ROOT = __dirname;

// -------------------- Helpers: ffmpeg resolution & NVENC detection --------------------

function tryRequireFFmpegStatic() {
  try { return require('ffmpeg-static') || null; } catch { return null; }
}

function detectNvenc(ffmpegPath) {
  try {
    const res = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = (res.stdout ? String(res.stdout) : '') + (res.stderr ? String(res.stderr) : '');
    const hasH264 = /h264_nvenc/i.test(out);
    const hasHevc = /hevc_nvenc/i.test(out);
    return { hasH264, hasHevc, any: hasH264 || hasHevc, banner: out };
  } catch {
    return { hasH264: false, hasHevc: false, any: false, banner: '' };
  }
}

function resolveFfmpegPathPreferNvenc(explicitPath) {
  const ffmpegStatic = tryRequireFFmpegStatic();

  if (explicitPath && explicitPath.trim()) {
    const nv = detectNvenc(explicitPath);
    return { path: explicitPath, nvenc: nv };
  }

  // Try system ffmpeg first
  let nv = detectNvenc('ffmpeg');
  if (nv.any) return { path: 'ffmpeg', nvenc: nv };

  // Fallback: ffmpeg-static
  if (ffmpegStatic) {
    nv = detectNvenc(ffmpegStatic);
    return { path: ffmpegStatic, nvenc: nv };
  }

  // Last resort: system ffmpeg even without NVENC
  return { path: 'ffmpeg', nvenc: { hasH264: false, hasHevc: false, any: false } };
}

// -------------------- Config & CLI --------------------

function getConfig(args) {
  const defaultConfig = {
    width: 3840,
    height: 2160,
    frameRate: 60,
    duration: 10, // seconds
    inputDir: path.join(ROOT, 'html_files'),
    outputDir: path.join(ROOT, 'output'),

    executablePath: undefined,     // Let Puppeteer find Chrome by default
    browser: undefined,
    headless: true,                // headless for stability (override with --headless=false)
    enableGpu: true,               // try GPU; auto-fallback if launch fails

    inputCodec: 'jpeg',            // 'jpeg' | 'png'
    jpegQuality: 85,               // JPEG quality (0-100)

    ffmpegPath: undefined,         // prefer system ffmpeg; resolve automatically
    ffmpegTimeoutMs: 30 * 60 * 1000,

    // Encoding (speed-biased defaults)
    encoder: 'nvenc',              // force NVENC by default for speed
    nvencPreset: 'p1',             // p1 fastest
    nvencRC: 'vbr',                // faster than vbr_hq
    nvencCQ: 23,                   // slightly lower quality, faster encode
    cpuPreset: 'ultrafast',        // CPU fallback preset
    cpuCrf4k: 18,
    cpuCrf8k: 24,
    pixFmt: 'yuv420p',

    parallel: 4,                   // 2 workers by default
    format: 'mp4',                 // 'mp4', 'webm', 'prores'
  };
  return { ...defaultConfig, ...args };
}

// -------------------- Small utilities --------------------

function writeWithBackpressure(stream, chunk) {
  return new Promise((resolve, reject) => {
    if (!stream || stream.destroyed || stream.writableEnded || !stream.writable) {
      return reject(new Error('FFmpeg stdin is not writable (stream ended or destroyed).'));
    }
    const ok = stream.write(chunk, (err) => {
      if (err) return reject(err);
      if (ok) resolve();
    });
    if (!ok) stream.once('drain', resolve);
  });
}

// Returns a formatted progress bar string, does not render it.
function formatBar(current, total) {
  const barWidth = 30;
  const ratio = Math.max(0, Math.min(1, total ? current / total : 0));
  const filled = Math.round(ratio * barWidth);
  const empty = barWidth - filled;
  const pct = Math.round(ratio * 100);
  return `[${'#'.repeat(filled)}${'-'.repeat(empty)}] ${pct}% (${current}/${total})`;
}

// Timeout resolver: explicit ms; -1 disables; otherwise 30m.
function resolveFfmpegTimeoutMs({ userTimeoutMs }) {
  if (Number.isFinite(userTimeoutMs)) return userTimeoutMs < 0 ? Infinity : userTimeoutMs;
  return 30 * 60 * 1000;
}

function makeLaunchArgs({ width, height, enableGpu }) {
  const args = [
    `--window-size=${width},${height}`,
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (enableGpu) {
    args.push('--enable-gpu');
    if (process.platform === 'win32') args.push('--use-angle=d3d11');
  } else {
    args.push('--disable-gpu');
  }
  return args;
}

function makeInputPipeArgs(inputCodec) {
  const isPng = String(inputCodec).toLowerCase() === 'png';
  return isPng
    ? ['-f', 'image2pipe', '-vcodec', 'png', '-i', 'pipe:0']
    : ['-f', 'image2pipe', '-vcodec', 'mjpeg', '-i', 'pipe:0']; // JPEG frames
}



function makeVideoCodecArgs({ is8k, cfg, nvencSupport }) {
  if (cfg.format === 'webm') {
    return [
      '-c:v', 'libvpx-vp9',
      '-b:v', '0',
      '-crf', '30',
      '-pix_fmt', 'yuva420p', // Alpha support
      '-auto-alt-ref', '0' // Transparency fix
    ];
  }
  if (cfg.format === 'prores') {
    return [
      '-c:v', 'prores_ks',
      '-profile:v', '3', // 4444
      '-pix_fmt', 'yuva444p10le', // 10-bit + alpha
      '-q:v', '5' // Quality
    ];
  }

  // Default to MP4 (NVENC/H.264/H.265)
  const wantNvenc = cfg.encoder === 'nvenc' || (cfg.encoder === 'auto' && nvencSupport.any);
  if (wantNvenc) {
    const args = ['-pix_fmt', cfg.pixFmt];
    if (is8k && nvencSupport.hasHevc) {
      return [
        '-c:v', 'hevc_nvenc',
        '-preset', cfg.nvencPreset,
        '-rc', cfg.nvencRC,
        '-cq', String(cfg.nvencCQ),
        ...args,
        '-tag:v', 'hvc1',
      ];
    }
    if (nvencSupport.hasH264) {
      return [
        '-c:v', 'h264_nvenc',
        '-preset', cfg.nvencPreset,
        '-rc', cfg.nvencRC,
        '-cq', String(cfg.nvencCQ),
        ...args,
      ];
    }
    console.warn('[convert] NVENC requested/auto but not available in this ffmpeg build. Falling back to CPU.');
  }
  // CPU fallback
  return is8k
    ? ['-c:v', 'libx265', '-pix_fmt', cfg.pixFmt, '-preset', cfg.cpuPreset, '-crf', String(cfg.cpuCrf8k)]
    : ['-c:v', 'libx264', '-pix_fmt', cfg.pixFmt, '-preset', cfg.cpuPreset, '-crf', String(cfg.cpuCrf4k)];
}

// -------------------- Core conversion --------------------

async function convertHtmlToVideo(htmlFile, config) {
  const baseName = path.basename(htmlFile, '.html');
  const framesDir = path.join(ROOT, 'frames', baseName);
  await fs.mkdir(framesDir, { recursive: true }); // not used, but kept for parity/cleanup

  const ext = config.format === 'webm' ? '.webm' : (config.format === 'prores' ? '.mov' : '.mp4');
  const outputVideoPath = path.join(config.outputDir, `${baseName}${ext}`);
  await fs.mkdir(config.outputDir, { recursive: true });

  const totalFrames = Math.max(1, Math.round(config.duration * config.frameRate));
  const dtMs = 1000 / config.frameRate;

  let browser = config.browser;
  let page;
  let ffmpegProcess;
  let ffmpegClosed = false;
  let ffmpegError = null;
  let ffmpegProgressFrame = 0;
  let ffmpegStderrOutput = '';

  // ---------- Puppeteer launch ----------
  const launchArgs = makeLaunchArgs({
    width: config.width,
    height: config.height,
    enableGpu: config.enableGpu,
  });

  try {
    if (!browser) {
      try {
        browser = await puppeteer.launch({
          executablePath: config.executablePath,
          headless: config.headless,
          args: launchArgs,
        });
      } catch (e) {
        if (config.enableGpu) {
          console.warn(`[convert] GPU launch failed ("${e.message}"). Retrying with --disable-gpu...`);
          const fallbackArgs = makeLaunchArgs({ width: config.width, height: config.height, enableGpu: false });
          browser = await puppeteer.launch({
            executablePath: config.executablePath,
            headless: config.headless,
            args: fallbackArgs,
          });
        } else {
          throw e;
        }
      }
    }
    page = await browser.newPage();
    await page.setViewport({ width: config.width, height: config.height, deviceScaleFactor: 1 });

    // Deterministic RAF shim
    await page.evaluateOnNewDocument(() => {
      (function installRafShim() {
        const _nativeRAF = window.requestAnimationFrame.bind(window);
        const _nativeCAF = window.cancelAnimationFrame.bind(window);
        let rafQueue = new Map();
        let nextId = 1;
        function shimRAF(cb) { const id = nextId++; rafQueue.set(id, cb); return id; }
        function shimCAF(id) { rafQueue.delete(id); }
        function rafStep(time) {
          const batch = Array.from(rafQueue.entries());
          rafQueue.clear();
          for (const [, cb] of batch) { try { cb(time); } catch { /* ignore callback errors */ } }
        }
        window.__HTV__ = window.__HTV__ || {};
        window.__HTV__.rafStep = rafStep;
        window.__HTV__.restoreRAF = () => { window.requestAnimationFrame = _nativeRAF; window.cancelAnimationFrame = _nativeCAF; };
        window.__HTV__.hasRafShim = true;
        window.requestAnimationFrame = shimRAF;
        window.cancelAnimationFrame = shimCAF;
      })();
    });

    const fileUrl = pathToFileURL(path.join(config.inputDir, htmlFile)).href;
    await page.goto(fileUrl, { waitUntil: 'domcontentloaded' });
    try { await page.waitForNetworkIdle({ idleTime: 250, timeout: 5000 }); } catch { /* ignore network idle error */ }

    // Ensure fonts/images are ready
    await page.evaluate(async () => {
      if (document.fonts && document.fonts.status !== 'loaded') {
        try { await document.fonts.ready; } catch { /* ignore font ready error */ }
      }
      const images = Array.from(document.images || []);
      await Promise.all(images.map(img => img.decode?.().catch(() => { /* ignore image decode error */ })));
    });

    // Pause CSS animations and set timing state
    await page.evaluate((fps) => {
      const anims = document.getAnimations({ subtree: true }) || [];
      const meta = anims.map(a => {
        try { a.pause(); } catch { /* ignore pause error */ }
        let delay = 0; try { delay = a.effect?.getTiming?.().delay || 0; } catch { /* ignore delay error */ }
        return { delay };
      });
      window.__HTV__ = Object.assign(window.__HTV__ || {}, { exporting: true, fps, anims, meta, totalDurationMs: 0 });
    }, config.frameRate);

    const hasNextFrame = await page.evaluate(() => typeof window.nextFrame === 'function');
    await page.evaluate((totalMs) => { if (window.__HTV__) window.__HTV__.totalDurationMs = totalMs; }, totalFrames * dtMs);

    // ---------- FFmpeg spawn ----------
    const is8k = (config.width >= 7680 || config.height >= 4320);
    const inputFmtArgs = makeInputPipeArgs(config.inputCodec);
    const videoCodecArgs = makeVideoCodecArgs({
      is8k,
      cfg: config,
      nvencSupport: config._nvencSupport || { hasH264: false, hasHevc: false, any: false },
    });

    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel', 'error',
      '-progress', 'pipe:2',
      '-framerate', String(config.frameRate),
      ...inputFmtArgs,
      ...videoCodecArgs,
      '-movflags', '+faststart',
      '-r', String(config.frameRate),
      '-frames:v', String(totalFrames),
      '-y', outputVideoPath,
    ];

    const ffmpegPath = config._ffmpegResolved || 'ffmpeg';
    ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, { stdio: ['pipe', 'ignore', 'pipe'] });

    ffmpegProcess.stderr.setEncoding('utf8');
    ffmpegProcess.stderr.on('data', data => {
      ffmpegStderrOutput += data;
      const lines = String(data).split(/\r?\n/);
      for (const line of lines) {
        if (line.startsWith('frame=')) {
          const n = parseInt(line.slice(6).trim(), 10);
          if (!Number.isNaN(n)) {
            ffmpegProgressFrame = Math.max(ffmpegProgressFrame, n);
            const bar = formatBar(Math.min(ffmpegProgressFrame, totalFrames), totalFrames);
            config.updateStatus(config.workerId, `[Worker ${config.workerId}] Starting: ${baseName}.html Encoding ${bar}`);
          }
        }
      }
    });
    ffmpegProcess.on('error', err => { ffmpegError = err; });
    ffmpegProcess.on('close', (code, signal) => {
      ffmpegClosed = true;
      if (code !== 0 && !ffmpegError) {
        ffmpegError = new Error(`ffmpeg exited with code ${code}${signal ? `, signal ${signal}` : ''}`);
      }
    });

    const timeoutMs = resolveFfmpegTimeoutMs({ userTimeoutMs: config.ffmpegTimeoutMs });
    const timeoutHandle = Number.isFinite(timeoutMs)
      ? setTimeout(() => {
        if (!ffmpegClosed) {
          ffmpegError = new Error(`ffmpeg process timed out after ${Math.round(timeoutMs / 1000)}s.`);
          try { ffmpegProcess.kill('SIGKILL'); } catch { /* ignore kill error */ }
        }
      }, timeoutMs)
      : null;

    for (let i = 0; i < totalFrames; i++) {
      if (ffmpegClosed || ffmpegError || !ffmpegProcess.stdin || ffmpegProcess.stdin.destroyed || ffmpegProcess.stdin.writableEnded) {
        throw new Error(
          `FFmpeg ended early at input frame ${i}.` +
          (ffmpegError ? `\n\nReason: ${ffmpegError.message}` : '') +
          (ffmpegStderrOutput ? `\n\nFFmpeg output:\n${ffmpegStderrOutput}` : '')
        );
      }

      const t = i * dtMs;
      const progress = totalFrames > 1 ? i / (totalFrames - 1) : 1;

      await page.evaluate(({ time, dt, useNextFrame, progress }) => {
        let anims = (window.__HTV__ && window.__HTV__.anims) || [];
        if (!anims.length) {
          anims = document.getAnimations({ subtree: true }) || [];
          window.__HTV__ = window.__HTV__ || {};
          window.__HTV__.anims = anims;
          window.__HTV__.meta = anims.map(a => {
            try { a.pause(); } catch { /* ignore pause error */ }
            let delay = 0; try { delay = a.effect?.getTiming?.().delay || 0; } catch { /* ignore delay error */ }
            return { delay };
          });
        }

        const meta = (window.__HTV__ && window.__HTV__.meta) || [];
        for (let k = 0; k < anims.length; k++) {
          const a = anims[k];
          if (a.playState !== 'paused') { try { a.pause(); } catch { /* ignore pause error */ } }
          const delay = (meta[k] && meta[k].delay) || 0;
          const localTime = Math.max(0, time - delay);
          try { a.currentTime = localTime; } catch { /* ignore time set error */ }
        }
        if (window.__HTV__ && typeof window.__HTV__.rafStep === 'function') {
          try { window.__HTV__.rafStep(time); } catch { /* ignore raf error */ }
        }
        if (useNextFrame && typeof window.nextFrame === 'function') {
          const total = (window.__HTV__ && window.__HTV__.totalDurationMs) || 1;
          const payload = { time, delta: dt, progress: Math.max(0, Math.min(1, progress || (time / total))) };
          try { window.nextFrame(payload); } catch { /* ignore nextFrame error */ }
        }
        void document.body.offsetWidth;
      }, { time: t, dt: dtMs, useNextFrame: hasNextFrame, progress });

      const shotOpts = (String(config.inputCodec).toLowerCase() === 'png')
        ? { type: 'png' }
        : { type: 'jpeg', quality: config.jpegQuality };

      let frameBuffer;
      try { frameBuffer = await page.screenshot(shotOpts); }
      catch (shotErr) { throw new Error(`Capture failed at frame ${i}: ${shotErr.message}`); }

      try { await writeWithBackpressure(ffmpegProcess.stdin, frameBuffer); }
      catch (writeErr) {
        throw new Error(`Failed to write frame ${i} to ffmpeg: ${writeErr.message}` +
          (ffmpegStderrOutput ? `\n\nFFmpeg output:\n${ffmpegStderrOutput}` : ''));
      }

      const bar = formatBar(i + 1, totalFrames);
      config.updateStatus(config.workerId, `[Worker ${config.workerId}] Starting: ${baseName}.html Capturing ${bar}`);
    }

    if (ffmpegProcess && ffmpegProcess.stdin && !ffmpegProcess.stdin.destroyed) {
      ffmpegProcess.stdin.end();
    }

    await new Promise((resolve, reject) => {
      const done = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (ffmpegError) return reject(ffmpegError);
        if (!ffmpegClosed) {
          setTimeout(() => (ffmpegError ? reject(ffmpegError) : resolve()), 300);
        } else {
          resolve();
        }
      };
      ffmpegProcess.once('close', done);
      ffmpegProcess.once('exit', done);
    });

  } catch (error) {
    if (ffmpegProcess) { try { ffmpegProcess.kill('SIGKILL'); } catch { /* ignore kill error */ } }
    throw error;
  } finally {
    if (page) { try { await page.close(); } catch { /* ignore page close error */ } }
    if (!config.browser && browser) { try { await browser.close(); } catch { /* ignore browser close error */ } }
    // Only remove the specific frames directory for this job
    try { await fs.rm(framesDir, { recursive: true, force: true }); } catch { /* ignore rm error */ }
  }
}

// -------------------- CLI main (with parallel batching) --------------------

async function main() {
  console.time('Execution Time');

  const argv = yargs(hideBin(process.argv))
    .usage('Usage: $0 [html_files...] [options]')
    .option('width', { type: 'number' })
    .option('height', { type: 'number' })
    .option('frameRate', { type: 'number' })
    .option('duration', { type: 'number' })
    .option('inputDir', { type: 'string' })
    .option('outputDir', { type: 'string' })
    .option('executablePath', { type: 'string' })
    .option('headless', { type: 'boolean', default: true })
    .option('enableGpu', { type: 'boolean', default: true })
    .option('inputCodec', { type: 'string', choices: ['png', 'jpeg'], default: 'jpeg' })
    .option('jpegQuality', { type: 'number', default: 85 })
    .option('ffmpegPath', { type: 'string' })
    .option('ffmpegTimeoutSec', { type: 'number', default: 1800 })
    .option('encoder', { type: 'string', choices: ['auto', 'nvenc', 'cpu'], default: 'nvenc' })
    .option('nvencPreset', { type: 'string', default: 'p1' })
    .option('nvencRC', { type: 'string', default: 'vbr' })
    .option('nvencCQ', { type: 'number', default: 23 })
    .option('cpuPreset', { type: 'string', default: 'ultrafast' })
    .option('cpuCrf4k', { type: 'number', default: 18 })
    .option('cpuCrf8k', { type: 'number', default: 24 })
    .option('pixFmt', { type: 'string', default: 'yuv420p' })
    .option('parallel', { alias: 'p', type: 'number', default: 2 })
    .option('format', { type: 'string', choices: ['mp4', 'webm', 'prores'], default: 'mp4' })
    .help().alias('h', 'help')
    .parse();

  const config = getConfig({
    ...argv,
    ffmpegTimeoutMs: Number.isFinite(argv.ffmpegTimeoutSec) ? argv.ffmpegTimeoutSec * 1000 : undefined
  });

  const processedDir = path.join(ROOT, 'processed_htmls');
  await fs.mkdir(processedDir, { recursive: true });

  // Resolve FFmpeg path with NVENC preference (system first)
  const { path: resolvedFfmpeg, nvenc } = resolveFfmpegPathPreferNvenc(config.ffmpegPath);
  config._ffmpegResolved = resolvedFfmpeg;
  config._nvencSupport = nvenc;

  // Effective parallelism (keep 2 for 2060; bump to 3 only if you know your NVENC session limit)
  const usingNvenc = config.encoder === 'nvenc' || (config.encoder === 'auto' && config._nvencSupport.any);
  const maxNvencSessions = 4; // NOTE: Consumer GPUs (GeForce/RTX) are often limited to 2-3 sessions. May require a patched driver.
  const effectiveParallel = Math.max(1, Math.min(config.parallel, usingNvenc ? maxNvencSessions : config.parallel));

  const inputFiles = argv._.map(f => String(f));

  // --- Multi-line status rendering setup ---
  const workerStatuses = {};
  let linesRendered = 0;
  let renderInterval;

  // A small, robust wrapper for writing to a TTY stream.
  function safeTTYWrite(action) {
    if (!process.stdout.isTTY) return;
    try {
      action();
    } catch (_error) {
      // Silently ignore errors, which usually happen when the terminal is resized or closed.
    }
  }

  function render() {
    const statusLines = Object.values(workerStatuses);
    if (statusLines.length === 0 && linesRendered === 0) return;

    // Move cursor up to the top of the worker status block.
    if (linesRendered > 0) {
      safeTTYWrite(() => process.stdout.moveCursor(0, -linesRendered));
    }

    // Render each worker's status line.
    for (let i = 0; i < statusLines.length; i++) {
      safeTTYWrite(() => process.stdout.cursorTo(0));
      safeTTYWrite(() => process.stdout.clearLine(0));
      safeTTYWrite(() => process.stdout.write(statusLines[i]));
      if (i < statusLines.length - 1) {
        safeTTYWrite(() => process.stdout.write('\n'));
      }
    }
    linesRendered = statusLines.length;
  }

  function updateStatus(workerId, status) {
    workerStatuses[workerId] = status;
    if (!process.stdout.isTTY) {
      // Non-TTY fallback: Log update if enough time passed to avoid flooding (throttle ~500ms)
      // ALWAYS log if it's a "Finished", "Error", or "Starting" message to ensure key events aren't missed
      const isImportant = status.includes('Finished') || status.includes('ERROR') || status.includes('Starting') || status.includes('100%');
      const now = Date.now();
      if (isImportant || !workerStatuses[workerId + '_lastLog'] || now - workerStatuses[workerId + '_lastLog'] > 1000) {
        console.log(status);
        workerStatuses[workerId + '_lastLog'] = now;
      }
    }
  }

  function startRendering() {
    // Start the render loop only if we are in a TTY environment.
    if (process.stdout.isTTY) {
      // Create initial space for workers.
      for (let i = 0; i < effectiveParallel; i++) {
        safeTTYWrite(() => process.stdout.write('\n'));
      }
      linesRendered = effectiveParallel;
      renderInterval = setInterval(render, 100);
    }
  }

  function stopRendering() {
    if (renderInterval) {
      clearInterval(renderInterval);
    }
    if (process.stdout.isTTY) {
      render(); // Final render for TTY
    }
  }
  // --- End rendering setup ---


  try {
    // Determine input set
    let filesToProcess = [];
    if (inputFiles.length > 0) {
      filesToProcess = inputFiles.filter(file => file.toLowerCase().endsWith('.html'));
    } else {
      const allFiles = await fs.readdir(config.inputDir);
      filesToProcess = allFiles.filter(file => file.toLowerCase().endsWith('.html'));
    }

    if (!filesToProcess.length) {
      console.log('No .html files found to process.');
      return;
    }

    console.log(
      `Starting batch: ${filesToProcess.length} file(s) | parallel=${effectiveParallel} | ` +
      `encoder=${usingNvenc ? 'NVENC' : (config.encoder === 'cpu' ? 'CPU' : (config._nvencSupport.any ? 'auto(NVENC)' : 'auto(CPU)'))} | ` +
      `ffmpeg=${resolvedFfmpeg}`
    );

    const queue = [...filesToProcess];
    const totalFiles = queue.length;
    let processedCount = 0;
    let hasErrors = false;

    async function worker(id) {
      let sharedBrowser = null;

      const getBrowser = async () => {
        if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
        if (sharedBrowser) try { await sharedBrowser.close(); } catch { /* ignore */ }

        const launchArgs = makeLaunchArgs({
          width: config.width,
          height: config.height,
          enableGpu: config.enableGpu,
        });

        const launch = async (args) => puppeteer.launch({
          executablePath: config.executablePath,
          headless: config.headless,
          args,
        });

        try {
          sharedBrowser = await launch(launchArgs);
        } catch (e) {
          if (config.enableGpu) {
            console.warn(`[Worker ${id}] GPU launch failed. Retrying with --disable-gpu...`);
            const fallbackArgs = makeLaunchArgs({ width: config.width, height: config.height, enableGpu: false });
            sharedBrowser = await launch(fallbackArgs);
          } else {
            throw e;
          }
        }
        return sharedBrowser;
      };

      try {
        while (queue.length > 0) {
          const htmlFile = queue.shift();
          if (!htmlFile) continue;

          updateStatus(id, `[Worker ${id}] Starting: ${htmlFile}`);
          try {
            const b = await getBrowser();
            await convertHtmlToVideo(htmlFile, { ...config, browser: b, workerId: id, updateStatus });
            processedCount++;
            const successMsg = `[Worker ${id}] Finished: ${htmlFile} (${processedCount}/${totalFiles})`;
            updateStatus(id, successMsg);

            // File moving logic removed to keep source files available
            // const sourcePath = path.join(config.inputDir, htmlFile);
            // const destPath = path.join(processedDir, htmlFile);
            // await fs.rename(sourcePath, destPath);
          } catch (err) {
            hasErrors = true;
            const msg = (err && err.message) ? err.message : String(err);
            let errorMsg;
            if (msg.toLowerCase().includes('timed out')) {
              const mins = Number.isFinite(config.ffmpegTimeoutMs) ? Math.round(config.ffmpegTimeoutMs / 60000) : 'disabled';
              errorMsg = `[SKIP] ${htmlFile} timed out at ${mins} minute(s).`;
            } else {
              errorMsg = `[ERROR] Worker ${id} failed on ${htmlFile}: ${msg}`;
            }
            updateStatus(id, errorMsg);

            // If browser crashed, force close so it restarts next loop
            if (sharedBrowser && !sharedBrowser.isConnected()) {
              try { await sharedBrowser.close(); } catch { }
              sharedBrowser = null;
            }
          }
        }
      } finally {
        if (sharedBrowser) try { await sharedBrowser.close(); } catch { /* ignore */ }
      }
    }

    startRendering();

    const workers = [];
    for (let i = 1; i <= effectiveParallel; i++) {
      workers.push(worker(i));
    }

    await Promise.all(workers);

    stopRendering();

    // Final summary log
    console.log('\n--- Batch Summary ---');
    const finalStatuses = Object.values(workerStatuses);
    for (const status of finalStatuses) {
      console.log(status);
    }

    console.log('All conversions finished.');
    if (hasErrors) {
      console.error('One or more jobs failed.');
      process.exitCode = 1;
    }
  } catch (error) {
    if (renderInterval) stopRendering();
    console.error('\nAn error occurred:', error);
    process.exitCode = 1;
  } finally {
    console.timeEnd('Execution Time');
  }
}

// Global Error Handlers
process.on('uncaughtException', (err) => {
  console.error('[convert] Uncaught Exception:', err);
  if (process.send) process.exit(1);
});
process.on('unhandledRejection', (reason, _promise) => {
  console.error('[convert] Unhandled Rejection:', reason);
});

main();