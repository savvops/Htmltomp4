'use strict';

// Real offline conversions, not source-text assertions. Run explicitly with:
// node --test test_suite/converter-integration.test.js
// Requires installed Puppeteer Chromium plus ffmpeg/ffprobe on PATH (or the
// HTMLTOMP4_TEST_FFMPEG / HTMLTOMP4_TEST_FFPROBE executable-path overrides).
// Every run keeps its videos, command logs and JSON report for inspection.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'cli-hardening', 'motion.html');
const ffmpeg = process.env.HTMLTOMP4_TEST_FFMPEG || 'ffmpeg';
const ffprobe = process.env.HTMLTOMP4_TEST_FFPROBE || 'ffprobe';
const width = 320;
const height = 180;
const fps = 10;
const duration = 1;
const frameBytes = width * height * 3;

function execute(executable, args, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: root, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let bytes = 0;
    let overflow = false;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      // Terminate only this test-owned process tree, including its browser and
      // encoder children; never enumerate or kill unrelated app processes.
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
          shell: false, windowsHide: true, stdio: 'ignore',
        });
        killer.on('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > 24 * 1024 * 1024) { overflow = true; stop(); return; }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, overflow, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

function commandError(result) {
  return `${result.timedOut ? 'TIMEOUT ' : ''}exit=${result.code}, signal=${result.signal}\n${result.stdout.toString().slice(-12000)}\n${result.stderr.toString().slice(-12000)}`;
}

async function mustExecute(executable, args, timeoutMs) {
  const result = await execute(executable, args, timeoutMs);
  assert.equal(result.timedOut, false, commandError(result));
  assert.equal(result.overflow, false, 'Command output exceeded the bounded capture limit');
  assert.equal(result.code, 0, commandError(result));
  return result;
}

function shortWave() {
  // 0.2 seconds of an audible 440 Hz tone: intentionally shorter than video,
  // so -shortest alone cannot silently reduce a requested one-second render.
  const sampleRate = 48000;
  const samples = sampleRate / 5;
  const channels = 2;
  const dataBytes = samples * channels * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * 2, 28);
  wav.writeUInt16LE(channels * 2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples; i++) {
    const amplitude = Math.round(12000 * Math.sin(2 * Math.PI * 440 * i / sampleRate));
    for (let channel = 0; channel < channels; channel++) wav.writeInt16LE(amplitude, 44 + (i * channels + channel) * 2);
  }
  return wav;
}

function motionMetrics(raw) {
  assert.equal(raw.length, frameBytes * fps * duration, 'Decoded byte count must equal ten complete RGB frames');
  const first = raw.subarray(0, frameBytes);
  const last = raw.subarray(raw.length - frameBytes);
  const regions = [
    ['css', 0, 0], ['canvas', 160, 0], ['svg-smil', 0, 90], ['waapi', 160, 90],
  ];
  return Object.fromEntries(regions.map(([name, left, top]) => {
    let changed = 0;
    let delta = 0;
    for (let y = top + 8; y < top + 82; y++) {
      for (let x = left + 4; x < left + 156; x++) {
        const offset = (y * width + x) * 3;
        const difference = Math.abs(first[offset] - last[offset])
          + Math.abs(first[offset + 1] - last[offset + 1])
          + Math.abs(first[offset + 2] - last[offset + 2]);
        if (difference > 90) changed++;
        delta += difference;
      }
    }
    const centers = [0, 5, 9].map((frameIndex) => {
      let totalX = 0;
      let colored = 0;
      for (let y = top + 15; y < top + 70; y++) {
        for (let x = left; x < left + 160; x++) {
          const offset = frameIndex * frameBytes + (y * width + x) * 3;
          const [r, g, b] = [raw[offset], raw[offset + 1], raw[offset + 2]];
          const foreground = name === 'canvas' ? g > 90 && g > r * 1.5
            : name === 'waapi' ? b > 90 && b > r * 1.5
              : name === 'svg-smil' ? r > 90 && r > g * 1.5 && b > g * 1.5
                : r > 90 && r > g * 1.5;
          if (foreground) { totalX += x - left; colored++; }
        }
      }
      return colored ? totalX / colored : null;
    });
    return [name, { changedPixels: changed, meanChannelDifference: delta / (152 * 74 * 3), centers }];
  }));
}

