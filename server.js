const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const archiver = require('archiver');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'html_files');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    // Sanitize filename: alphanumeric + dots only
    const sanitizedOriginal = file.originalname.replace(/[^a-z0-9.]/gi, '_');
    // Use UUID + sanitized name to prevent collisions and guessing
    const name = `${uuidv4()}-${sanitizedOriginal}`;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// Rate Limiter: 100 requests per 15 minutes
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.'
});

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use('/previews', express.static(path.join(__dirname, 'html_files')));
// app.use('/downloads', express.static('output')); // Disabled for security
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.json());
app.use(limiter); // Apply rate limiting globally

// Ensure the SSE endpoint headers prevent caching
const sseHeaders = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
};

require('dotenv').config();

// Supabase Setup
const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Public client for general actions (if needed)
const publicSupabase = createClient(SUPABASE_URL, SUPABASE_KEY);
// Admin client for credit deduction (Bypasses RLS)
const adminSupabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// --- DYNAMIC PRICING LOGIC ---
const calculateJobCost = (w, h, f, d, fmt) => {
  let cost = 1; // Base cost

  // 1. Resolution Surcharge (4K = +3)
  if (w > 1920 || h > 1080) cost += 3;

  // 2. FPS Surcharge (High FPS = +1)
  if (f > 30) cost += 1;

  // 3. Duration Surcharge (+1 per extra 10s)
  if (d > 10) {
    const extra = Math.ceil((d - 10) / 10);
    cost += extra;
  }

  // 4. Format Surcharge (ProRes = +2)
  if (fmt === 'prores') cost += 2;

  return cost;
};


// --- GLOBAL JOB QUEUE ---
const jobQueue = [];
let isProcessing = false;

const processNextJob = async () => {
  if (isProcessing || jobQueue.length === 0) return;
  isProcessing = true;

  const job = jobQueue.shift();
  const { res, user, params, sendEvent } = job;

  // Check if client disconnected while waiting in queue
  if (res.writableEnded || res.socket.destroyed) {
    console.log('[Queue] Job skipped - Client disconnected');
    processNextJob();
    return;
  }

  const { filename, width, height, fps, duration, format } = params;

  try {
    // Stop heartbeat once processing starts
    if (job.heartbeat) clearInterval(job.heartbeat);

    sendEvent('log', '[Server] Worker slot acquired. Starting...');

    // 1. Check Credits (Again, right before run)
    const { data: profile, error: profileError } = await adminSupabase
      .from('profiles')
      .select('credits, tier')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      sendEvent('log', `[Error] Failed to load user profile: ${profileError?.message || 'Unknown error'}`);
      res.end();
      isProcessing = false;
      processNextJob();
      return;
    }

    const jobCost = calculateJobCost(width, height, fps, duration, format);

    // Deduct Credit (if not PRO)
    if (profile.tier !== 'pro') {
      if (profile.credits < jobCost) {
        sendEvent('log', `[Error] Insufficient credits. Cost: ${jobCost}, Available: ${profile.credits}`);
        res.end();
        isProcessing = false;
        processNextJob();
        return;
      }

      // Deduct cost
      const { data: updateData, error: updateError } = await adminSupabase
        .from('profiles')
        .update({ credits: profile.credits - jobCost })
        .eq('id', user.id)
        .select();

      if (updateError) {
        sendEvent('log', `[Error] Failed to deduct credits: ${updateError.message}`);
        res.end();
        isProcessing = false;
        processNextJob();
        return;
      }
      sendEvent('log', `[Server] ${jobCost} Credits deducted. Remaining: ${updateData[0].credits}`);
    } else {
      sendEvent('log', '[Server] Pro Tier: No credits deducted.');
    }

    // 2. Spawn Child Process
    const scriptPath = path.join(__dirname, 'convert.js');
    const args = [
      scriptPath,
      filename, // Positional argument for input file
      `--width=${width}`,
      `--height=${height}`,
      `--fps=${fps}`,
      `--duration=${duration}`,
      `--format=${format}`
    ];

    console.log(`[Server] Spawning conversion locally: ${filename}`);
    const child = spawn('node', args);

    // automatic 30-minute timeout for the child process
    const timeout = setTimeout(() => {
      if (child.exitCode === null) {
        console.log(`[Server] Timeout reached for ${filename}. Killing process.`);
        child.kill('SIGKILL');
      }
    }, 30 * 60 * 1000); // 30 minutes

    // Handle Client Cancellation (Disconnect)
    res.on('close', () => {
      if (child && child.exitCode === null) {
        console.log(`[Server] Client disconnected: Killing process for ${filename}`);
        child.kill('SIGKILL'); // Force kill
      }
    });

    child.stdout.on('data', (data) => {
      const line = data.toString().trim();
      sendEvent('log', line);
    });

    child.stderr.on('data', (data) => {
      console.error(`[Wrapper Error] ${data}`);
    });

    child.on('close', async (code) => {
      clearTimeout(timeout);
      console.log(`[Server] Process exited with code ${code}`);

      // Record Job in DB first to prevent race condition with download link
      if (code === 0) {
        const ext = format === 'prores' ? 'mov' : format;
        const outputName = filename.replace('.html', `.${ext}`);

        try {
          const { error } = await adminSupabase.from('job_history').insert({
            user_id: user.id,
            input_filename: filename,
            output_filename: outputName,
            status: 'completed'
          });
          if (error) console.error('[DB] Failed to save job history:', error);
        } catch (dbErr) {
          console.error('[DB] Insert Exception:', dbErr);
        }
      }

      // Send done event AFTER DB is updated
      sendEvent('done', { code });
      res.end();

      // Trigger next job
      isProcessing = false;
      processNextJob();
    });

  } catch (err) {
    console.error('Job Processing Error:', err);
    sendEvent('log', `[Error] Internal Server Error during processing.`);
    res.end();
    isProcessing = false;
    processNextJob();
  }
};

