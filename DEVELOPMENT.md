# HTML to MP4 Converter - Development Guide

## 📊 Project Status
**Current Phase**: Pre-Launch / Monetization Setup
**Goal**: Prepare for public launch with SEO optimization and Stripe payment integration.

## ✅ To-Do List

### 🚀 Launch Readiness (Immediate Focus)
- [ ] **SEO Setup**
  - [ ] Add Meta Tags (Title, Description, OpenGraph, Twitter Card) to `index.html`.
  - [ ] Add JSON-LD Structured Data (SoftwareApplication).
  - [ ] Create `robots.txt`.
  - [ ] Create `sitemap.xml`.
- [ ] **Monetization (Stripe)**
  - [ ] Install Stripe dependencies.
  - [ ] Backend: Create Checkout Session & Webhook endpoints.
  - [ ] Frontend: Connect "Buy Credits" button to Stripe.
- [ ] **Deployment**
  - [ ] Create `Dockerfile` (Node.js + Puppeteer + Chrome + FFmpeg).
  - [ ] Setup production environment variables.

### 🔮 Future / Maintenance
- [ ] Admin Dashboard for monitoring jobs.
- [ ] User Email verification (Supabase).
- [ ] Advanced job queue management (Redis implementation if scale increases).

## 📘 Guides

### 🏃 How to Run Locally

#### Starting the Server
1.  **Open Terminal**: Navigate to the project folder.
2.  **Install Dependencies** (First time only):
    ```bash
    npm install
    # If using PowerShell and you get policy errors:
    # Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
    ```
3.  **Start the App**:
    ```bash
    node server.js
    ```
    *Note: We use `node server.js` directly to avoid PowerShell script execution policy issues with `npm start`.*

4.  **Verify**:
    -   Server will say: `Server running at http://localhost:3000`
    -   Open your browser to: [http://localhost:3000](http://localhost:3000)

#### Stopping the Server
1.  **Click inside the terminal** where the server is running.
2.  Press `Ctrl + C` on your keyboard.
3.  Type `y` (if prompted) and press `Enter`.
4.  **Force Kill (If stuck)**:
    -   If the port 3000 is still in use ("address already in use" error):
    ```powershell
    # Find the process ID (PID)
    netstat -ano | findstr :3000
    # Kill it (replace 1234 with the PID found above)
    taskkill /PID 1234 /F
    ```

### 🚢 Deployment Strategy
We use **Docker** because the app requires system-level dependencies (`ffmpeg`, `chrome`).
*   **Domain**: `htmltomp4.com` (Cloudflare).
*   **Hosting**: Any provider that supports Docker (Render, Railway, Fly.io, or VPS).
*   **Build Command**:
    ```bash
    docker build -t htmlhub .
    ```

## ❓ FAQ

**Q: Why can't we use Vercel/Netlify functions?**
A: Vercel functions have size limits (usually ~50MB) and execution time limits (10s). Puppeteer/Chrome is ~300MB+ and video rendering takes minutes, so a long-running server (Docker container) is required.

**Q: How do credits work?**
A: Credits are stored in the Supabase `profiles` table. When a user buys a pack via Stripe, the webhook listens for the success event and adds credits to their account securely on the backend.

**Q: Where are files stored?**
A:
*   **Input**: `html_files/` (Uploaded by user).
*   **Output**: `output/` (Rendered videos).
*   **Note**: In a production Docker environment with ephemeral file systems (like Render), these files will disappear on restart unless we mount a persistent volume (e.g., AWS S3 or a persistent disk). *To be implemented for production.*
