# HTML to MP4 Converter

This project converts HTML animations into MP4 videos using Puppeteer and FFmpeg.

## Setup

1.  Install Node.js (if not already installed).
2.  Install dependencies:
    ```bash
    npm install
    ```
    (Note: If you run into PowerShell execution policy errors, use `cmd /c npm install` or enable scripts).

## Usage

1.  Place your HTML files in the `html_files` directory.
2.  Run the converter:
    ```bash
    npm start
    ```
    Or run with custom options:
    ```bash
    node convert.js --duration 5 --frameRate 30
    ```

## Options

-   `--duration`: Duration of the video in seconds (default: 10).
-   `--frameRate`: Frames per second (default: 60).
-   `--width`: Video width (default: 3840).
-   `--height`: Video height (default: 2160).
-   `--parallel`: Number of parallel conversions (default: 2).
-   `--encoder`: 'nvenc' (GPU), 'cpu', or 'auto'.

## Output

The converted MP4 files will be in the `output` directory.
Processed HTML files are moved to `processed_htmls`.
