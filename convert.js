/**
 * Robust HTML->MP4 frame encoder with Puppeteer + FFmpeg (piped).
 * SPEED PROFILE (defaults tuned for RTX 2060+):
 * - Parallel 2 (override with --parallel)
 * - 4K/60 ready (start script passes flags)
 * - NVENC (GPU) by default; falls back to CPU if NVENC missing
 * - JPEG piping (smaller frames) for faster capture/encode
 * - GPU rendering enabled with automatic fallback to --disable-gpu
 * - Deterministic export: virtual clock from page load + seeded Math.random
 *   (--seed, --legacyClock opt-out); RAF/CSS/WAAPI stepped per frame
 * - Auto-duration from document.getAnimations() when --duration is omitted
 * - Per-frame capture retry (--frameRetries) with duplicate-last-good fallback
 * - Web Audio capture (--audio): AudioContext tap -> AudioWorklet -> PCM pipe
 * - 30-minute default FFmpeg timeout; timeouts are skipped (batch continues)
 */

const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { spawn, spawnSync, execFile } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = __dirname;

function tryRequireFFmpegStatic() {
  try {
    return require('ffmpeg-static') || null;
  } catch {
    return null;
  }
}

function detectNvenc(ffmpegPath) {
  try {
    const res = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const out = (res.stdout ? String(res.stdout) : '') + (res.stderr ? String(res.stderr) : '');
    const hasH264 = /h264_nvenc/i.test(out);
    const hasHevc = /hevc_nvenc/i.test(out);
    return { hasH264, hasHevc, any: hasH264 || hasHevc, banner: out };
  } catch {
    return { hasH264: false, hasHevc: false, any: false, banner: '' };
  }
}

function detectAmdAmf(ffmpegPath) {
  try {
    const res = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const out = (res.stdout ? String(res.stdout) : '') + (res.stderr ? String(res.stderr) : '');
    const hasH264 = /h264_amf/i.test(out);
    const hasHevc = /hevc_amf/i.test(out);
    return { hasH264, hasHevc, any: hasH264 || hasHevc, banner: out };
  } catch {
    return { hasH264: false, hasHevc: false, any: false, banner: '' };
  }
}

function detectIntelQsv(ffmpegPath) {
  try {
    const res = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const out = (res.stdout ? String(res.stdout) : '') + (res.stderr ? String(res.stderr) : '');
    const hasH264 = /h264_qsv/i.test(out);
    const hasHevc = /hevc_qsv/i.test(out);
    return { hasH264, hasHevc, any: hasH264 || hasHevc, banner: out };
  } catch {
    return { hasH264: false, hasHevc: false, any: false, banner: '' };
  }
}

function detectAllGpuEncoders(ffmpegPath) {
  return {
    nvenc: detectNvenc(ffmpegPath),
    amf: detectAmdAmf(ffmpegPath),
    qsv: detectIntelQsv(ffmpegPath),
  };
}

function getBestGpuEncoder(gpuSupport = {}, preferredGpu = 'auto') {
  const none = { hasH264: false, hasHevc: false, any: false };
  const nvenc = gpuSupport.nvenc || none;
  const amf = gpuSupport.amf || none;
  const qsv = gpuSupport.qsv || none;

  if (preferredGpu === 'nvidia' || preferredGpu === 'nvenc') return nvenc.any ? { type: 'nvenc', ...nvenc } : null;
  if (preferredGpu === 'amd' || preferredGpu === 'amf') return amf.any ? { type: 'amf', ...amf } : null;
  if (preferredGpu === 'intel' || preferredGpu === 'qsv') return qsv.any ? { type: 'qsv', ...qsv } : null;
  if (preferredGpu === 'cpu') return null;

  if (nvenc.any) return { type: 'nvenc', ...nvenc };
  if (amf.any) return { type: 'amf', ...amf };
  if (qsv.any) return { type: 'qsv', ...qsv };

  return null;
}

function resolveFfmpegPathWithGpuDetection(explicitPath) {
  if (explicitPath && explicitPath.trim()) {
    const gpuSupport = detectAllGpuEncoders(explicitPath);
    return { path: explicitPath, gpuSupport };
  }

  const bundledPaths = [path.join(ROOT, 'ffmpeg.exe')];
  if (process.resourcesPath) bundledPaths.unshift(path.join(process.resourcesPath, 'ffmpeg.exe'));

  for (const p of bundledPaths) {
    if (require('fs').existsSync(p)) {
      const gpuSupport = detectAllGpuEncoders(p);
      return { path: p, gpuSupport };
    }
  }

  const systemGpuSupport = detectAllGpuEncoders('ffmpeg');
  if (systemGpuSupport.nvenc.any || systemGpuSupport.amf.any || systemGpuSupport.qsv.any) {
    return { path: 'ffmpeg', gpuSupport: systemGpuSupport };
  }

  const ffmpegStatic = tryRequireFFmpegStatic();
  if (ffmpegStatic) {
    const gpuSupport = detectAllGpuEncoders(ffmpegStatic);
    return { path: ffmpegStatic, gpuSupport };
  }

  return {
    path: 'ffmpeg',
    gpuSupport: {
      nvenc: { hasH264: false, hasHevc: false, any: false },
      amf: { hasH264: false, hasHevc: false, any: false },
      qsv: { hasH264: false, hasHevc: false, any: false },
    },
  };
}

function findPuppeteerChromium() {
  const puppeteerCache = '/home/node/.cache/puppeteer';
  if (require('fs').existsSync(puppeteerCache)) {
    try {
      const files = require('fs').readdirSync(puppeteerCache);
      for (const file of files) {
        if (!file.startsWith('chrome')) continue;
        const chromeDir = path.join(puppeteerCache, file);
        const subdirs = require('fs').readdirSync(chromeDir);
        for (const subdir of subdirs) {
          const paths = [
            path.join(chromeDir, subdir, 'chrome-linux', 'chrome'),
            path.join(chromeDir, subdir, 'chrome-linux64', 'chrome'),
          ];
          for (const chromePath of paths) {
            if (require('fs').existsSync(chromePath)) {
              console.log(`[Docker] Found Puppeteer Chromium: ${chromePath}`);
              return chromePath;
            }
          }
        }
      }
    } catch {
      return null;
    }
  }
  return null;
}

function getDefaultExecutablePath() {
  const puppeteerChrome = findPuppeteerChromium();
  if (puppeteerChrome) return puppeteerChrome;

  const bundledChrome = path.join(ROOT, 'chromium', 'chrome.exe');
  if (require('fs').existsSync(bundledChrome)) return bundledChrome;

  return undefined;
}

