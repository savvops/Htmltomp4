const SUPABASE_URL = 'https://pcrumthbyecczeumvvzu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBjcnVtdGhieWVjY3pldW12dnp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg0ODY3MzAsImV4cCI6MjA4NDA2MjczMH0.hbC34EXo8J8LilmStRGQV-bbaNI8-QHy5rmXh97yVhE';

let supabase;
let currentUser = null;
let userProfile = null;
let isCancelled = false;
let currentEvtSource = null;
let lastLogMsg = '';

// Initialize when DOM is ready
function initializeApp() {
    console.log('[App] Initializing...');

    // 1. Init Supabase
    try {
        if (!window.supabase) throw new Error('Supabase client not loaded');
        // Check if already initialized to avoid re-init issues if called multiple times
        if (!supabase) {
            supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
            console.log('[App] Supabase initialized');
        }
    } catch (e) {
        console.error('[App] Init Error:', e);
        alert('Internal Error: Supabase failed to load. Please refresh.');
        return;
    }

    // 2. Select Elements
    const uploadInput = document.getElementById('uploadInput');
    const fileSelect = document.getElementById('filename');
    const previewFrame = document.getElementById('previewFrame');
    const convertBtn = document.getElementById('convertBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const logs = document.getElementById('logs');
    const statusIndicator = document.getElementById('statusIndicator');

    const loginBtn = document.getElementById('loginBtn');
    const loginModal = document.getElementById('loginModal');
    const closeModalBtn = document.getElementById('closeModalBtn'); // Assuming this button exists in HTML
    const profileSection = document.getElementById('profileSection');
    const userEmail = document.getElementById('userEmail');
    const creditCount = document.getElementById('creditCount');
    const logoutLink = document.getElementById('logoutLink');

    const emailInput = document.getElementById('emailInput');
    const passwordInput = document.getElementById('passwordInput');
    const supabaseLoginBtn = document.getElementById('supabaseLoginBtn');
    const supabaseSignupBtn = document.getElementById('supabaseSignupBtn');
    const authMessage = document.getElementById('authMessage');

    // 3. Define Logic

    // Auth: Refresh Session
    async function refreshSession() {
        if (!supabase) return;
        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (session) {
                currentUser = session.user;
                await loadProfile();
            } else {
                currentUser = null;
                userProfile = null;
            }
            updateAuthUI();
        } catch (err) {
            console.error('Session check failed:', err);
        }
    }

    // Auth: Load Profile
    async function loadProfile() {
        if (!currentUser) return;
        const { data, error } = await supabase
            .from('profiles')
            .select('credits, tier')
            .eq('id', currentUser.id)
            .single();

        if (data) {
            userProfile = data;
        } else if (error) {
            console.error('Error loading profile:', error);
        }
    }

    // Auth: Update UI
    function updateAuthUI() {
        if (currentUser) {
            if (loginBtn) loginBtn.style.display = 'none';
            if (profileSection) profileSection.style.display = 'block';
            if (userEmail) userEmail.textContent = currentUser.email;
            if (creditCount) creditCount.textContent = (userProfile && userProfile.tier === 'pro') ? '∞' : (userProfile?.credits ?? 0);
        } else {
            if (loginBtn) loginBtn.style.display = 'block';
            if (profileSection) profileSection.style.display = 'none';
        }
    }

    // Auth: Event Listeners
    if (loginBtn) loginBtn.onclick = () => {
        if (loginModal) loginModal.style.display = 'flex';
    };

    if (closeModalBtn) closeModalBtn.onclick = () => {
        if (loginModal) loginModal.style.display = 'none';
        if (authMessage) authMessage.textContent = '';
        if (emailInput) emailInput.value = '';
        if (passwordInput) passwordInput.value = '';
    };

    if (logoutLink) logoutLink.onclick = async (e) => {
        e.preventDefault();
        await supabase.auth.signOut();
        currentUser = null;
        userProfile = null;
        updateAuthUI();
        appendLog('[Auth] Logged out.');
        await loadFiles();
        loadJobs(); // Will hide panel since currentUser is null
    };

    if (supabaseLoginBtn) supabaseLoginBtn.onclick = async () => {
        const email = emailInput ? emailInput.value : '';
        const password = passwordInput ? passwordInput.value : '';
        if (!email || !password) {
            if (authMessage) authMessage.textContent = 'Please enter email and password.';
            return;
        }
        if (authMessage) authMessage.textContent = 'Signing in...';

        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
            if (authMessage) {
                authMessage.textContent = error.message;
                authMessage.style.color = 'red';
            }
        } else {
            if (authMessage) {
                authMessage.textContent = 'Success!';
                authMessage.style.color = 'green';
            }
            currentUser = data.user;
            await loadProfile();
            updateAuthUI();
            if (closeModalBtn) closeModalBtn.click(); // Close modal
            appendLog(`[Auth] Logged in as ${currentUser.email}`);
            await loadFiles();
            loadJobs();
        }
    };

    if (supabaseSignupBtn) supabaseSignupBtn.onclick = async () => {
        const email = emailInput ? emailInput.value : '';
        const password = passwordInput ? passwordInput.value : '';
        if (!email || !password) {
            if (authMessage) authMessage.textContent = 'Please enter email and password.';
            return;
        }
        if (authMessage) authMessage.textContent = 'Signing up...';

        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) {
            if (authMessage) {
                authMessage.textContent = error.message;
                authMessage.style.color = 'red';
            }
        } else {
            if (data.session) {
                if (authMessage) {
                    authMessage.textContent = 'Sign up successful! You are now logged in.';
                    authMessage.style.color = 'green';
                }
                currentUser = data.user;
                await loadProfile();
                updateAuthUI();
                setTimeout(() => { if (closeModalBtn) closeModalBtn.click(); }, 1500);
                appendLog(`[Auth] Account created for ${currentUser.email}`);
            } else {
                if (authMessage) {
                    authMessage.textContent = 'Sign up successful! Please check your email to confirm.';
                    authMessage.style.color = 'green';
                }
            }
        }
    };

    // Close modal on outside click
    window.onclick = (event) => {
        if (loginModal && event.target == loginModal) {
            if (closeModalBtn) closeModalBtn.click();
        }
        if (pricingModal && event.target == pricingModal) {
            pricingModal.style.display = 'none';
        }
    };

    // --- MONETIZATION & PRICING UI ---
    const pricingModal = document.getElementById('pricingModal');
    const addCreditsBtn = document.getElementById('addCreditsBtn');
    const closePricingBtn = document.getElementById('closePricingBtn');
    const buyPackBtn = document.getElementById('buyPackBtn');
    const subscribeBtn = document.getElementById('subscribeBtn');

    function openPricing() {
        if (pricingModal) {
            pricingModal.style.display = 'flex';
            // Optional: Analytics trigger here
            console.log('[Analytics] Pricing Modal Opened');
        }
    }

    if (addCreditsBtn) addCreditsBtn.onclick = (e) => {
        e.stopPropagation(); // prevent bubbling issues
        openPricing();
    };

    if (closePricingBtn) closePricingBtn.onclick = () => {
        if (pricingModal) pricingModal.style.display = 'none';
    };

    // Temporary Mock Purchase Logic
    if (buyPackBtn) buyPackBtn.onclick = () => {
        if (!currentUser) return alert('Please login to purchase credits.');
        // TODO: Replace with Stripe Checkout
        alert('Payment System Integration Coming Soon!\n(This would send you to Stripe Checkout)');
        appendLog('[Analytics] User clicked "Buy Pack"');
    };

    if (subscribeBtn) subscribeBtn.onclick = () => {
        if (!currentUser) return alert('Please login to subscribe.');
        // TODO: Replace with Stripe Subscription
        alert('Subscription System Integration Coming Soon!\n(This would start a Stripe Subscription)');
        appendLog('[Analytics] User clicked "Subscribe"');
    };

    // Dev: Claim Free Credits
    const claimCreditsBtn = document.getElementById('claimCreditsBtn');
    if (claimCreditsBtn) claimCreditsBtn.onclick = async () => {
        if (!currentUser) return alert('Please login to claim credits.');

        claimCreditsBtn.disabled = true;
        claimCreditsBtn.textContent = "Claiming...";

        try {
            const { data: { session } } = await supabase.auth.getSession();
            const token = session ? session.access_token : null;

            const res = await fetch('/dev/add-credits', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            const data = await res.json();
            if (res.ok) {
                alert(`Success! You now have ${data.newBalance} credits.`);
                await loadProfile();
                updateAuthUI();
                if (pricingModal) pricingModal.style.display = 'none';
                appendLog(`[Dev] Claimed 100 free credits.`);
            } else {
                alert('Failed to claim: ' + data.error);
            }
        } catch (e) {
            console.error(e);
            alert('Error claiming credits.');
        } finally {
            claimCreditsBtn.disabled = false;
            claimCreditsBtn.textContent = "Claim";
        }
    };

    // 4. File Handling & Conversion Logic

    function appendLog(text) {
        // ... (Log logic mostly unchanged, just ensure it's safe)
        const isProgress = text.includes('[Worker') && (text.includes('Capturing') || text.includes('Encoding'));
        if (isProgress) {
            const lastLog = logs ? logs.lastElementChild : null;
            if (lastLog && lastLog.textContent.includes('[Worker') && !lastLog.textContent.includes('Finished')) {
                lastLog.textContent = text;
                return;
            }
        }
        const line = document.createElement('div');
        line.textContent = text;
        if (text.toLowerCase().includes('error')) line.className = 'log-error';
        else if (text.toLowerCase().includes('finished') || text.toLowerCase().includes('done')) line.className = 'log-success';
        else if (text.startsWith('[')) line.className = 'log-info';
        if (logs) {
            logs.appendChild(line);
            logs.scrollTop = logs.scrollHeight;
        }
    }

    async function getAuthHeaders() {
        const { data: { session } } = await supabase.auth.getSession();
        return session ? { 'Authorization': `Bearer ${session.access_token}` } : {};
    }

    async function loadFiles() {
        try {
            const headers = await getAuthHeaders();
            if (!headers.Authorization) {
                if (fileSelect) fileSelect.innerHTML = '<option disabled>Please login to view files</option>';
                return;
            }

            const res = await fetch('/files', { headers });
            if (res.status === 401) {
                if (fileSelect) fileSelect.innerHTML = '<option disabled>Please login to view files</option>';
                return;
            }
            const files = await res.json();
            if (fileSelect) {
                if (files.length === 0) {
                    fileSelect.innerHTML = '<option disabled>No files found.</option>';
                } else {
                    fileSelect.innerHTML = files.map(f => `<option value="${f}">${f}</option>`).join('');
                }
            }
        } catch (err) {
            if (logs) logs.innerText = 'Failed to load files: ' + err.message;
        }
    }

    if (uploadInput) uploadInput.addEventListener('change', async (e) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        const headers = await getAuthHeaders();
        if (!headers.Authorization) {
            alert("Please login to upload files.");
            e.target.value = '';
            return;
        }

        const formData = new FormData();
        for (let i = 0; i < files.length; i++) formData.append('htmlFiles', files[i]);

        try {
            const res = await fetch('/upload', {
                method: 'POST',
                headers: headers, // Fetch will automatically add Content-Type: multipart/form-data boundary
                body: formData
            });

            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            appendLog(`Uploaded ${data.filenames.length} file(s).`);
            await loadFiles();
            if (fileSelect) {
                const options = Array.from(fileSelect.options);
                options.forEach(opt => { if (data.filenames.includes(opt.value)) opt.selected = true; });
            }
        } catch (err) {
            appendLog(`Upload failed: ${err.message}`);
            e.target.value = '';
        }
    });

    if (fileSelect) fileSelect.addEventListener('change', () => {
        const selected = fileSelect.value;
        if (selected && previewFrame) previewFrame.src = `/previews/${selected}`;
    });

    // Select All button handler
    const selectAllBtn = document.getElementById('selectAllBtn');
    if (selectAllBtn) selectAllBtn.onclick = () => {
        if (!fileSelect) return;
        const options = Array.from(fileSelect.options);
        options.forEach(opt => {
            if (!opt.disabled) opt.selected = true;
        });
        // Trigger change event to update preview
        const firstSelected = fileSelect.options[0];
        if (firstSelected && !firstSelected.disabled && previewFrame) previewFrame.src = `/previews/${firstSelected.value}`;
        appendLog(`Selected all files`);
    };

    // Delete Selected button handler
    const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
    if (deleteSelectedBtn) deleteSelectedBtn.onclick = async () => {
        if (!fileSelect) return;
        const selectedOptions = Array.from(fileSelect.selectedOptions).filter(opt => !opt.disabled);
        if (selectedOptions.length === 0) {
            alert('Please select at least one file to delete');
            return;
        }

        const headers = await getAuthHeaders();
        if (!headers.Authorization) {
            alert("Please login to delete files.");
            return;
        }

        const confirmMsg = `Delete ${selectedOptions.length} file(s)?`;
        if (!confirm(confirmMsg)) return;

        const filenames = selectedOptions.map(opt => opt.value);
        let successCount = 0;
        let failCount = 0;

        for (const filename of filenames) {
            try {
                const res = await fetch(`/files/${encodeURIComponent(filename)}`, {
                    method: 'DELETE',
                    headers: headers
                });
                if (res.ok) {
                    successCount++;
                } else {
                    failCount++;
                    console.error(`Failed to delete ${filename}: ${await res.text()}`);
                }
            } catch (err) {
                failCount++;
                console.error(`Error deleting ${filename}:`, err);
            }
        }

        appendLog(`Deleted ${successCount} file(s)${failCount > 0 ? `, ${failCount} failed` : ''}`);
        await loadFiles(); // Refresh file list
        if (previewFrame) previewFrame.src = ''; // Clear preview
    };

    const runConversion = async (filename) => {
        if (isCancelled) return;
        if (!currentUser) {
            alert("Please login to convert files.");
            appendLog('[Auth] Conversion blocked: User not logged in.');
            return;
        }
        await loadProfile();
        const estimatedCost = calculateCost();

        if (userProfile.tier !== 'pro' && userProfile.credits < estimatedCost) {
            appendLog(`[Auth] Blocked: Job costs ${estimatedCost} credits, but you have ${userProfile.credits}.`);
            openPricing();
            return;
        }
        const { data: { session } } = await supabase.auth.getSession();
        const token = session ? session.access_token : '';

        return new Promise((resolve) => {
            let jobSuccess = false;
            appendLog(`Starting conversion for ${filename}...`);
            const resolution = document.getElementById('resolution') ? document.getElementById('resolution').value.split('x') : ['1920', '1080'];
            const width = resolution[0];
            const height = resolution[1];
            const fps = document.getElementById('fps') ? document.getElementById('fps').value : '30';
            const duration = document.getElementById('duration') ? document.getElementById('duration').value : '5';
            const format = document.getElementById('format') ? document.getElementById('format').value : 'mp4';

            const url = `/convert?filename=${filename}&width=${width}&height=${height}&fps=${fps}&duration=${duration}&format=${format}&token=${token}`;
            currentEvtSource = new EventSource(url);

            currentEvtSource.addEventListener('log', (e) => appendLog(JSON.parse(e.data)));
            currentEvtSource.addEventListener('done', async (e) => {
                jobSuccess = true;
                const data = JSON.parse(e.data);
                if (data.code === 0) {
                    if (userProfile.tier !== 'pro') {
                        await loadProfile();
                        updateAuthUI();
                    }
                    appendLog(`[${filename}] Finished successfully.`);

                    // Download Link Logic
                    const ext = (document.getElementById('format') ? document.getElementById('format').value : 'mp4') === 'prores' ? 'mov' : (document.getElementById('format') ? document.getElementById('format').value : 'mp4');
                    const outName = filename.replace('.html', `.${ext}`);
                    const link = document.createElement('a');
                    // Use secure endpoint with token
                    link.href = `/download/${outName}?token=${token}`;
                    link.target = "_blank"; // Open in new tab
                    const displayName = outName.length > 37 ? outName.substring(37) : outName;
                    link.textContent = `Download ${displayName}`;
                    link.className = 'download-link';
                    link.style.display = 'inline-block';
                    link.style.marginTop = '5px';
                    link.style.padding = '5px 10px';
                    link.style.background = '#28a745';
                    link.style.color = '#fff';
                    link.style.borderRadius = '4px';
                    link.style.textDecoration = 'none';
                    if (logs) {
                        logs.appendChild(link);
                        logs.scrollTop = logs.scrollHeight;
                    }
                } else {
                    appendLog(`[${filename}] Exited with code ${data.code}`);
                }
                currentEvtSource.close();
                resolve();
            });
            currentEvtSource.onerror = (_err) => {
                if (!isCancelled && !jobSuccess) appendLog(`[${filename}] Connection failed.`);
                if (currentEvtSource) currentEvtSource.close();
                resolve();
            };
        });
    };

    if (convertBtn) convertBtn.addEventListener('click', async () => {
        const selectedOptions = fileSelect ? Array.from(fileSelect.selectedOptions) : [];
        if (selectedOptions.length === 0) return alert('Please select at least one file');
        const filenames = selectedOptions.map(opt => opt.value);

        if (convertBtn) {
            convertBtn.disabled = true;
            convertBtn.style.display = 'none';
        }
        if (cancelBtn) cancelBtn.style.display = 'block';
        if (statusIndicator) statusIndicator.className = 'status-indicator active';
        if (logs) logs.innerHTML = '';
        isCancelled = false;

        if (cancelBtn) cancelBtn.onclick = () => {
            isCancelled = true;
            if (currentEvtSource) {
                currentEvtSource.close();
                appendLog('[Cancelled] Job stopped by user.');
            }
        };

        for (let i = 0; i < filenames.length; i++) {
            if (isCancelled) break;
            appendLog(`--- Batch Job ${i + 1}/${filenames.length} ---`);
            await runConversion(filenames[i]);
        }

        if (isCancelled) appendLog('Batch cycle cancelled.');
        else appendLog('Batch conversion cycle finished.');

        if (convertBtn) {
            convertBtn.disabled = false;
            convertBtn.style.display = 'block';
        }
        if (cancelBtn) cancelBtn.style.display = 'none';
        if (statusIndicator) statusIndicator.className = 'status-indicator';
    });

    // Persistence Logic
    const settings = ['format', 'resolution', 'fps', 'duration'];

    // Load settings
    settings.forEach(id => {
        const saved = localStorage.getItem(id);
        const element = document.getElementById(id);
        if (saved && element) element.value = saved;
    });

    // Save settings on change
    settings.forEach(id => {
        const element = document.getElementById(id);
        if (element) {
            element.addEventListener('change', (e) => {
                localStorage.setItem(id, e.target.value);
            });
        }
    });

    // --- COST ESTIMATION LOGIC ---
    function calculateCost() {
        let cost = 1;
        const resVal = document.getElementById('resolution').value;
        const fpsVal = parseInt(document.getElementById('fps').value);
        const durVal = parseInt(document.getElementById('duration').value);
        const fmtVal = document.getElementById('format').value;

        // 1. Resolution
        const [w, h] = resVal.split('x').map(Number);
        if (w > 1920 || h > 1080) cost += 3;

        // 2. FPS
        if (fpsVal > 30) cost += 1;

        // 3. Duration
        if (durVal > 10) {
            cost += Math.ceil((durVal - 10) / 10);
        }

        // 4. Format
        if (fmtVal === 'prores') cost += 2;

        return cost;
    }

    function updateCostUI() {
        const cost = calculateCost();
        const badge = document.getElementById('costBadge');
        if (badge) {
            badge.textContent = `${cost} Credit${cost > 1 ? 's' : ''}`;

            // Highlight if expensive or unavailable
            if (userProfile && userProfile.tier !== 'pro') {
                if (cost > userProfile.credits) {
                    badge.style.background = '#d73a49'; // Red
                    badge.style.color = 'white';
                    badge.textContent += ' (Not enough)';
                } else if (cost >= 4) {
                    badge.style.background = '#d29922'; // Orange/Gold
                    badge.style.color = 'black';
                } else {
                    badge.style.background = 'var(--border)';
                    badge.style.color = 'var(--text)';
                }
            } else if (userProfile && userProfile.tier === 'pro') {
                badge.style.background = '#2ea043'; // Green
                badge.textContent = 'FREE (Pro)';
                badge.style.color = 'white';
            }
        }
    }

    // Attach listeners to calculation inputs
    ['resolution', 'fps', 'duration', 'format'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', updateCostUI);
        if (el && id === 'duration') el.addEventListener('input', updateCostUI); // Real-time slider/typing
    });

    // Also update on profile load
    const originalLoadProfile = loadProfile;
    loadProfile = async () => {
        await originalLoadProfile();
        updateCostUI();
    };

    // --- JOBS & DOWNLOADS ---
    const jobsPanel = document.getElementById('jobsPanel');
    const jobsList = document.getElementById('jobsList');
    const refreshJobsBtn = document.getElementById('refreshJobsBtn');

    // removed downloadAllBtn logic

    async function loadJobs() {
        if (!currentUser) {
            if (jobsPanel) jobsPanel.style.display = 'none';
            return;
        }
        if (jobsPanel) jobsPanel.style.display = 'block';
        if (jobsList) jobsList.innerHTML = '<div style="font-size:0.8rem; color:#888;">Loading...</div>';

        try {
            const headers = await getAuthHeaders();
            const res = await fetch('/jobs', { headers });
            if (!res.ok) throw new Error('Failed to load jobs');
            const jobs = await res.json();

            if (jobsList) {
                if (jobs.length === 0) {
                    jobsList.innerHTML = '<div style="font-size:0.8rem; color:#888;">No recent conversions.</div>';
                } else {
                    const { data: { session } } = await supabase.auth.getSession();
                    const token = session?.access_token;

                    jobsList.innerHTML = jobs.map(job => {
                        const date = new Date(job.created_at).toLocaleString();
                        const displayName = job.output_filename.length > 37 ? job.output_filename.substring(37) : job.output_filename;
                        return `
                        <div style="display:flex; justify-content:space-between; align-items:center; background:var(--bg); padding:0.5rem; border-radius:4px; font-size:0.85rem;">
                            <div>
                                <div style="font-weight:bold;">${displayName}</div>
                                <div style="font-size:0.75rem; color:#888;">${date}</div>
                            </div>
                            <a href="/download/${job.output_filename}?token=${token}"  
                               target="_blank"
                               class="btn-small" 
                               style="text-decoration:none; background:#238636; color:white; padding: 4px 10px;">
                               Download
                            </a>
                        </div>`;
                    }).join('');
                }
            }

        } catch (e) {
            console.error(e);
            if (jobsList) jobsList.innerHTML = '<div style="color:red; font-size:0.8rem;">Error loading jobs.</div>';
        }
    }

    if (refreshJobsBtn) refreshJobsBtn.onclick = loadJobs;

    // Init
    loadFiles();
    refreshSession();
    // loadJobs will be called by refreshSession -> updateAuthUI or explicitly here if needed, 
    // but updateAuthUI is purely UI. Let's hook into refreshSession or just call it.
    // actually better to call it when auth state is confirmed.

    // Override refreshSession to call loadJobs
    const originalRefreshSession = refreshSession;
    refreshSession = async () => {
        await originalRefreshSession();
        if (currentUser) loadJobs();
    };
}

// AGGRESSIVE INITIALIZATION - Multiple fallback mechanisms to ensure app always runs
let initialized = false;

function safeInitialize() {
    if (initialized) return;
    initialized = true;
    console.log('[App] Safe Initialize triggered');
    initializeApp();
}

// Method 1: Standard readyState check
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeInitialize);
} else {
    safeInitialize();
}

// Method 2: Fallback - always try after a short delay
setTimeout(() => {
    if (!initialized) {
        console.log('[App] Fallback timer initialization');
        safeInitialize();
    }
}, 100);

// Method 3: Nuclear option - ensure it runs after load event
window.addEventListener('load', () => {
    if (!initialized) {
        console.log('[App] Load event fallback');
        safeInitialize();
    }
});