test('converter produces correct offline video and preserves inputs/outputs', { timeout: 600000 }, async (t) => {
  const outputRoot = path.join(root, 'test_suite_output');
  await fs.mkdir(outputRoot, { recursive: true });
  const runDir = await fs.mkdtemp(path.join(outputRoot, 'cli-hardening-'));
  const report = { createdAt: new Date().toISOString(), node: process.version, runDir, cases: [] };
  t.diagnostic(`Retained converter artifacts: ${runDir}`);

  async function convertCase(name, extra = [], inputs = [fixture], expectedCode = 0, outputDir = path.join(runDir, name), commandTimeoutMs = 90000) {
    const options = new Map(Object.entries({
      width, height, fps, duration, parallel: 1, gpu: 'cpu', enableGpu: false,
      inputCodec: 'png', ffmpegPath: ffmpeg, ffmpegTimeoutSec: 45, outputDir,
    }));
    for (let i = 0; i < extra.length; i++) {
      const [name, inlineValue] = extra[i].replace(/^--/, '').split('=', 2);
      const value = inlineValue === undefined
        ? extra[i + 1] && !extra[i + 1].startsWith('--') ? extra[++i] : true
        : inlineValue;
      options.set(name, value);
    }
    const args = [path.join(root, 'convert.js'), ...inputs,
      ...[...options].flatMap(([key, value]) => [`--${key}`, String(value)]),
    ];
    const startedAt = Date.now();
    const result = await execute(process.execPath, args, commandTimeoutMs);
    const elapsedMs = Date.now() - startedAt;
    await fs.writeFile(path.join(runDir, `${name}.command.json`), JSON.stringify({ executable: process.execPath, args }, null, 2));
    await fs.writeFile(path.join(runDir, `${name}.stdout.log`), result.stdout);
    await fs.writeFile(path.join(runDir, `${name}.stderr.log`), result.stderr);
    report.cases.push({ name, code: result.code, signal: result.signal, timedOut: result.timedOut, elapsedMs, outputDir });
    assert.equal(result.timedOut, false, commandError(result));
    assert.equal(result.overflow, false);
    assert.equal(result.code, expectedCode, commandError(result));
    return { result, outputDir, entry: report.cases[report.cases.length - 1] };
  }

  async function inspect(file, expectedCodec, withMotion = true) {
    const probed = await mustExecute(ffprobe, [
      '-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file,
    ], 15000);
    const metadata = JSON.parse(probed.stdout.toString());
    await fs.writeFile(`${file}.probe.json`, JSON.stringify(metadata, null, 2));
    const video = metadata.streams.find((stream) => stream.codec_type === 'video');
    assert.ok(video, 'Output must contain video');
    assert.equal(video.codec_name, expectedCodec);
    assert.equal(video.color_space, 'bt709');
    assert.equal(video.color_primaries, 'bt709');
    if (expectedCodec === 'prores') {
      assert.equal(video.profile, '4444');
      assert.equal(video.pix_fmt, 'yuv444p12le', 'ProRes 4444 decodes as opaque 4:4:4');
    } else {
      assert.equal(video.color_range, 'pc');
      assert.equal(video.color_transfer, 'iec61966-2-1');
    }
    assert.equal(video.width, width);
    assert.equal(video.height, height);
    assert.equal(Number(video.nb_read_frames), fps * duration, 'No frames may disappear during muxing');
    assert.ok(Math.abs(Number(video.duration || metadata.format.duration) - duration) < 0.11, 'Requested duration must be preserved');
    await mustExecute(ffmpeg, ['-hide_banner', '-v', 'error', '-xerror', '-i', file, '-map', '0:v:0', '-f', 'null', '-'], 15000);
    const decoded = await mustExecute(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], 15000);
    const movement = motionMetrics(decoded.stdout);
    await fs.writeFile(`${file}.motion.json`, JSON.stringify(movement, null, 2));
    if (withMotion) {
      const redSample = Array.from(decoded.stdout.subarray((40 * width + 26) * 3, (40 * width + 26) * 3 + 3));
      for (let channel = 0; channel < 3; channel++) {
        assert.ok(Math.abs(redSample[channel] - [237, 81, 75][channel]) <= 12, `Decoded red swatch drifted: ${redSample}`);
      }
      for (const [name, metric] of Object.entries(movement)) {
        assert.ok(metric.changedPixels > 350, `${name} animation is missing/frozen: ${JSON.stringify(metric)}`);
        assert.ok(metric.meanChannelDifference > 3, `${name} movement should remain clearly visible`);
        const expectedCenters = name === 'css' ? [26.5, 56.5, 96.5]
          : name === 'waapi' ? [46.5, 96.5, 36.5] : [26.5, 76.5, 116.5];
        for (let i = 0; i < metric.centers.length; i++) {
          assert.ok(metric.centers[i] !== null && Math.abs(metric.centers[i] - expectedCenters[i]) < 3,
            `${name} timeline at frame ${[0, 5, 9][i]}: expected center ${expectedCenters[i]}, received ${metric.centers[i]}`);
        }
      }
    }
    return { metadata, movement, decodedSha256: createHash('sha256').update(decoded.stdout).digest('hex') };
  }

  try {
    for (const [name, executable] of [['ffmpeg', ffmpeg], ['ffprobe', ffprobe]]) {
      const version = await mustExecute(executable, ['-version'], 15000);
      report[name] = version.stdout.toString().split(/\r?\n/)[0];
    }

    let baseline;
    await t.test('page errors and missing assets fail instead of publishing misleading output', async () => {
      const cases = [
        ['script-error', '<script>throw new Error("broken page script")</script>', /broken page script/],
        ['raf-error', '<script>requestAnimationFrame(() => { throw new Error("broken animation callback") })</script>', /broken animation callback/],
        ['timer-error', '<script>setTimeout(() => { throw new Error("broken timer callback") }, 50)</script>', /broken timer callback/],
        ['nextframe-error', '<script>window.nextFrame = async () => { throw new Error("broken nextFrame callback") }</script>', /broken nextFrame callback/],
        ['missing-asset', '<script src="./missing-animation.js"></script>', /Could not load script asset/],
      ];
      for (const [name, html, expected] of cases) {
        const input = path.join(runDir, `${name}.html`);
        await fs.writeFile(input, `<!doctype html><body><h1>Broken input</h1>${html}</body>`);
        const run = await convertCase(name, [], [input], 1);
        assert.match(run.result.stderr.toString(), expected);
        await assert.rejects(fs.stat(path.join(run.outputDir, `${name}.mp4`)), { code: 'ENOENT' });
        assert.deepEqual(await fs.readdir(run.outputDir), [], 'Failed render must clean staging output');
      }
    });

    await t.test('ignored page errors are reported and blocking dialogs are dismissed', async () => {
      const input = path.join(runDir, 'dialogs.html');
      await fs.writeFile(input, '<!doctype html><body style="background:green"><script>alert("test"); confirm("test"); prompt("test"); throw new Error("explicitly ignored")</script></body>');
      const run = await convertCase('dialogs', ['--ignorePageErrors'], [input]);
      assert.match(run.result.stderr.toString(), /explicitly ignored/);
      await mustExecute(ffmpeg, ['-v', 'error', '-xerror', '-i', path.join(run.outputDir, 'dialogs.mp4'), '-f', 'null', '-']);
    });

    await t.test('a failed batch item does not suppress the remaining valid output', async () => {
      const bad = path.join(runDir, 'bad-batch.html');
      await fs.writeFile(bad, '<script>throw new Error("failed batch item")</script>');
      const run = await convertCase('batch-failure', [], [bad, fixture], 1);
      assert.match(run.result.stdout.toString(), /Summary: 1 succeeded, 1 failed/);
      await inspect(path.join(run.outputDir, 'motion.mp4'), 'h264');
      await assert.rejects(fs.stat(path.join(run.outputDir, 'bad-batch.mp4')), { code: 'ENOENT' });
    });
    await t.test('CPU MP4 contains CSS, Canvas, SVG SMIL and WAAPI movement', async () => {
      const run = await convertCase('cpu-png');
      baseline = await inspect(path.join(run.outputDir, 'motion.mp4'), 'h264');
      Object.assign(run.entry, baseline);
    });

    await t.test('a repeat CPU render has identical decoded frames', async () => {
      assert.ok(baseline, 'Baseline conversion must pass first');
      const run = await convertCase('cpu-repeat');
      const repeated = await inspect(path.join(run.outputDir, 'motion.mp4'), 'h264');
      Object.assign(run.entry, repeated);
      assert.equal(repeated.decodedSha256, baseline.decodedSha256, 'Virtual-time fixture must not depend on wall-clock load/capture timing');
    });

    await t.test('GPU auto selection or CPU fallback creates playable JPEG-input MP4', async () => {
      const run = await convertCase('gpu-auto', ['--gpu', 'auto', '--enableGpu=true', '--inputCodec', 'jpeg']);
      Object.assign(run.entry, await inspect(path.join(run.outputDir, 'motion.mp4'), 'h264'));
      run.entry.encoderLog = run.result.stdout.toString().split(/\r?\n/).filter((line) => /encoder|fallback|falling back/i.test(line));
      t.diagnostic(`GPU-auto result: ${run.entry.encoderLog.join(' | ')}`);
    });

    await t.test('4K CPU output keeps actual 3840 by 2160 dimensions', async () => {
      const run = await convertCase('cpu-4k', ['--width', '3840', '--height', '2160', '--duration', '0.2']);
      const file = path.join(run.outputDir, 'motion.mp4');
      const result = await mustExecute(ffprobe, [
        '-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file,
      ], 15000);
      run.entry.metadata = JSON.parse(result.stdout.toString());
      const video = run.entry.metadata.streams.find((stream) => stream.codec_type === 'video');
      assert.equal(video?.width, 3840);
      assert.equal(video?.height, 2160);
      assert.equal(Number(video?.nb_read_frames), 2);
      assert.ok(Math.abs(Number(video?.duration || run.entry.metadata.format.duration) - 0.2) < 0.05);
      await mustExecute(ffmpeg, ['-hide_banner', '-v', 'error', '-xerror', '-i', file, '-map', '0:v:0', '-f', 'null', '-'], 15000);
    });

    await t.test('native WebGL shader animation renders without external libraries', async () => {
      const input = path.join(__dirname, 'fixtures', 'cli-hardening', 'webgl.html');
      const run = await convertCase('webgl', ['--enableGpu=true'], [input]);
      const file = path.join(run.outputDir, 'webgl.mp4');
      Object.assign(run.entry, await inspect(file, 'h264', false));
      const decoded = await mustExecute(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], 15000);
      const centers = [0, 5, 9].map((frame) => {
        let weightedX = 0;
        let count = 0;
        for (let x = 0; x < width; x++) {
          const offset = frame * frameBytes + (90 * width + x) * 3;
          if (decoded.stdout[offset + 1] > 130 && decoded.stdout[offset + 2] > 130) {
            count++; weightedX += x;
          }
        }
        assert.ok(count >= 30, 'A visible WebGL stripe must be present');
        return weightedX / count;
      });
      run.entry.stripeCenters = centers;
      for (const [i, expected] of [39.5, 149.5, 237.5].entries()) {
        assert.ok(Math.abs(centers[i] - expected) < 3, `WebGL frame ${[0, 5, 9][i]} center ${centers[i]} should be ${expected}`);
      }
    });

    for (const [format, extension, codec, audioCodec] of [
      ['mp4', 'mp4', 'h264', 'aac'], ['webm', 'webm', 'vp9', 'opus'], ['prores', 'mov', 'prores', 'pcm_s16le'],
    ]) {
      await t.test(`${format} short external audio is audible and does not truncate video`, async () => {
        const audioFile = path.join(runDir, 'tone-0.2-seconds.wav');
        await fs.writeFile(audioFile, shortWave());
        // --audioFile alone should enable audio and choose a container-compatible codec.
        const run = await convertCase(`audio-${format}`, ['--format', format, '--audioFile', audioFile]);
        const file = path.join(run.outputDir, `motion.${extension}`);
        const inspected = await inspect(file, codec);
        Object.assign(run.entry, inspected);
        const audio = inspected.metadata.streams.find((stream) => stream.codec_type === 'audio');
        assert.ok(audio, 'Supplying --audioFile must produce an audio stream');
        assert.equal(audio.codec_name, audioCodec);
        const pcm = await mustExecute(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], 15000);
        assert.ok(pcm.stdout.length >= 48000 * 2 * 0.9, 'Short source audio must be padded through the render');
        let sum = 0;
        const samples = Math.min(4800, pcm.stdout.length / 2);
        for (let i = 0; i < samples; i++) sum += pcm.stdout.readInt16LE(i * 2) ** 2;
        run.entry.audioRms = Math.sqrt(sum / samples);
        assert.ok(run.entry.audioRms > 1000, 'External source audio must contain an audible signal');
      });
    }

    await t.test('multiple input directories retain the correct source paths', async () => {
      const source = await fs.readFile(fixture, 'utf8');
      const inputs = [];
      for (const [dir, name, background] of [['one', 'first', '#121c28'], ['two', 'second', '#281c12']]) {
        const inputDir = path.join(runDir, 'input-paths', dir);
        await fs.mkdir(inputDir, { recursive: true });
        const input = path.join(inputDir, `${name}.html`);
        await fs.writeFile(input, source.replace('#121c28', background));
        inputs.push(inputDir);
      }
      const run = await convertCase('mixed-directories', [], inputs);
      const first = await inspect(path.join(run.outputDir, 'first.mp4'), 'h264');
      const second = await inspect(path.join(run.outputDir, 'second.mp4'), 'h264');
      assert.notEqual(first.decodedSha256, second.decodedSha256, 'Distinct input content must not resolve to the same source');
      run.entry.outputs = [first, second];
    });

    await t.test('colliding output basenames fail before writing output', async () => {
      const inputs = [];
      for (const dir of ['one', 'two']) {
        const inputDir = path.join(runDir, 'colliding-inputs', dir);
        await fs.mkdir(inputDir, { recursive: true });
        const input = path.join(inputDir, 'same.html');
        await fs.copyFile(fixture, input);
        inputs.push(input);
      }
      const run = await convertCase('collision', [], inputs, 2);
      assert.match(run.result.stderr.toString() + run.result.stdout.toString(), /^htmltomp4: Output name collision:/m);
      await assert.rejects(fs.stat(path.join(run.outputDir, 'same.mp4')), { code: 'ENOENT' });
    });

    await t.test('a conversion deadline exits promptly without publishing a partial video', async () => {
      const outputDir = path.join(runDir, 'deadline');
      const run = await convertCase('deadline', ['--ffmpegTimeoutSec', '0.05'], [fixture], 1, outputDir, 10000);
      assert.match(run.result.stderr.toString() + run.result.stdout.toString(), /timed out/i);
      assert.ok(run.entry.elapsedMs < 7000, `Deadline cleanup took ${run.entry.elapsedMs} ms`);
      const entries = await fs.readdir(outputDir).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      assert.deepEqual(entries, [], 'A timed-out conversion must not leave final videos or temporary render directories');
    });

    await t.test('existing output is preserved unless --overwrite is explicit', async () => {
      const outputDir = path.join(runDir, 'overwrite');
      await fs.mkdir(outputDir);
      const existing = path.join(outputDir, 'motion.mp4');
      const sentinel = Buffer.from('Existing user output must survive rejected conversion.');
      await fs.writeFile(existing, sentinel);
      const rejected = await convertCase('overwrite-rejected', [], [fixture], 2, outputDir);
      assert.match(rejected.result.stderr.toString() + rejected.result.stdout.toString(), /^htmltomp4: Output already exists:/m);
      assert.deepEqual(await fs.readFile(existing), sentinel);
      const run = await convertCase('overwrite-approved', ['--overwrite'], [fixture], 0, outputDir);
      Object.assign(run.entry, await inspect(existing, 'h264'));
    });
  } finally {
    await fs.writeFile(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  }
});
