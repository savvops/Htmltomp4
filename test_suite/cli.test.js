'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs, validateOptions, collectInputs } = require('../cli');

const root = path.resolve(__dirname, '..');
const flags = ['--width=320', '--height=180', '--fps=10', '--duration=1', '--gpu=cpu'];
function config(args = []) { const argv = parseArgs([...flags, ...args]); return { argv, config: validateOptions(argv) }; }
async function workspace() {
  const outputs = path.join(root, 'test_suite_output');
  await fs.mkdir(outputs, { recursive: true });
  return fs.mkdtemp(path.join(outputs, 'cli-contracts-'));
}
function run(args) {
  const result = spawnSync(process.execPath, [path.join(root, 'cli.js'), ...args], { cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.ifError(result.error);
  return result;
}

for (const arg of ['--width=NaN', '--width=321', '--height=0', '--width=12.5', '--fps=0', '--fps=Infinity', '--duration=-1', '--duration=abc', '--parallel=1.5', '--parallel=0', '--parallel=99', '--frameRetries=-1', '--jpegQuality=101', '--seed=-1', '--ffmpegTimeoutSec=0', '--ffmpegTimeoutSec=999999999', '--nvencCQ=-1', '--audioBitrate=bad', '--outputDir=', '--pixFmt=bad', '--format=bad', '--unknownFlag']) {
  test(`reject invalid argument ${arg}`, () => assert.throws(() => config([arg])));
}
test('no inputs is a usage error with useful instructions', () => {
  const result = run([]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Provide an HTML file or directory/);
  assert.doesNotMatch(result.stderr, /at .*\.js:\d+/);
});
test('help and version succeed without files or executables', () => {
  assert.equal(run(['--help']).status, 0);
  const result = run(['--version']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), require('../package.json').version);
});
test('CLI defaults are moderate and explicit duration is independent of auto cap', () => {
  const defaults = validateOptions(parseArgs([]));
  assert.deepEqual([defaults.width, defaults.height, defaults.frameRate, defaults.parallel], [1920, 1080, 30, 1]);
  const chosen = config(['--duration=90', '--maxDuration=2']).config;
  assert.equal(chosen.autoDuration, false);
  assert.equal(chosen.duration, 90);
});
test('short aliases and repeated options use the final value', () => {
  const value = config(['--fps=29.97', '-p', '2']).config;
  assert.equal(value.frameRate, 29.97);
  assert.equal(value.parallel, 2);
});
test('external audio enables audio and chooses the container-compatible codec', () => {
  assert.equal(config(['--audioFile=test.wav']).config.audio, true);
  assert.equal(config(['--format=webm', '--audio']).config.audioCodec, 'opus');
  assert.equal(config(['--format=prores', '--audio']).config.audioCodec, 'pcm');
  assert.throws(() => config(['--format=webm', '--audio', '--audioCodec=aac']), /incompatible/);
  assert.throws(() => config(['--format=mp4', '--audio', '--audioCodec=pcm']), /incompatible/);
  assert.throws(() => config(['--audioFile=test.wav', '--no-audio']), /cannot be combined/);
});
test('files from different folders retain their full paths; duplicate inputs are deduplicated', async () => {
  const temp = await workspace();
  const left = path.join(temp, 'left folder');
  const right = path.join(temp, 'right folder');
  await fs.mkdir(left); await fs.mkdir(right);
  const first = path.join(left, '001.html');
  const second = path.join(right, 'animation.htm');
  await fs.writeFile(first, '<h1>Left</h1>'); await fs.writeFile(second, '<h1>Right</h1>');
  const { argv, config: options } = config([first, second, first, `--outputDir=${path.join(temp, 'output')}`]);
  assert.deepEqual(await collectInputs(argv, options), [first, second]);
});
test('different sources with the same destination basename fail before rendering', async () => {
  const temp = await workspace();
  await fs.mkdir(path.join(temp, 'a')); await fs.mkdir(path.join(temp, 'b'));
  const inputs = ['a', 'b'].map((name) => path.join(temp, name, 'same.html'));
  for (const input of inputs) await fs.writeFile(input, '<h1>Test</h1>');
  const { argv, config: options } = config([...inputs, `--outputDir=${path.join(temp, 'output')}`]);
  await assert.rejects(collectInputs(argv, options), /Output name collision/);
});
test('mixed valid and missing inputs are rejected before writing anything', async () => {
  const temp = await workspace();
  const input = path.join(temp, 'good.html');
  await fs.writeFile(input, '<h1>Good</h1>');
  const output = path.join(temp, 'output');
  const result = run([...flags, input, path.join(temp, 'missing.html'), `--outputDir=${output}`]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Input not found/);
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
});
test('directory input sorts HTML/HTM files and does not recurse', async () => {
  const temp = await workspace();
  for (const name of ['b.HTM', 'a.html', 'ignored.txt']) await fs.writeFile(path.join(temp, name), 'test');
  await fs.mkdir(path.join(temp, 'nested'));
  await fs.writeFile(path.join(temp, 'nested', 'hidden.html'), 'test');
  const { argv, config: options } = config([`--inputDir=${temp}`, `--outputDir=${path.join(temp, 'output')}`]);
  assert.deepEqual((await collectInputs(argv, options)).map((file) => path.basename(file)), ['a.html', 'b.HTM']);
  assert.throws(() => config(['a.html', `--inputDir=${temp}`]), /not both/);
});
test('empty directories, unsupported inputs and missing external audio fail clearly', async () => {
  const temp = await workspace();
  let parsed = config([temp]);
  await assert.rejects(collectInputs(parsed.argv, parsed.config), /No .html or .htm/);
  const file = path.join(temp, 'test.txt'); await fs.writeFile(file, 'test');
  parsed = config([file]); await assert.rejects(collectInputs(parsed.argv, parsed.config), /Unsupported input/);
  const html = path.join(temp, 'test.html'); await fs.writeFile(html, 'test');
  parsed = config([html, `--audioFile=${path.join(temp, 'missing.wav')}`]);
  await assert.rejects(collectInputs(parsed.argv, parsed.config), /Audio file not found/);
});
test('existing output is preserved by default and overwrite is explicit', async () => {
  const temp = await workspace();
  const input = path.join(temp, 'test.html');
  await fs.writeFile(input, 'test'); await fs.writeFile(path.join(temp, 'test.mp4'), 'original');
  let parsed = config([input, `--outputDir=${temp}`]);
  await assert.rejects(collectInputs(parsed.argv, parsed.config), /Output already exists/);
  assert.equal(await fs.readFile(path.join(temp, 'test.mp4'), 'utf8'), 'original');
  parsed = config([input, `--outputDir=${temp}`, '--overwrite']);
  assert.deepEqual(await collectInputs(parsed.argv, parsed.config), [input]);
});
test('missing FFmpeg exits nonzero without launching the renderer', async () => {
  const temp = await workspace();
  const input = path.join(temp, 'test.html'); await fs.writeFile(input, 'test');
  const result = run([...flags, input, `--ffmpegPath=${path.join(temp, 'missing-ffmpeg.exe')}`, `--outputDir=${path.join(temp, 'output')}`]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FFmpeg could not start/);
});

test('overwrite cannot replace the audio input itself', async () => {
  const temp = await workspace();
  const input = path.join(temp, 'source.html');
  const audio = path.join(temp, 'source.mp4');
  await fs.writeFile(input, '<body>Example</body>'); await fs.writeFile(audio, 'original soundtrack');
  const parsed = config([input, `--audioFile=${audio}`, `--outputDir=${temp}`, '--overwrite']);
  await assert.rejects(collectInputs(parsed.argv, parsed.config), /replace its audio input/);
  assert.equal(await fs.readFile(audio, 'utf8'), 'original soundtrack');
});
