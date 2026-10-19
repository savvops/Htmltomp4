# HTMLtoMP4 CLI (`htmltomp4`)

**Turn local HTML, CSS, Canvas, SVG, and WebGL animations into deterministic MP4, WebM, or ProRes 4444 videos** using Chromium and FFmpeg.

No screen recording, no dropped frames, and no cloud upload queues. Instead of recording wall-clock time, `htmltomp4` steps browser time (`requestAnimationFrame`, CSS/Web Animations API, SVG SMIL, and seeded `Math.random`) frame-by-frame and pipes frames directly to FFmpeg with automatic hardware encoder detection (NVIDIA NVENC, AMD AMF, Intel QSV, or CPU fallback).

---

## 🖥️ Want the One-Click Windows Desktop App?

If you prefer a native GUI with **bundled Chromium + FFmpeg** (zero Node.js or PATH setup), visual batch queues, encoder diagnostics, and 4K/60fps presets:

- **[Download the Free Windows Trial (10 renders)](https://htmltomp4.com/?utm_source=github&utm_medium=readme&utm_campaign=oss_cli)**
- **[Get HTMLtoMP4 Desktop Pro — CAD $19 one-time license](https://htmltomp4.com/pricing/?utm_source=github&utm_medium=readme&utm_campaign=oss_cli)** (unlimited conversions, batch rendering, 4K/8K, 3-machine activation, no subscription)
- Need ready-to-render animations? Browse 140+ copy-paste effects on **[HTMLHub.org](https://htmlhub.org/?utm_source=github&utm_medium=readme&utm_campaign=oss_cli)**.

---

## ✨ Features

- **Deterministic Frame Stepping:** Steps virtual browser time, `requestAnimationFrame`, CSS/WAAPI animations, and SVG animations frame-by-frame for smooth, repeatable exports even on heavy scenes.
- **Auto-Duration Detection:** Automatically inspects `document.getAnimations()` when `--duration` is omitted.
- **Hardware-Probed GPU Encoding:** Tests NVIDIA (`h264_nvenc` / `hevc_nvenc`), AMD (`amf`), and Intel (`qsv`) encoders at your target resolution before starting, falling back cleanly to CPU (`libx264` / `libx265`) if a driver check fails.
- **Multiple Containers & Studio Codecs:** Export standard `mp4` (H.264/HEVC), `webm` (VP9), or `prores` (MOV with ProRes 4444).
- **Safe Output Staging:** Renders into a temporary staging file and only replaces existing outputs when `--overwrite` is passed and FFmpeg exits cleanly.
- **External Soundtrack Sync:** Attach `--audioFile ./track.wav` with automatic AAC/Opus/PCM codec selection.

---

## 🚀 Quick Start (CLI)

### 1. Install

Clone the repository and install dependencies (requires **Node.js 18+**):

```bash
git clone https://github.com/savvops/htmltomp4.git
cd htmltomp4
npm install
```

*(Puppeteer automatically downloads a compatible Chromium binary, and `ffmpeg-static` provides a fallback FFmpeg binary if `ffmpeg` is not on your system `PATH`.)*

### 2. Render an Animation

Try rendering one of the included examples:

```bash
# Render a 5-second 1080p@30fps MP4
node cli.js examples/css_animation.html --duration 5

# Render at 4K 60fps
node cli.js examples/canvas_particles.html --width 3840 --height 2160 --fps 60 --duration 5

# Render an entire folder of .html files in parallel
node cli.js --inputDir ./examples --outputDir ./videos --parallel 2 --duration 4
```

Output videos are written to `./output/` by default (or your specified `--outputDir`).

---

## ⚙️ CLI Options

```text
htmltomp4 <file.html|directory> [more inputs...] [options]
```

| Flag | Default | Description |
| :--- | :--- | :--- |
| `--width` | `1920` | Output width in pixels (`2` to `8192`, even numbers required for 4:2:0/4:2:2) |
| `--height` | `1080` | Output height in pixels (`2` to `8192`) |
| `--fps`, `--frameRate` | `30` | Frames per second (`1` to `240`) |
| `--duration` | *(auto)* | Seconds to render. Omit to auto-detect from CSS/Web Animations (fallback: `10s`) |
| `--maxDuration` | `60` | Cap for auto-detected animation duration in seconds |
| `--inputDir` | — | Render all `.html` / `.htm` files in a directory (non-recursive) |
| `--outputDir` | `./output` | Destination directory for rendered videos |
| `--overwrite` | `false` | Replace existing output files only after a successful render |
| `--parallel`, `-p` | `1` | Number of concurrent conversion workers (`1` to `16`) |
| `--format` | `mp4` | Output container: `mp4` (H.264/HEVC), `webm` (VP9), or `prores` (ProRes 4444 `.mov`) |
| `--gpu` | `auto` | Hardware encoder preference: `auto`, `nvidia`, `amd`, `intel`, or `cpu` |
| `--inputCodec` | `jpeg` | Frame pipe format: `jpeg` (fast) or `png` (lossless frame capture) |
| `--jpegQuality` | `85` | JPEG capture quality (`1` to `100`) |
| `--audioFile` | — | Path to an external audio file (`.wav`, `.mp3`, etc.) to mux with the video |
| `--seed` | `1234` | PRNG seed for deterministic `Math.random()` inside the page |
| `--ignorePageErrors` | `false` | Continue rendering even if the HTML page throws console/network errors |
| `--executablePath` | *(auto)* | Custom path to Chrome/Chromium executable |
| `--ffmpegPath` | *(auto)* | Custom path to FFmpeg executable |

Run `node cli.js --help` for the complete list of encoder presets (`--nvencPreset`, `--cpuCrf4k`, `--pixFmt`, etc.).

---

## 🧪 Running the Test Suite

```bash
# Run CLI contract and renderer lifecycle tests
npm test

# Run full offline video conversion integration suite (requires Chromium + FFmpeg/ffprobe)
npm run test:converter
```

---

## 🛡️ Security & Best Practices

- **Render only trusted HTML:** Pages execute inside headless Chromium and can make network requests or load relative local files.
- **Self-contained assets:** If your export appears blank, ensure external fonts, scripts (Three.js, GSAP, Vanta), and images use valid relative paths or reachable URLs, and give your root animation container explicit `width` and `height` (`100vw` / `100vh`). See the **[Troubleshooting & First-Export Guide](https://htmltomp4.com/guides/html-animation-to-mp4/)**.

---

## 📄 License

MIT License — Built by [Savv Studio](https://savvstudio.com).