function getConfig(args) {
  const defaultConfig = {
    width: 3840,
    height: 2160,
    frameRate: 60,
    duration: 10,
    inputDir: path.join(ROOT, 'html_files'),
    outputDir: path.join(ROOT, 'output'),
    executablePath: getDefaultExecutablePath(),
    browser: undefined,
    headless: true,
    enableGpu: true,
    inputCodec: 'jpeg',
    jpegQuality: 85,
    seed: 1234,
    legacyClock: false,
    autoDuration: false,
    maxDuration: 60,
    frameRetries: 2,
    strictFrames: false,
    ignorePageErrors: false,
    outputSuffix: '',
    ffmpegPath: undefined,
    ffmpegTimeoutMs: 30 * 60 * 1000,
    gpu: 'auto',
    nvencPreset: 'p1',
    nvencRC: 'vbr',
    nvencCQ: 23,
    amfPreset: 'speed',
    amfRC: 'vbr',
    amfCQ: 23,
    qsvPreset: 'veryfast',
    qsvRC: 'vbr',
    qsvCQ: 23,
    cpuPreset: 'ultrafast',
    cpuCrf4k: 18,
    cpuCrf8k: 24,
    pixFmt: 'yuv420p',
    parallel: 4,
    format: 'mp4',
    audio: false,
    audioFile: null,
    audioCodec: 'aac',
    audioBitrate: '128k',
    audioSampleRate: 48000,
  };
  return { ...defaultConfig, ...args };
}

function writeWithBackpressure(stream, chunk) {
  return new Promise((resolve, reject) => {
    if (!stream || stream.destroyed || stream.writableEnded || !stream.writable) {
      return reject(new Error('FFmpeg stdin is not writable (stream ended or destroyed).'));
    }
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
      if (error) reject(error); else resolve();
    };
    const onError = (error) => finish(error);
    const onClose = () => finish(new Error('FFmpeg input pipe closed before the frame was written.'));
    stream.once('error', onError);
    stream.once('close', onClose);
    // Waiting for the write callback bounds queued data without a drain/close race.
    try { stream.write(chunk, finish); } catch (error) { finish(error); }
  });
}

function monitorFfmpegProcess(child, { timeoutMs = Infinity, onStderr, onFailure } = {}) {
  const state = { closed: false, error: null, stderr: '' };
  let timer = null;
  let settled = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const cleanup = () => { if (timer) clearTimeout(timer); timer = null; };
  const finish = () => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveDone();
  };
  const fail = (error) => {
    if (!state.error) state.error = error;
  };
  const terminate = (error) => {
    if (error) fail(error);
    if (!state.closed) {
      try { child.kill('SIGKILL'); } catch (killError) { fail(killError); }
    }
  };
  // Attach immediately after spawn: the child can fail before the first frame.
  child.on('error', (error) => { fail(error); finish(); });
  child.once('close', (code, signal) => {
    state.closed = true;
    if (code !== 0) fail(new Error(`ffmpeg exited with code ${code}${signal ? `, signal ${signal}` : ''}`));
    finish();
  });
  for (const stream of [child.stdin, child.stdio && child.stdio[3]]) {
    if (stream) stream.on('error', fail);
  }
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data) => {
      state.stderr = (state.stderr + data).slice(-65536);
      if (onStderr) onStderr(data);
    });
  }
  if (Number.isFinite(timeoutMs)) {
    timer = setTimeout(() => {
      const error = new Error(`ffmpeg process timed out after ${Math.round(timeoutMs / 1000)}s.`);
      error.code = 'ETIMEDOUT';
      terminate(error);
      if (onFailure) onFailure(error);
    }, Math.max(0, timeoutMs));
  }
  return {
    state, done, cleanup, terminate,
    async wait() {
      await done;
      if (state.error) {
        const error = new Error(state.error.message + (state.stderr ? `\n\nFFmpeg output:\n${state.stderr}` : ''));
        error.code = state.error.code;
        throw error;
      }
    },
  };
}