app.get('/convert', async (req, res) => {
  let { width, height, fps, duration, format, filename, token } = req.query;

  // Type Safety: Parse numeric inputs
  width = parseInt(width) || 1920;
  height = parseInt(height) || 1080;
  fps = parseInt(fps) || 30;
  duration = parseInt(duration) || 10;
  if (!format) format = 'mp4';

  if (!filename) return res.status(400).send('Filename is required');

  // Verify file exists
  const inputPath = path.join(__dirname, 'html_files', filename);
  if (!fs.existsSync(inputPath)) return res.status(404).send('File not found');

  res.writeHead(200, sseHeaders);
  const sendEvent = (type, data) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // --- SERVER-SIDE CREDIT VALIDATION ---
  if (!token) {
    sendEvent('log', '[Error] Authentication required: No token provided.');
    res.end();
    return;
  }

  // 1. Verify User (Use public/auth client to verify token)
  const { data: { user }, error: authError } = await publicSupabase.auth.getUser(token);
  if (authError || !user) {
    sendEvent('log', `[Error] Authentication failed: ${authError?.message || 'Invalid token'}`);
    res.end();
    return;
  }

  // Enqueue
  const jobParams = { width, height, fps, duration, format, filename };

  // Heartbeat to keep connection alive while in queue
  const heartbeat = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 15000); // 15 seconds

  // Clean up heartbeat on close
  res.on('close', () => clearInterval(heartbeat));

  jobQueue.push({ res, user, params: jobParams, sendEvent, heartbeat });

  if (isProcessing) {
    sendEvent('log', `[Server] Added to queue. Position: ${jobQueue.length}`);
    sendEvent('log', `[Info] Waiting for other jobs to finish...`);
  } else {
    sendEvent('log', `[Server] Added to queue.`);
  }

  processNextJob();
});


// --- DEV TOOLS (TESTING ONLY) ---
// Post to add 100 credits to the requesting user
app.post('/dev/add-credits', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  // 1. Verify User
  const { data: { user }, error: authError } = await publicSupabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

  // 2. Get Current Credits
  const { data: profile, error: profileError } = await adminSupabase
    .from('profiles')
    .select('credits')
    .eq('id', user.id)
    .single();

  if (profileError) return res.status(500).json({ error: 'Profile load failed' });

  // 3. Add 100 Credits
  const newCredits = (profile.credits || 0) + 100;

  const { error: updateError } = await adminSupabase
    .from('profiles')
    .update({ credits: newCredits })
    .eq('id', user.id);

  if (updateError) return res.status(500).json({ error: 'Update failed' });

  console.log(`[Dev] Added 100 credits to user ${user.email}. New Balance: ${newCredits}`);
  res.json({ success: true, newBalance: newCredits });
});

// --- AUTH MIDDLEWARE HELPER ---
const getUserFromToken = async (req) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const token = authHeader.split(' ')[1];
  if (!token) return null;
  const { data: { user }, error } = await publicSupabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
};

// --- ENDPOINTS ---

app.get('/files', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  // Fetch user's files from DB
  const { data: files, error } = await adminSupabase
    .from('user_files')
    .select('filename')
    .eq('user_id', user.id);

  if (error) {
    console.error('DB Error:', error);
    return res.status(500).json({ error: 'Failed to fetch files' });
  }

  // Filter physical files to ensure they exist (optional cleanup sync)
  const userFilenames = files.map(f => f.filename);
  res.json(userFilenames);
});


