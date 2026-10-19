#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yargs = require('yargs');
const { getConfig, convertHtmlToVideo, resolveFfmpegPathWithGpuDetection } = require('./convert');

class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError'; }
}

function parseArgs(args) {
  const options = {
    width: { type: 'number', default: 1920, describe: 'Output width in pixels' },
    height: { type: 'number', default: 1080, describe: 'Output height in pixels' },
    frameRate: { type: 'number', alias: 'fps', default: 30 },
    duration: { type: 'number', describe: 'Seconds to render; omit to detect animation duration' },
    maxDuration: { type: 'number', default: 60, describe: 'Maximum auto-detected duration; explicit --duration is not capped' },
    inputDir: { type: 'string', describe: 'Read HTML files directly inside this directory' },
    outputDir: { type: 'string', default: path.resolve('output'), describe: 'Output directory (default: ./output)' },
    overwrite: { type: 'boolean', default: false, describe: 'Replace existing videos only after a successful render' },
    parallel: { type: 'number', alias: 'p', default: 1 },
    executablePath: { type: 'string', describe: 'Chrome/Chromium executable' },
    ffmpegPath: { type: 'string', describe: 'FFmpeg executable or command name' },
    ffmpegTimeoutSec: { type: 'number', default: 1800, describe: 'Per-file deadline, including page loading; -1 disables it' },
    headless: { type: 'boolean', default: true },
    enableGpu: { type: 'boolean', default: true, describe: 'Enable browser GPU rendering (separate from video encoding)' },
    gpu: { type: 'string', choices: ['auto', 'nvidia', 'amd', 'intel', 'cpu'], default: 'auto' },
    inputCodec: { type: 'string', choices: ['png', 'jpeg'], default: 'jpeg' },
    jpegQuality: { type: 'number', default: 85 },
    seed: { type: 'number', default: 1234 },
    legacyClock: { type: 'boolean', default: false },
    frameRetries: { type: 'number', default: 2 },
    strictFrames: { type: 'boolean', default: false, describe: 'Fail instead of duplicating a frame when capture retries fail' },
    ignorePageErrors: { type: 'boolean', default: false, describe: 'Allow rendering despite page script or asset errors (errors are still reported)' },
    format: { type: 'string', choices: ['mp4', 'webm', 'prores'], default: 'mp4' },
    pixFmt: { type: 'string', choices: ['yuv420p', 'yuv422p', 'yuv444p'], default: 'yuv420p' },
    nvencPreset: { type: 'string', choices: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'], default: 'p1' },
    nvencRC: { type: 'string', choices: ['vbr', 'cbr', 'constqp'], default: 'vbr' },
    nvencCQ: { type: 'number', default: 23 },
    amfPreset: { type: 'string', choices: ['speed', 'balanced', 'quality'], default: 'speed' },
    amfRC: { type: 'string', choices: ['vbr', 'cbr', 'cqp'], default: 'vbr' },
    amfCQ: { type: 'number', default: 23 },
    qsvPreset: { type: 'string', choices: ['veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'], default: 'veryfast' },
    qsvRC: { type: 'string', choices: ['vbr', 'cbr', 'cqp'], default: 'vbr' },
    qsvCQ: { type: 'number', default: 23 },
    cpuPreset: { type: 'string', choices: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'], default: 'ultrafast' },
    cpuCrf4k: { type: 'number', default: 18 },
    cpuCrf8k: { type: 'number', default: 24 },
    audio: { type: 'boolean', describe: 'Experimental live page audio; prefer --audioFile for reliable timing' },
    audioFile: { type: 'string' },
    audioCodec: { type: 'string', choices: ['aac', 'opus', 'pcm'], describe: 'Default: AAC for MP4, Opus for WebM, PCM for ProRes' },
    audioBitrate: { type: 'string', default: '128k' },
    audioSampleRate: { type: 'number', default: 48000 },
  };
  return yargs(args)
    .scriptName('htmltomp4')
    .usage('$0 <file.html|directory> [more inputs...] [options]')
    .example('$0 animation.html --duration 5 --gpu cpu', 'Render a five-second MP4')
    .example('$0 --inputDir ./animations --outputDir ./videos', 'Render a directory, non-recursively')
    .parserConfiguration({ 'parse-positional-numbers': false, 'duplicate-arguments-array': false })
    .options(options)
    .strictOptions()
    .exitProcess(false)
    .showHelpOnFail(false)
    .fail((message, error) => { throw new UsageError(message || error?.message || 'Invalid arguments'); })
    .help().alias('h', 'help')
    .version(require('./package.json').version)
    .parse();
}

function validateOptions(argv) {
  function number(key, min, max, integer = false) {
    const value = argv[key];
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      throw new UsageError(`--${key} must be ${integer ? 'an integer' : 'a finite number'} from ${min} to ${max}.`);
    }
  }
  number('width', 2, 8192, true);
  number('height', 2, 8192, true);
  number('frameRate', 1, 240);
  number('parallel', 1, 16, true);
  number('jpegQuality', 1, 100, true);
  number('frameRetries', 0, 10, true);
  number('seed', 0, 0xffffffff, true);
  for (const key of ['nvencCQ', 'amfCQ', 'qsvCQ', 'cpuCrf4k', 'cpuCrf8k']) number(key, 0, 51, true);
  for (const key of ['duration', 'maxDuration']) {
    if (key === 'duration' && argv[key] === undefined) continue;
    if (!Number.isFinite(argv[key]) || argv[key] <= 0 || !Number.isSafeInteger(Math.ceil(argv[key] * argv.frameRate))) {
      throw new UsageError(`--${key} must be positive and produce a safe finite frame count.`);
    }
  }
  if (argv.ffmpegTimeoutSec !== -1 && (!Number.isFinite(argv.ffmpegTimeoutSec) || argv.ffmpegTimeoutSec <= 0 || argv.ffmpegTimeoutSec * 1000 > 2147483647)) {
    throw new UsageError('--ffmpegTimeoutSec must be positive and at most 2147483 seconds, or -1 to disable.');
  }
  if (!/^[1-9]\d*(?:\.\d+)?[kKmM]?$/.test(argv.audioBitrate)) throw new UsageError('--audioBitrate must be a positive bitrate such as 128k.');
  number('audioSampleRate', 8000, 192000, true);
  for (const key of ['inputDir', 'outputDir', 'executablePath', 'ffmpegPath', 'audioFile']) {
    if (argv[key] !== undefined && (!argv[key].trim() || argv[key].includes('\0'))) throw new UsageError(`--${key} must be a nonempty path.`);
  }
  if (argv.inputDir !== undefined && argv._.length) throw new UsageError('Use positional inputs or --inputDir, not both.');
  if (argv.audioFile && argv.audio === false) throw new UsageError('--audioFile cannot be combined with --no-audio.');
  const audio = Boolean(argv.audio || argv.audioFile);
  const audioCodec = argv.audioCodec || ({ mp4: 'aac', webm: 'opus', prores: 'pcm' })[argv.format];
  if (audio && ((argv.format === 'webm' && audioCodec !== 'opus') || (argv.format === 'mp4' && audioCodec !== 'aac') || (argv.format === 'prores' && audioCodec === 'opus'))) {
    throw new UsageError(`--audioCodec ${audioCodec} is incompatible with --format ${argv.format}; use ${argv.format === 'webm' ? 'opus' : argv.format === 'prores' ? 'pcm or aac' : 'aac'}.`);
  }
  // 4:2:0 needs even width/height; 4:2:2 needs even width. VP9 uses 4:2:0.
  const pixelFormat = argv.format === 'webm' ? 'yuv420p' : argv.format === 'prores' ? 'yuv444p' : argv.pixFmt;
  if (((pixelFormat === 'yuv420p' || pixelFormat === 'yuv422p') && argv.width % 2) || (pixelFormat === 'yuv420p' && argv.height % 2)) {
    throw new UsageError(`Dimensions must be divisible by 2 for ${pixelFormat}${pixelFormat === 'yuv422p' ? ' (width)' : ''}.`);
  }
  return getConfig({ ...argv, audio, audioCodec, outputDir: path.resolve(argv.outputDir), autoDuration: argv.duration === undefined,
    duration: argv.duration === undefined ? 10 : argv.duration, ffmpegTimeoutMs: argv.ffmpegTimeoutSec * 1000 });
}

async function collectInputs(argv, config) {
  const inputs = argv.inputDir !== undefined ? [argv.inputDir] : argv._.map(String);
  if (!inputs.length) throw new UsageError('Provide an HTML file or directory. Run htmltomp4 --help for examples.');
  const files = [];
  const seen = new Set();
  const keyFor = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  async function addFile(file) {
    if (!/\.html?$/i.test(file)) throw new UsageError(`Unsupported input: ${file}. Expected .html or .htm.`);
    const absolute = path.resolve(file);
    const real = await fs.realpath(absolute);
    if (!seen.has(keyFor(real))) { seen.add(keyFor(real)); files.push(absolute); }
  }
  for (const input of inputs) {
    if (!input.trim() || input.includes('\0')) throw new UsageError('Input paths must be nonempty.');
    let stat;
    try { stat = await fs.stat(input); } catch { throw new UsageError(`Input not found or inaccessible: ${input}`); }
    if (stat.isDirectory()) {
      const entries = await fs.readdir(input, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isFile() && /\.html?$/i.test(entry.name)) await addFile(path.join(input, entry.name));
      }
    } else if (stat.isFile()) await addFile(input);
    else throw new UsageError(`Input is not a regular file or directory: ${input}`);
  }
  if (!files.length) throw new UsageError('No .html or .htm files found. Directory scanning is non-recursive.');
  if (config.audioFile) {
    try { if (!(await fs.stat(config.audioFile)).isFile()) throw new Error('not a file'); }
    catch { throw new UsageError(`Audio file not found or inaccessible: ${config.audioFile}`); }
    config.audioFile = path.resolve(config.audioFile);
  }
  const destinations = new Map();
  const extension = ({ mp4: '.mp4', webm: '.webm', prores: '.mov' })[config.format];
  for (const file of files) {
    const output = path.join(config.outputDir, path.basename(file, path.extname(file)) + extension);
    const key = keyFor(output);
    if (destinations.has(key)) throw new UsageError(`Output name collision: ${destinations.get(key)} and ${file} both produce ${output}. Rename an input or render into separate output directories.`);
    destinations.set(key, file);
    try {
      const stat = await fs.lstat(output);
      if (config.audioFile && keyFor(await fs.realpath(output)) === keyFor(await fs.realpath(config.audioFile))) throw new UsageError(`Output would replace its audio input: ${output}. Choose another output directory.`);
      if (!config.overwrite || !stat.isFile() || stat.isSymbolicLink()) throw new UsageError(`Output already exists: ${output}. Choose another directory${stat.isFile() && !stat.isSymbolicLink() ? ' or use --overwrite' : ''}.`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return files;
}

async function main(args = process.argv.slice(2)) {
  let interrupted = 0;
  const active = new Set();
  const interrupt = (signal) => {
    interrupted = signal === 'SIGTERM' ? 143 : 130;
    for (const controller of active) controller.abort(new Error(`Cancelled by ${signal}.`));
  };
  const onInt = () => interrupt('SIGINT');
  const onTerm = () => interrupt('SIGTERM');
  let listening = false;
  try {
    const argv = parseArgs(args);
    if (argv.help || argv.version) return 0;
    const config = validateOptions(argv);
    const files = await collectInputs(argv, config);
    const resolved = resolveFfmpegPathWithGpuDetection(config.ffmpegPath);
    const probe = spawnSync(resolved.path, ['-version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (probe.error || probe.status !== 0) throw new Error(`FFmpeg could not start: ${resolved.path}. Install FFmpeg or set --ffmpegPath.`);
    config._ffmpegResolved = resolved.path;
    config._gpuSupport = resolved.gpuSupport;
    if (config.audio && !config.audioFile) console.warn('[audio] Live page audio is experimental and may be silent or out of sync. Use --audioFile for a reliable soundtrack.');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    listening = true;
    const queue = [...files];
    const results = [];
    const width = Math.min(config.parallel, files.length);
    console.log(`Rendering ${files.length} file(s) at ${config.width}x${config.height}, ${config.frameRate} fps; parallel=${width}.`);
    async function worker(workerId) {
      while (queue.length && !interrupted) {
        const file = queue.shift();
        const controller = new AbortController();
        active.add(controller);
        const timer = config.ffmpegTimeoutMs > 0 ? setTimeout(() => controller.abort(new Error(`Conversion timed out after ${argv.ffmpegTimeoutSec}s.`)), config.ffmpegTimeoutMs) : null;
        let lastLog = 0;
        try {
          console.log(`[${workerId}] Starting ${file}`);
          await convertHtmlToVideo(file, { ...config, workerId, signal: controller.signal,
            updateStatus: (_id, status) => { if (Date.now() - lastLog > 1000) { console.log(status); lastLog = Date.now(); } } });
          if (controller.signal.aborted) throw controller.signal.reason;
          results.push({ file, success: true });
          console.log(`[${workerId}] Finished ${file}`);
        } catch (error) {
          results.push({ file, success: false });
          console.error(`[${workerId}] Failed ${file}: ${(controller.signal.reason || error).message}`);
        } finally {
          if (timer) clearTimeout(timer);
          active.delete(controller);
        }
      }
    }
    await Promise.all(Array.from({ length: width }, (_, index) => worker(index + 1)));
    const passed = results.filter((result) => result.success).length;
    const failed = results.length - passed;
    console.log(`Summary: ${passed} succeeded, ${failed} failed, ${queue.length} not started.`);
    return interrupted || (failed ? 1 : 0);
  } catch (error) {
    console.error(`htmltomp4: ${error.message}`);
    return error instanceof UsageError ? 2 : 1;
  } finally {
    if (listening) { process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm); }
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(`htmltomp4: ${error.message}`); process.exitCode = 1; });
}
module.exports = { main, parseArgs, validateOptions, collectInputs, UsageError };