async function publishOutput(temporaryPath, outputPath, overwrite = false) {
  if (overwrite) {
    // Same-directory rename replaces the old file only after a successful render.
    await fs.rename(temporaryPath, outputPath);
  } else {
    // An exclusive hard link prevents a competing job from overwriting this path.
    // Both paths live on the same filesystem; cleanup removes the temporary link.
    try { await fs.link(temporaryPath, outputPath); } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`Output already exists: ${outputPath}. Choose another output directory, or use --overwrite in the CLI.`);
      throw error;
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatBar(current, total) {
  const barWidth = 30;
  const ratio = Math.max(0, Math.min(1, total ? current / total : 0));
  const filled = Math.round(ratio * barWidth);
  const empty = barWidth - filled;
  const pct = Math.round(ratio * 100);
  return `[${'#'.repeat(filled)}${'-'.repeat(empty)}] ${pct}% (${current}/${total})`;
}

function resolveFfmpegTimeoutMs({ userTimeoutMs }) {
  if (Number.isFinite(userTimeoutMs)) return userTimeoutMs < 0 ? Infinity : userTimeoutMs;
  return 30 * 60 * 1000;
}

function makeLaunchArgs({ width, height, enableGpu, audio = false, audioSampleRate = 48000, isDocker = false }) {
  const args = [
    `--window-size=${width},${height}`,
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    // file:// pages must be able to load sibling assets
    '--allow-file-access-from-files',
    '--enable-local-file-accesses',
    // Web Audio contexts must start without a user gesture or capture never begins.
    '--autoplay-policy=no-user-gesture-required',
  ];

  if (audio) {
    args.push('--audio-output-channels=2');
    args.push(`--audio-output-sample-rate=${audioSampleRate}`);
  }

  if (isDocker || process.env.API_MODE === 'true') {
    args.push('--no-sandbox');
    args.push('--disable-setuid-sandbox');
    args.push('--disable-dev-shm-usage');
    args.push('--single-process');
    args.push('--disable-crash-reporter');
    args.push('--disable-crashpad');
    args.push('--disable-breakpad');
    args.push('--disable-features=Crashpad');
    args.push('--no-zygote');
  }

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
    : ['-f', 'image2pipe', '-vcodec', 'mjpeg', '-i', 'pipe:0'];
}

function makeAudioInputArgs(config) {
  if (!config.audio) return [];
  if (config.audioFile) return ['-i', config.audioFile];

  return [
    '-f', 's16le',
    '-ar', String(config.audioSampleRate),
    '-ac', '2',
    '-i', 'pipe:3',
  ];
}

function makeAudioCodecArgs(config) {
  if (!config.audio) return [];

  if (config.audioCodec === 'opus') {
    return ['-c:a', 'libopus', '-b:a', config.audioBitrate, '-vbr', 'on', '-application', 'audio'];
  }
  if (config.audioCodec === 'pcm') {
    return ['-c:a', 'pcm_s16le'];
  }
  return ['-c:a', 'aac', '-b:a', config.audioBitrate, '-ar', String(config.audioSampleRate)];
}

// Tag streams so players interpret the mjpeg/browser pipeline's full-range
// sRGB output correctly (prevents washed-out colors in strict players).
function makeColorMetadataArgs(config = {}) {
  return [
    '-color_range', config.format === 'prores' ? 'tv' : 'pc',
    '-colorspace', 'bt709',
    '-color_primaries', 'bt709',
    '-color_trc', 'iec61966-2-1',
  ];
}

function makeVideoCodecArgs({ is8k, cfg, gpuEncoder }) {
  if (cfg.format === 'webm') {
    return ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '30', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0'];
  }
  if (cfg.format === 'prores') {
    return ['-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuv444p10le', '-q:v', '5'];
  }

  const useGpu = cfg.gpu !== 'cpu' && gpuEncoder;
  if (useGpu) {
    const args = ['-pix_fmt', cfg.pixFmt];
    const type = gpuEncoder.type;

    if (type === 'nvenc') {
      const quality = cfg.nvencRC === 'constqp' ? ['-qp', String(cfg.nvencCQ)] : ['-cq', String(cfg.nvencCQ)];
      if (is8k && gpuEncoder.hasHevc) {
        return ['-c:v', 'hevc_nvenc', '-preset', cfg.nvencPreset, '-rc', cfg.nvencRC, ...quality, ...args, '-tag:v', 'hvc1'];
      }
      if (gpuEncoder.hasH264) {
        return ['-c:v', 'h264_nvenc', '-preset', cfg.nvencPreset, '-rc', cfg.nvencRC, ...quality, ...args];
      }
    }

    if (type === 'amf') {
      if (is8k && gpuEncoder.hasHevc) {
        return ['-c:v', 'hevc_amf', '-quality', cfg.amfPreset, '-rc', cfg.amfRC, '-qp_p', String(cfg.amfCQ), '-qp_i', String(cfg.amfCQ), ...args];
      }
      if (gpuEncoder.hasH264) {
        return ['-c:v', 'h264_amf', '-quality', cfg.amfPreset, '-rc', cfg.amfRC, '-qp_p', String(cfg.amfCQ), '-qp_i', String(cfg.amfCQ), ...args];
      }
    }

    if (type === 'qsv') {
      if (is8k && gpuEncoder.hasHevc) {
        return ['-c:v', 'hevc_qsv', '-preset', cfg.qsvPreset, '-global_quality', String(cfg.qsvCQ), ...args, '-tag:v', 'hvc1'];
      }
      if (gpuEncoder.hasH264) {
        return ['-c:v', 'h264_qsv', '-preset', cfg.qsvPreset, '-global_quality', String(cfg.qsvCQ), ...args];
      }
    }

    console.warn(`[convert] ${type.toUpperCase()} requested but not available. Falling back to CPU.`);
  }

  return is8k
    ? ['-c:v', 'libx265', '-pix_fmt', cfg.pixFmt, '-preset', cfg.cpuPreset, '-crf', String(cfg.cpuCrf8k)]
    : ['-c:v', 'libx264', '-pix_fmt', cfg.pixFmt, '-preset', cfg.cpuPreset, '-crf', String(cfg.cpuCrf4k)];
}

const encoderProbeCache = new Map();
async function selectRuntimeGpuEncoder(ffmpegPath, gpuSupport, config) {
  if (config.gpu === 'cpu' || config.format !== 'mp4') return null;
  const requested = config.gpu === 'auto' ? ['nvidia', 'amd', 'intel'] : [config.gpu];
  for (const preference of requested) {
    const encoder = getBestGpuEncoder(gpuSupport, preference);
    if (!encoder) continue;
    const codecArgs = makeVideoCodecArgs({ is8k: config.width >= 7680 || config.height >= 4320, cfg: config, gpuEncoder: encoder });
    // Compiled-in NVENC/AMF/QSV does not imply that compatible hardware exists.
    // Probe one frame using the requested dimensions and codec options before capture.
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${config.width}x${config.height}:r=1`,
      '-frames:v', '1', '-an', ...codecArgs, '-f', 'null', '-'];
    const key = JSON.stringify([ffmpegPath, args]);
    if (!encoderProbeCache.has(key)) {
      encoderProbeCache.set(key, new Promise((resolve) => {
        execFile(ffmpegPath, args, { timeout: 8000, windowsHide: true, maxBuffer: 65536, signal: config.signal }, (error) => resolve(!error));
      }));
    }
    const available = await encoderProbeCache.get(key);
    config.signal?.throwIfAborted();
    if (available) return encoder;
    console.warn(`[encoder] ${encoder.type.toUpperCase()} could not encode a test frame; trying another supported encoder or CPU.`);
  }
  return null;
}

async function convertHtmlToVideo(htmlFile, config) {
  config = getConfig(config || {});
  if (typeof config.updateStatus !== 'function') config.updateStatus = () => {};
  if (config.workerId == null) config.workerId = 1;
  const cancellationError = () => {
    const error = new Error('Conversion cancelled.');
    error.code = 'ABORT_ERR';
    return error;
  };
  if (config.signal && config.signal.aborted) throw cancellationError();
  // Callers like the Electron app invoke this directly (main() never runs),
  // so ffmpeg/GPU detection must be self-serve when missing.
  if (!config._ffmpegResolved || !config._gpuSupport) {
    const { path: resolvedFfmpeg, gpuSupport } = resolveFfmpegPathWithGpuDetection(config.ffmpegPath);
    config._ffmpegResolved = resolvedFfmpeg;
    config._gpuSupport = gpuSupport;
  }

  // Callers pass either a basename + inputDir, or a full HTML path. Normalize
  // both shapes so the engine never treats a file as a directory.
  let resolvedInputDir = config.inputDir;
  let resolvedHtmlFile = htmlFile;

  if (path.isAbsolute(resolvedHtmlFile) && /\.html?$/i.test(resolvedHtmlFile)) {
    resolvedInputDir = path.dirname(resolvedHtmlFile);
    resolvedHtmlFile = path.basename(resolvedHtmlFile);
  }

  if (/\.html?$/i.test(resolvedInputDir || '')) {
    resolvedInputDir = path.dirname(resolvedInputDir);
  }

  const inputHtmlPath = path.isAbsolute(resolvedHtmlFile)
    ? resolvedHtmlFile
    : path.join(resolvedInputDir, resolvedHtmlFile);

  let inputStats;
  try {
    inputStats = await fs.stat(inputHtmlPath);
  } catch (err) {
    throw new Error(`Input HTML not found: ${inputHtmlPath} (${err.message})`);
  }
  if (!inputStats.isFile()) {
    throw new Error(`Input HTML path is not a file: ${inputHtmlPath}`);
  }

  const baseName = path.basename(resolvedHtmlFile, path.extname(resolvedHtmlFile));
  const ext = config.format === 'webm' ? '.webm' : (config.format === 'prores' ? '.mov' : '.mp4');
  const outputSuffix = config.outputSuffix || '';
  if (/[\\/]/.test(outputSuffix)) throw new Error('Output suffix must not contain path separators.');
  const outputVideoPath = path.join(config.outputDir, `${baseName}${outputSuffix}${ext}`);
  if (config.audioFile) {
    try {
      const outputReal = await fs.realpath(outputVideoPath);
      const audioReal = await fs.realpath(config.audioFile);
      const samePath = process.platform === 'win32' ? outputReal.toLowerCase() === audioReal.toLowerCase() : outputReal === audioReal;
      if (samePath) throw new Error('Output would replace its audio input. Choose another output directory.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await fs.mkdir(config.outputDir, { recursive: true });
  if (!config.overwrite) {
    try {
      await fs.lstat(outputVideoPath);
      throw new Error(`Output already exists: ${outputVideoPath}. Choose another output directory, or use --overwrite in the CLI.`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // Stage beside the destination so success can be published atomically.
  const temporaryDir = await fs.mkdtemp(path.join(config.outputDir, '.htmltomp4-'));
  const temporaryVideoPath = path.join(temporaryDir, `render${ext}`);

  // totalFrames/dtMs are resolved after page load so --duration can be
  // auto-detected from the page's animations when the user omits it.
  let totalFrames;
  let dtMs;

  let browser = config.browser;
  let page;
  let pageClosePromise;
  let browserClosePromise;
  const closePage = () => {
    if (!page) return Promise.resolve();
    if (!pageClosePromise) pageClosePromise = page.close().catch(() => {});
    return pageClosePromise;
  };
  const closeOwnedBrowser = () => {
    if (config.browser || !browser) return Promise.resolve();
    // Puppeteer's second close() can return before the first call has completed.
    // Keep one promise so cancellation and finally await the same cleanup.
    if (!browserClosePromise) browserClosePromise = browser.close().catch(() => {});
    return browserClosePromise;
  };
  let ffmpegProcess;
  let ffmpegMonitor;
  let ffmpegProgressFrame = 0;
  const pageErrors = [];
  const recordPageError = (message) => {
    if (pageErrors.length < 5) {
      pageErrors.push(String(message).slice(0, 2000));
      if (config.ignorePageErrors) console.warn(`[page] ${pageErrors[pageErrors.length - 1]}`);
    }
  };
  const checkPageErrors = () => {
    if (!config.ignorePageErrors && pageErrors.length) throw new Error(`Page error: ${pageErrors.join('; ')}. Fix the source or explicitly use --ignorePageErrors.`);
  };
  const onAbort = () => {
    if (ffmpegMonitor) ffmpegMonitor.terminate(cancellationError());
    if (page) void closePage();
    else void closeOwnedBrowser();
  };
  if (config.signal) config.signal.addEventListener('abort', onAbort, { once: true });

  let audioInitialized = false;
  let audioPullInterval = null;
  let audioBuffer = Buffer.alloc(0);
  let audioBytesWritten = 0;
  const audioBufferMaxSize = 1024 * 1024;

  const wantsAudioCapture = !!(config.audio && !config.audioFile);
  const launchArgs = makeLaunchArgs({
    width: config.width,
    height: config.height,
    enableGpu: config.enableGpu,
    audio: wantsAudioCapture,
    audioSampleRate: config.audioSampleRate,
  });

  try {
    if (!browser) {
      try {
        browser = await puppeteer.launch({
          executablePath: config.executablePath,
          headless: config.headless,
          args: launchArgs,
          // The CLI owns signal handling and must finish temporary-file cleanup.
          handleSIGINT: !config.signal,
          handleSIGTERM: !config.signal,
        });
      } catch (e) {
        if (config.signal && config.signal.aborted) throw cancellationError();
        if (config.enableGpu) {
          console.warn(`[convert] GPU launch failed ("${e.message}"). Retrying with --disable-gpu...`);
          const fallbackArgs = makeLaunchArgs({ width: config.width, height: config.height, enableGpu: false, audio: wantsAudioCapture, audioSampleRate: config.audioSampleRate });
          browser = await puppeteer.launch({
            executablePath: config.executablePath,
            headless: config.headless,
            args: fallbackArgs,
            handleSIGINT: !config.signal,
            handleSIGTERM: !config.signal,
          });
        } else {
          throw e;
        }
      }
    }

    if (config.signal && config.signal.aborted) throw cancellationError();
    page = await browser.newPage();
    if (config.signal && config.signal.aborted) throw cancellationError();
    page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
    page.on('pageerror', (error) => recordPageError(error.message));
    page.on('requestfailed', (request) => recordPageError(`Could not load ${request.resourceType()} asset (${request.failure()?.errorText || 'request failed'}). Check local paths and network access.`));
    page.on('response', (response) => {
      if (response.status() >= 400) recordPageError(`Asset returned HTTP ${response.status()}. Check source asset URLs.`);
    });
    await page.setViewport({ width: config.width, height: config.height, deviceScaleFactor: 1 });

    await page.evaluateOnNewDocument(() => {
      (function installRafShim() {
        const nativeRAF = window.requestAnimationFrame.bind(window);
        const nativeCAF = window.cancelAnimationFrame.bind(window);
        let rafQueue = new Map();
        let nextId = 1;

        function shimRAF(cb) {
          const id = nextId++;
          rafQueue.set(id, cb);
          return id;
        }

        function shimCAF(id) {
          rafQueue.delete(id);
        }

        function rafStep(time) {
          const batch = Array.from(rafQueue.entries());
          rafQueue.clear();
          for (const [, cb] of batch) {
            try {
              cb(time);
            } catch (error) {
              const errors = window.__HTV__.errors || (window.__HTV__.errors = []);
              if (errors.length < 5) errors.push(`requestAnimationFrame: ${error.message || error}`);
            }
          }
        }

        window.__HTV__ = window.__HTV__ || {};
        window.__HTV__.rafStep = rafStep;
        window.__HTV__.restoreRAF = () => {
          window.requestAnimationFrame = nativeRAF;
          window.cancelAnimationFrame = nativeCAF;
        };
        window.__HTV__.hasRafShim = true;
        window.requestAnimationFrame = shimRAF;
        window.cancelAnimationFrame = shimCAF;
      })();
    });

    // Virtual clock + seeded random (Remotion-style determinism for pages that
    // use Date.now/performance.now/setTimeout/setInterval/Math.random instead
    // of the nextFrame contract). Virtual from PAGE LOAD: page-visible time is
    // frozen at t=0 until the frame loop advances it via clockStep(), so the
    // wall-clock duration of loading/fonts/network can never leak into page
    // state (that leak is exactly what made timer-driven pages nondeterministic).
    await page.evaluateOnNewDocument((seed, legacyClock) => {
      if (!legacyClock) {
        (function installVirtualClock() {
          const nativeDateNow = Date.now.bind(Date);
          const nativeSetTimeout = window.setTimeout.bind(window);
          const nativeClearTimeout = window.clearTimeout.bind(window);
          const nativeSetInterval = window.setInterval.bind(window);
          const nativeClearInterval = window.clearInterval.bind(window);

          // epoch is the only wall-clock value pages can see, fixed at injection.
          const clock = { mode: 'virtual', vnow: 0, epoch: nativeDateNow(), perfOrigin: 0 };
          let timerId = 1000000000; // clear of native id range
          const timers = new Map();

          Date.now = () => Math.floor(clock.epoch + clock.vnow);
          performance.now = () => clock.perfOrigin + clock.vnow;

          window.setTimeout = function (cb, delay, ...args) {
            if (typeof cb !== 'function') return nativeSetTimeout(cb, delay, ...args);
            const id = timerId++;
            // 1ms floor prevents zero-delay chains from livelocking a frame step
            timers.set(id, { due: clock.vnow + Math.max(1, Number(delay) || 0), cb, args, interval: 0 });
            return id;
          };
          window.setInterval = function (cb, delay, ...args) {
            if (typeof cb !== 'function') return nativeSetInterval(cb, delay, ...args);
            const step = Math.max(1, Number(delay) || 0);
            const id = timerId++;
            timers.set(id, { due: clock.vnow + step, cb, args, interval: step });
            return id;
          };
          window.clearTimeout = function (id) {
            if (!timers.delete(id)) nativeClearTimeout(id);
          };
          window.clearInterval = function (id) {
            if (!timers.delete(id)) nativeClearInterval(id);
          };

          function clockStep(tMs) {
            if (clock.mode !== 'virtual') return;
            let guard = 100000;
            while (guard-- > 0) {
              let nextId = null;
              let nextDue = Infinity;
              for (const [id, tm] of timers) {
                if (tm.due <= tMs && tm.due < nextDue) { nextDue = tm.due; nextId = id; }
              }
              if (nextId === null) break;
              const tm = timers.get(nextId);
              clock.vnow = tm.due;
              if (tm.interval) tm.due += tm.interval; else timers.delete(nextId);
              try { tm.cb.apply(window, tm.args); } catch (error) {
                const errors = window.__HTV__.errors || (window.__HTV__.errors = []);
                if (errors.length < 5) errors.push(`Timer: ${error.message || error}`);
              }
            }
            clock.vnow = tMs;
          }

          window.__HTV__ = window.__HTV__ || {};
          window.__HTV__.clock = clock;
          window.__HTV__.clockStep = clockStep;
          // Kept for call-site compatibility; time has been virtual since load.
          window.__HTV__.beginVirtualTime = () => {};
        })();
      }

      (function installSeededRandom() {
        // mulberry32 — deterministic from page load so load-time randomness repeats too
        let s = (seed >>> 0) || 1;
        Math.random = function () {
          s |= 0; s = (s + 0x6D2B79F5) | 0;
          let t2 = Math.imul(s ^ (s >>> 15), 1 | s);
          t2 = (t2 + Math.imul(t2 ^ (t2 >>> 7), 61 | t2)) ^ t2;
          return ((t2 ^ (t2 >>> 14)) >>> 0) / 4294967296;
        };
      })();
    }, config.seed, config.legacyClock);

    // Audio capture must be installed before page scripts run: pages create
    // their own AudioContext, so we patch the constructor and shadow each
    // context's `destination` with a capture tap. Anything the page routes to
    // "the speakers" flows through the tap into an AudioWorklet (or
    // ScriptProcessor fallback) that hands PCM back to Node via __HTV_AUDIO__.
    if (wantsAudioCapture) {
      await page.evaluateOnNewDocument((sampleRate) => {
        const state = {
          audioData: [],
          recording: false,
          sampleRate,
          channels: 2,
          contexts: 0,
          captureMode: null,
        };
        window.__HTV_AUDIO__ = state;

        const NativeAC = window.AudioContext || window.webkitAudioContext;
        if (!NativeAC) return;

        const WORKLET_SRC = `class HtvCapture extends AudioWorkletProcessor{
          process(inputs){const inp=inputs[0];
            if(inp&&inp[0]&&inp[0].length){const L=inp[0],R=inp[1]||inp[0];
              const out=new Int16Array(L.length*2);
              for(let i=0;i<L.length;i++){
                out[i*2]=Math.max(-32768,Math.min(32767,Math.round(L[i]*32767)));
                out[i*2+1]=Math.max(-32768,Math.min(32767,Math.round(R[i]*32767)));}
              this.port.postMessage(out,[out.buffer]);}
            return true;}}
        registerProcessor('htv-capture',HtvCapture);`;

        function pushChunk(int16) {
          if (state.recording) state.audioData.push(int16);
        }

        function attachScriptProcessor(ctx, tap, realDest) {
          const proc = ctx.createScriptProcessor(4096, 2, 2);
          proc.onaudioprocess = (e) => {
            const L = e.inputBuffer.getChannelData(0);
            const R = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : L;
            const out = new Int16Array(L.length * 2);
            for (let i = 0; i < L.length; i++) {
              out[i * 2] = Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767)));
              out[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767)));
            }
            pushChunk(out);
          };
          const mute = ctx.createGain();
          mute.gain.value = 0;
          tap.connect(proc);
          proc.connect(mute);
          mute.connect(realDest);
          state.captureMode = 'scriptprocessor';
        }

        async function attachWorklet(ctx, tap, realDest) {
          const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
          await ctx.audioWorklet.addModule(url);
          const node = new AudioWorkletNode(ctx, 'htv-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
          node.port.onmessage = (e) => pushChunk(new Int16Array(e.data));
          const mute = ctx.createGain();
          mute.gain.value = 0;
          tap.connect(node);
          node.connect(mute);
          mute.connect(realDest);
          state.captureMode = 'worklet';
        }

        function hookContext(ctx) {
          try {
            const realDest = ctx.destination;
            const tap = ctx.createGain();
            tap.connect(realDest);
            Object.defineProperty(ctx, 'destination', { get: () => tap, configurable: true });
            state.contexts++;
            state.sampleRate = ctx.sampleRate;
            if (ctx.audioWorklet) {
              attachWorklet(ctx, tap, realDest).catch(() => {
                try { attachScriptProcessor(ctx, tap, realDest); } catch { /* leave this context uncaptured */ }
              });
            } else {
              try { attachScriptProcessor(ctx, tap, realDest); } catch { /* leave this context uncaptured */ }
            }
            if (ctx.state !== 'running' && ctx.resume) {
              const p = ctx.resume();
              if (p && p.catch) p.catch(() => {});
            }
          } catch { /* capture must never break page audio */ }
        }

        const PatchedAC = function AudioContext(...ctorArgs) {
          const ctx = new NativeAC(...ctorArgs);
          hookContext(ctx);
          return ctx;
        };
        PatchedAC.prototype = NativeAC.prototype;
        window.AudioContext = PatchedAC;
        if (window.webkitAudioContext) window.webkitAudioContext = PatchedAC;

        // Route new Audio()/<audio> element playback through a hooked shared
        // context so element audio is captured too.
        let sharedCtx = null;
        const NativeAudio = window.Audio;
        if (NativeAudio) {
          window.Audio = function Audio(...ctorArgs) {
            const el = new NativeAudio(...ctorArgs);
            el.addEventListener('play', () => {
              try {
                if (!el.__htvCaptured) {
                  if (!sharedCtx) sharedCtx = new PatchedAC({ sampleRate });
                  const src = sharedCtx.createMediaElementSource(el);
                  src.connect(sharedCtx.destination);
                  el.__htvCaptured = true;
                }
              } catch { /* best effort */ }
            });
            return el;
          };
          window.Audio.prototype = NativeAudio.prototype;
        }
      }, config.audioSampleRate);
    }

    const fileUrl = pathToFileURL(inputHtmlPath).href;
    await page.goto(fileUrl, { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForNetworkIdle({ idleTime: 250, timeout: 5000 });
    } catch {
      // Ignore network-idle timeouts for self-contained files.
    }

    await page.evaluate(async () => {
      if (document.fonts && document.fonts.status !== 'loaded') {
        try {
          await document.fonts.ready;
        } catch {
          // Ignore font readiness failures.
        }
      }

      const images = Array.from(document.images || []);
      await Promise.all(images.map((img) => img.decode?.().catch(() => {})));
    });

    let durationSec = config.duration;
    if (config.autoDuration) {
      const timing = await page.evaluate(() => {
        const anims = document.getAnimations({ subtree: true }) || [];
        let maxEndMs = 0;
        let infiniteCycleMs = 0;
        let infinite = 0;
        for (const a of anims) {
          let t = {};
          try { t = a.effect?.getTiming?.() || {}; } catch { /* ignore unreadable timings */ }
          const delay = Number(t.delay) || 0;
          const endDelay = Number(t.endDelay) || 0;
          const dur = typeof t.duration === 'number' ? t.duration : 0;
          const iter = t.iterations == null ? 1 : t.iterations;
          if (!Number.isFinite(iter)) {
            infinite++;
            infiniteCycleMs = Math.max(infiniteCycleMs, delay + dur + endDelay);
          } else {
            maxEndMs = Math.max(maxEndMs, delay + dur * iter + endDelay);
          }
        }
        return { count: anims.length, maxEndMs, infiniteCycleMs, infinite };
      });

      let pickSec = 0;
      let why = '';
      if (timing.maxEndMs > 0) {
        pickSec = timing.maxEndMs / 1000;
        why = `longest finite animation ends at ${pickSec.toFixed(2)}s`;
      }
      if (timing.infinite > 0) {
        const cycleSec = timing.infiniteCycleMs / 1000;
        if (cycleSec > pickSec) {
          pickSec = cycleSec;
          why = `${timing.infinite} infinite animation(s) — rendering one cycle`;
        }
        console.warn(`[auto-duration] ${baseName}: ${timing.infinite} animation(s) run forever; pass --duration for a specific length.`);
      }
      if (pickSec <= 0) {
        pickSec = 10;
        why = 'no animations detected — using default 10s';
      }
      const maxDuration = Number.isFinite(config.maxDuration) && config.maxDuration > 0 ? config.maxDuration : 60;
      if (pickSec > maxDuration) {
        console.warn(`[auto-duration] ${baseName}: detected ${pickSec.toFixed(2)}s, capping at --maxDuration=${maxDuration}s.`);
        pickSec = maxDuration;
      }
      // round UP to a whole frame so animations complete
      durationSec = Math.ceil(Math.max(pickSec, 1 / config.frameRate) * config.frameRate) / config.frameRate;
      console.log(`[auto-duration] ${baseName}: using ${durationSec.toFixed(2)}s (${why})`);
    }

    totalFrames = Math.max(1, Math.round(durationSec * config.frameRate));
    dtMs = 1000 / config.frameRate;

    await page.evaluate((fps) => {
      const anims = document.getAnimations({ subtree: true }) || [];
      const meta = anims.map((a) => {
        try {
          a.pause();
        } catch {
          // Ignore animation pause failures.
        }
        let delay = 0;
        try {
          delay = a.effect?.getTiming?.().delay || 0;
        } catch {
          // Ignore timing lookup errors.
        }
        return { delay };
      });

      window.__HTV__ = Object.assign(window.__HTV__ || {}, { exporting: true, fps, anims, meta, totalDurationMs: 0 });
      for (const svg of document.querySelectorAll('svg')) {
        if (typeof svg.pauseAnimations === 'function') svg.pauseAnimations();
      }
      if (window.__HTV__.beginVirtualTime) window.__HTV__.beginVirtualTime();
    }, config.frameRate);

    const hasNextFrame = await page.evaluate(() => typeof window.nextFrame === 'function');
    await page.evaluate((totalMs) => {
      if (window.__HTV__) window.__HTV__.totalDurationMs = totalMs;
    }, totalFrames * dtMs);

    if (wantsAudioCapture) {
      audioInitialized = await page.evaluate(() => {
        if (!window.__HTV_AUDIO__) return false;
        window.__HTV_AUDIO__.recording = true;
        return true;
      });

      if (!audioInitialized) {
        console.warn('[Audio] Web Audio unavailable in page; the audio track will be silent.');
      } else {
        audioPullInterval = setInterval(async () => {
          try {
            const pcmChunks = await page.evaluate(() => {
              if (!window.__HTV_AUDIO__) return [];
              const chunks = window.__HTV_AUDIO__.audioData;
              window.__HTV_AUDIO__.audioData = [];
              return chunks.map((c) => Array.from(c));
            });

            for (const chunk of pcmChunks) {
              const buf = Buffer.from(new Int16Array(chunk).buffer);
              audioBuffer = Buffer.concat([audioBuffer, buf]);
            }

            if (audioBuffer.length >= audioBufferMaxSize && ffmpegProcess && ffmpegProcess.stdio[3] && !ffmpegProcess.stdio[3].destroyed) {
              const toWrite = audioBuffer;
              audioBuffer = Buffer.alloc(0);
              try {
                audioBytesWritten += toWrite.length;
                ffmpegProcess.stdio[3].write(toWrite);
              } catch {
                // Ignore late audio pipe writes.
              }
            }
          } catch {
            // Page may have closed; audio capture is best effort.
          }
        }, 100);
      }
    }

    const is8k = (config.width >= 7680 || config.height >= 4320);
    checkPageErrors();
    const inputFmtArgs = makeInputPipeArgs(config.inputCodec);
    const gpuEncoder = await selectRuntimeGpuEncoder(config._ffmpegResolved || 'ffmpeg', config._gpuSupport || {}, config);
    console.log(`[encoder] ${baseName}: ${gpuEncoder ? gpuEncoder.type.toUpperCase() : 'CPU'} (${config.format})`);
    const videoCodecArgs = makeVideoCodecArgs({ is8k, cfg: config, gpuEncoder });
    const audioInputArgs = makeAudioInputArgs(config);
    const audioCodecArgs = makeAudioCodecArgs(config);
    const colorMetadataArgs = makeColorMetadataArgs(config);
    const colorRange = config.format === 'prores' ? 'limited' : 'full';

    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel', 'error',
      '-progress', 'pipe:2',
      '-framerate', String(config.frameRate),
      ...inputFmtArgs,
      ...audioInputArgs,
      '-map', '0:v:0',
      ...(config.audio ? ['-map', '1:a:0'] : []),
      ...videoCodecArgs,
      // Convert YUV matrices explicitly, then set per-frame metadata as well as
      // encoder metadata. MJPEG frames otherwise overwrite primaries/transfer.
      '-vf', `scale=out_color_matrix=bt709:out_range=${colorRange},setparams=range=${colorRange}:color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709`,
      ...colorMetadataArgs,
      ...audioCodecArgs,
      // A short soundtrack must not truncate the requested video duration.
      ...(config.audioFile && config.audio ? ['-af', 'apad'] : []),
      ...(config.audio ? ['-t', String(totalFrames / config.frameRate)] : []),
      ...(config.format !== 'webm' ? ['-movflags', '+faststart'] : []),
      '-r', String(config.frameRate),
      '-frames:v', String(totalFrames),
      '-n', temporaryVideoPath,
    ];

    const ffmpegPath = config._ffmpegResolved || 'ffmpeg';
    const useAudioPipe = config.audio && !config.audioFile;
    const stdioConfig = useAudioPipe ? ['pipe', 'ignore', 'pipe', 'pipe'] : ['pipe', 'ignore', 'pipe'];

    ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, { stdio: stdioConfig, windowsHide: true });
    ffmpegMonitor = monitorFfmpegProcess(ffmpegProcess, {
      timeoutMs: resolveFfmpegTimeoutMs({ userTimeoutMs: config.ffmpegTimeoutMs }),
      onFailure: () => { void closePage(); },
      onStderr: (data) => {
        const lines = String(data).split(/\r?\n/);
        for (const line of lines) {
          if (!line.startsWith('frame=')) continue;
          const n = parseInt(line.slice(6).trim(), 10);
          if (Number.isNaN(n)) continue;
          ffmpegProgressFrame = Math.max(ffmpegProgressFrame, n);
          const bar = formatBar(Math.min(ffmpegProgressFrame, totalFrames), totalFrames);
          config.updateStatus(config.workerId, `[Worker ${config.workerId}] Starting: ${baseName}.html Encoding ${bar}`);
        }
      },
    });

    let lastGoodFrame = null;
    let reusedFrames = 0;

    for (let i = 0; i < totalFrames; i++) {
      checkPageErrors();
      if (config.signal && config.signal.aborted) throw cancellationError();
      const { closed: ffmpegClosed, error: ffmpegError, stderr: ffmpegStderrOutput } = ffmpegMonitor.state;
      if (ffmpegClosed || ffmpegError || !ffmpegProcess.stdin || ffmpegProcess.stdin.destroyed || ffmpegProcess.stdin.writableEnded) {
        throw new Error(
          `FFmpeg ended early at input frame ${i}.` +
          (ffmpegError ? `\n\nReason: ${ffmpegError.message}` : '') +
          (ffmpegStderrOutput ? `\n\nFFmpeg output:\n${ffmpegStderrOutput}` : '')
        );
      }

      const t = i * dtMs;
      const progress = totalFrames > 1 ? i / (totalFrames - 1) : 1;

      const frameErrors = await page.evaluate(async ({ time, dt, useNextFrame, progress }) => {
        if (window.__HTV__ && typeof window.__HTV__.clockStep === 'function') {
          window.__HTV__.clockStep(time);
        }

        let anims = (window.__HTV__ && window.__HTV__.anims) || [];
        if (!anims.length) {
          anims = document.getAnimations({ subtree: true }) || [];
          window.__HTV__ = window.__HTV__ || {};
          window.__HTV__.anims = anims;
          window.__HTV__.meta = anims.map((a) => {
            try {
              a.pause();
            } catch {
              // Ignore animation pause failures.
            }
            let delay = 0;
            try {
              delay = a.effect?.getTiming?.().delay || 0;
            } catch {
              // Ignore timing lookup errors.
            }
            return { delay };
          });
        }

        const meta = (window.__HTV__ && window.__HTV__.meta) || [];
        for (let k = 0; k < anims.length; k++) {
          const a = anims[k];
          if (a.playState !== 'paused') {
            try {
              a.pause();
            } catch {
              // Ignore pause failures.
            }
          }
          try {
            // Animation.currentTime already includes the effect's delay.
            a.currentTime = time;
          } catch {
            // Ignore timeline write failures.
          }
        }

        for (const svg of document.querySelectorAll('svg')) {
          if (typeof svg.pauseAnimations === 'function') svg.pauseAnimations();
          if (typeof svg.setCurrentTime === 'function') svg.setCurrentTime(time / 1000);
        }

        if (window.__HTV__ && typeof window.__HTV__.rafStep === 'function') {
          window.__HTV__.rafStep(time);
        }

        if (useNextFrame && typeof window.nextFrame === 'function') {
          const total = (window.__HTV__ && window.__HTV__.totalDurationMs) || 1;
          const payload = { time, delta: dt, progress: Math.max(0, Math.min(1, progress || (time / total))) };
          try {
            await window.nextFrame(payload);
          } catch (error) {
            const errors = window.__HTV__.errors || (window.__HTV__.errors = []);
            if (errors.length < 5) errors.push(`nextFrame: ${error.message || error}`);
          }
        }

        void document.body.offsetWidth;
        return (window.__HTV__?.errors || []).splice(0, 5);
      }, { time: t, dt: dtMs, useNextFrame: hasNextFrame, progress });
      for (const error of frameErrors || []) recordPageError(error);
      checkPageErrors();

      const shotOpts = String(config.inputCodec).toLowerCase() === 'png'
        ? { type: 'png' }
        : { type: 'jpeg', quality: config.jpegQuality };

      // Per-frame retry: transient capture hiccups must not kill the render.
      // After all retries, reuse the last good frame (unless --strictFrames)
      // so one bad frame costs a duplicate, not the whole video.
      const maxAttempts = Math.max(1, (Number(config.frameRetries) || 0) + 1);
      let frameBuffer = null;
      let lastShotErr = null;
      for (let attempt = 1; attempt <= maxAttempts && !frameBuffer; attempt++) {
        try {
          frameBuffer = await page.screenshot(shotOpts);
        } catch (shotErr) {
          lastShotErr = shotErr;
          if (attempt < maxAttempts) await sleep(150 * attempt);
        }
      }
      if (!frameBuffer) {
        if (lastGoodFrame && !config.strictFrames) {
          reusedFrames++;
          console.warn(`[convert] ${baseName}: capture failed at frame ${i} after ${maxAttempts} attempt(s) (${lastShotErr.message}); reusing previous frame.`);
          frameBuffer = lastGoodFrame;
        } else {
          throw new Error(`Capture failed at frame ${i} after ${maxAttempts} attempt(s): ${lastShotErr.message}`);
        }
      } else {
        lastGoodFrame = frameBuffer;
      }

      try {
        await writeWithBackpressure(ffmpegProcess.stdin, frameBuffer);
      } catch (writeErr) {
        const ffmpegStderrOutput = ffmpegMonitor.state.stderr;
        throw new Error(`Failed to write frame ${i} to ffmpeg: ${writeErr.message}` + (ffmpegStderrOutput ? `\n\nFFmpeg output:\n${ffmpegStderrOutput}` : ''));
      }

      if (config.audio && audioBuffer.length > 0 && ffmpegProcess && ffmpegProcess.stdio[3] && !ffmpegProcess.stdio[3].destroyed) {
        const toWrite = audioBuffer;
        audioBuffer = Buffer.alloc(0);
        try {
          audioBytesWritten += toWrite.length;
          ffmpegProcess.stdio[3].write(toWrite);
        } catch {
          // Ignore late audio writes when ffmpeg is shutting down.
        }
      }

      const bar = formatBar(i + 1, totalFrames);
      config.updateStatus(config.workerId, `[Worker ${config.workerId}] Starting: ${baseName}.html Capturing ${bar}`);
    }

    if (reusedFrames > 0) {
      console.warn(`[convert] ${baseName}: ${reusedFrames}/${totalFrames} frame(s) were duplicated after capture failures.`);
    }

    if (ffmpegProcess && ffmpegProcess.stdin && !ffmpegProcess.stdin.destroyed) {
      ffmpegProcess.stdin.end();
    }

    if (wantsAudioCapture) {
      if (audioPullInterval) {
        clearInterval(audioPullInterval);
        audioPullInterval = null;
      }

      try {
        const finalChunks = await page.evaluate(() => {
          if (!window.__HTV_AUDIO__) return [];
          window.__HTV_AUDIO__.recording = false;
          const chunks = window.__HTV_AUDIO__.audioData;
          window.__HTV_AUDIO__.audioData = [];
          return chunks.map((c) => Array.from(c));
        });
        for (const chunk of finalChunks) {
          audioBuffer = Buffer.concat([audioBuffer, Buffer.from(new Int16Array(chunk).buffer)]);
        }
      } catch {
        // Ignore page shutdown errors.
      }

      // Pad with silence to exactly the video duration: -shortest must never
      // truncate video because capture underran (or the page produced no audio).
      const bytesPerSample = 2 * 2; // 16-bit stereo
      const expectedBytes = Math.ceil((totalFrames * dtMs / 1000) * config.audioSampleRate) * bytesPerSample;
      const shortfall = expectedBytes - audioBytesWritten - audioBuffer.length;
      if (shortfall > 0) {
        audioBuffer = Buffer.concat([audioBuffer, Buffer.alloc(shortfall)]);
      }

      if (audioBuffer.length > 0 && ffmpegProcess && ffmpegProcess.stdio[3] && !ffmpegProcess.stdio[3].destroyed) {
        try {
          audioBytesWritten += audioBuffer.length;
          ffmpegProcess.stdio[3].end(audioBuffer);
        } catch {
          try {
            ffmpegProcess.stdio[3].end();
          } catch {
            // Ignore audio pipe teardown failures.
          }
        }
      } else if (ffmpegProcess && ffmpegProcess.stdio[3]) {
        try {
          ffmpegProcess.stdio[3].end();
        } catch {
          // Ignore audio pipe teardown failures.
        }
      }
    }

    await ffmpegMonitor.wait();
    checkPageErrors();
    if (config.signal && config.signal.aborted) throw cancellationError();
    const renderedStats = await fs.stat(temporaryVideoPath);
    if (!renderedStats.isFile() || renderedStats.size === 0) throw new Error('FFmpeg produced no video output.');
    if (config.signal && config.signal.aborted) throw cancellationError();
    await publishOutput(temporaryVideoPath, outputVideoPath, !!config.overwrite);
    return outputVideoPath;
  } catch (error) {
    if (ffmpegMonitor) {
      ffmpegMonitor.terminate();
      await ffmpegMonitor.done;
      if (ffmpegMonitor.state.error && ffmpegMonitor.state.error.code === 'ETIMEDOUT') throw ffmpegMonitor.state.error;
    }
    if (config.signal && config.signal.aborted) throw cancellationError();
    throw error;
  } finally {
    if (ffmpegMonitor) ffmpegMonitor.cleanup();
    if (config.signal) config.signal.removeEventListener('abort', onAbort);
    if (audioPullInterval) clearInterval(audioPullInterval);
    await closePage();
    await closeOwnedBrowser();
    try {
      await fs.rm(temporaryDir, { recursive: true, force: true });
    } catch {
      // Ignore temp-dir cleanup failures.
    }
  }
}

// Keep the original programmatic entry point and `node convert.js` command.
async function main(args) {
  return require('./cli').main(args);
}

module.exports = {
  main,
  convertHtmlToVideo,
  getConfig,
  makeLaunchArgs,
  resolveFfmpegPathWithGpuDetection,
  getBestGpuEncoder,
  detectAllGpuEncoders,
  monitorFfmpegProcess,
  writeWithBackpressure,
  publishOutput,
  makeVideoCodecArgs,
  makeColorMetadataArgs,
  selectRuntimeGpuEncoder,
};

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`htmltomp4: ${error.message}`);
    process.exitCode = 1;
  });
}