app.post('/upload', upload.array('htmlFiles'), async (req, res) => {
  // Multer has already saved the files to disk by now.
  // We need to verify auth and if invalid, delete them immediately.

  const user = await getUserFromToken(req);

  if (!user) {
    // Cleanup uploaded files if auth fails
    if (req.files) {
      req.files.forEach(f => fs.unlinkSync(f.path));
    }
    return res.status(401).send('Unauthorized. Please login.');
  }

  if (!req.files || req.files.length === 0) {
    return res.status(400).send('No files uploaded.');
  }

  const filenames = req.files.map(f => f.filename);

  // Insert into DB
  const validInserts = [];
  try {
    for (const filename of filenames) {
      const { error } = await adminSupabase
        .from('user_files')
        .insert({ user_id: user.id, filename });

      if (error) {
        console.error('DB Insert Error:', error);
        // Attempt to remove the file since DB insert failed
        const filePath = path.join(__dirname, 'html_files', filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } else {
        validInserts.push(filename);
      }
    }
    res.json({ message: 'Files uploaded successfully', filenames: validInserts });
  } catch (err) {
    console.error('Upload Process Error:', err);
    res.status(500).send('Internal Server Error');
  }
});

app.delete('/files/:filename', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).send('Unauthorized');

  const { filename } = req.params;

  // 1. Check ownership in DB
  const { data, error } = await adminSupabase
    .from('user_files')
    .select('id')
    .eq('user_id', user.id)
    .eq('filename', filename)
    .single();

  if (error || !data) {
    return res.status(403).send('You do not own this file or it does not exist.');
  }

  // 2. Delete from Disk
  const filePath = path.join(__dirname, 'html_files', filename);

  // Security: Prevent directory traversal (redundant with DB check but good practice)
  if (!filePath.startsWith(path.join(__dirname, 'html_files'))) {
    return res.status(403).send('Invalid file path');
  }

  if (fs.existsSync(filePath)) {
    fs.unlink(filePath, async (err) => {
      if (err) {
        console.error('Error deleting file:', err);
        return res.status(500).json({ error: err.message });
      }

      // 3. Delete from DB
      await adminSupabase.from('user_files').delete().eq('id', data.id);

      res.json({ message: 'File deleted successfully', filename });
    });
  } else {
    // File might be missing on disk but in DB, clean up DB
    await adminSupabase.from('user_files').delete().eq('id', data.id);
    res.json({ message: 'File deleted (record cleared)', filename });
  }
});

// app.use('/downloads', express.static('output')); // REMOVED FOR SECURITY

// --- SECURE DOWNLOADS ---
app.get('/download/:filename', async (req, res) => {
  const { filename } = req.params;
  const { token } = req.query;

  if (!token) return res.status(401).send('Unauthorized');

  // 1. Verify User
  const { data: { user }, error: authError } = await publicSupabase.auth.getUser(token);
  if (authError || !user) return res.status(401).send('Invalid token');

  // 2. Verify Ownership in DB
  const { data, error } = await adminSupabase
    .from('job_history')
    .select('id')
    .eq('user_id', user.id)
    .eq('output_filename', filename)
    .single();

  if (error || !data) {
    return res.status(403).send('Access Denied');
  }

  // 3. Serve File
  const filePath = path.join(__dirname, 'output', filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('File expired or not found.');

  // Restore original filename (remove 36-char UUID + hyphen)
  const originalName = filename.substring(37);
  res.download(filePath, originalName);
});

// --- BATCH DOWNLOAD ZIP ---
app.get('/download-all', async (req, res) => {
  const { token } = req.query;

  if (!token) return res.status(401).send('Unauthorized');

  // 1. Verify User
  const { data: { user }, error: authError } = await publicSupabase.auth.getUser(token);
  if (authError || !user) return res.status(401).send('Invalid token');

  // 2. Get All Completed Jobs
  const { data: jobs, error } = await adminSupabase
    .from('job_history')
    .select('output_filename, created_at')
    .eq('user_id', user.id)
    .eq('status', 'completed')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).send('Database Error');
  if (!jobs || jobs.length === 0) return res.status(404).send('No files found to download.');

  // 3. Stream ZIP
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="all_videos_${Date.now()}.zip"`
  });

  const archive = archiver('zip', {
    zlib: { level: 9 } // Sets the compression level.
  });

  archive.on('error', function (err) {
    console.error('Archiver Error:', err);
    res.status(500).end();
  });

  // Pipe archive data to the response
  archive.pipe(res);

  // Add files to zip
  const usedNames = new Map();

  for (const job of jobs) {
    const filePath = path.join(__dirname, 'output', job.output_filename);
    if (fs.existsSync(filePath)) {
      // Clean name: remove UUID prefix
      let originalName = job.output_filename.substring(37);

      // Handle duplicates
      if (usedNames.has(originalName)) {
        const count = usedNames.get(originalName);
        usedNames.set(originalName, count + 1);
        const ext = path.extname(originalName);
        const name = path.basename(originalName, ext);
        originalName = `${name}_(${count})${ext}`;
      } else {
        usedNames.set(originalName, 1);
      }

      archive.file(filePath, { name: originalName });
    }
  }

  archive.finalize();
});

app.get('/jobs', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { data, error } = await adminSupabase
    .from('job_history')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});


// Global Error Handlers
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
