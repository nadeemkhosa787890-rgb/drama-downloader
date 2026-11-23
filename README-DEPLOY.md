# Drama Downloader — Deployment Guide

This folder is the standalone, ready-to-publish copy of your Drama Downloader
(the same tool as the one in Muse, rebuilt so it can live on the public web).
It needs no database and no paid services to run.

Files:
- `server.js` — the server (pure Node.js, zero dependencies)
- `public/index.html` — the pink web app (Bright/Dark modes, per-episode
  progress bars, "Title Ep NN" file names, 9:16 thumbnails, episode
  combining, Teal & Orange colour grade)
- `Dockerfile` — Docker image with ffmpeg (needed for Combine + grade)
- `package.json` — tells the host how to start it (`node server.js`)

## Combine + Teal & Orange grade — ffmpeg is required

New in v1.1: **Combine** (2–10 episodes into one video, max 300 MB) and a
**Teal & Orange colour grade** (Off / Subtle / Classic / Strong, remembered
in the browser) that is baked into single-episode and combined downloads.

Both features are processed **on the server with ffmpeg + ffprobe**.
That changes the hosting requirements — please read this before deploying:

- **The plain Node service on Render does NOT include ffmpeg.**
  If you deploy with Runtime = Node and no ffmpeg, the app still starts,
  resolving and plain (grade Off) downloads keep working, but Combine and
  grading return a clear error: *"This server does not have ffmpeg
  installed…"*. Nothing fails silently.
- **Recommended: deploy with Docker.** This folder includes a `Dockerfile`
  (Node 20 + ffmpeg). In Render: New → Web Service → connect the repo →
  Runtime = **Docker** (Render detects the Dockerfile automatically).
  Build Command: leave empty. Start Command: `node server.js`.
  That is the only setup that guarantees ffmpeg is present.
- Alternative: a community ffmpeg buildpack (for example
  `jonathanong/heroku-buildpack-ffmpeg`) if you deploy with buildpacks
  instead of Docker. Not tested on Render — Docker is the supported path.
- Grading re-encodes the video (H.264, CRF 21, AAC) — it takes roughly
  real time to a few times real time depending on the host CPU, and the
  server processes one grading/combine job at a time (later jobs queue).
  With the grade Off, downloads stay the untouched originals on the fast
  pass-through path — nothing is re-encoded.
- Combine joins episodes in order. Episodes at the same resolution join
  with a fast stream-copy (no re-encode). If episodes have different
  resolutions, the join is re-encoded down to the **lowest** episode's
  resolution so the result is one valid video — the panel says this
  honestly. The combined file is named "Title Ep 01-05 Combined.mp4"
  (with " (Teal & Orange)" added when a grade is on).
- Combined and graded files are temporary: they are kept on the server
  for 1 hour so the download link works, then deleted automatically.
  (This is the one exception to "the app does not store videos" below.)

---

## Step 1 — Put it on a host (free to start)

Easiest: **Render** (render.com)

1. Create a free account at render.com (sign up with Google or email).
2. Put this folder into a free GitHub account first (github.com → New
   repository → upload all files in this folder), OR use Render's
   "Deploy from Git" after pushing.
3. In Render: **New → Web Service** → connect the repository.
4. Settings: Runtime = **Docker** (recommended — this folder's Dockerfile
   installs ffmpeg, which Combine and the Teal & Orange grade need).
   If you choose Runtime = Node instead, leave the Build Command empty and
   use Start Command `node server.js` — but then Combine and grading will
   be disabled (see the ffmpeg section above). Pick the Free plan.
5. Click **Create Web Service**. After a few minutes Render gives you a live
   address like `https://drama-downloader-xxxx.onrender.com`.
6. Open it and test with a real PineDrama/TikTok drama link.

Alternatives with the same steps: Railway (railway.app) or a small VPS.
Note: free plans sleep when idle — the first visit after a quiet period can
take ~30 seconds to wake. A paid plan (~$7/mo) removes the sleep.

## Step 2 — Buy and connect your domain

1. Buy a domain at Cloudflare Registrar or Namecheap (about $10–15/year).
2. In Render: your service → **Settings → Custom Domains → Add** your domain.
3. Render shows DNS records; add them where you bought the domain
   (Cloudflare/Namecheap DNS page). HTTPS turns on automatically.
4. Wait for DNS (usually minutes, sometimes a few hours). Your tool is now
   live at your own name.

## Step 3 — Get it listed on Google

1. Go to **Google Search Console** (search.google.com/search-console) and
   sign in with your Google account.
2. **Add property** → enter your full domain address → verify ownership
   (the DNS TXT record method is easiest; Search Console shows the record
   to paste at your registrar).
3. In Search Console: **URL Inspection** → paste your homepage → **Request
   Indexing**.
4. Also submit a sitemap if you add pages later (your homepage alone is
   enough to start).
5. Google usually lists a new site within a few days to two weeks. Search
   your site name to check.

## Editing your app yourself — the /admin page

You never need to touch code for everyday changes:

1. Open **yourdomain.com/admin** in your browser.
2. Type the admin password. Default is `changeme123` — change it on your
   host: in Render, open your service → **Environment** → add
   `ADMIN_PASSWORD` with your own password → save (the app restarts).
3. Change what you like and press **Save all settings**:
   - App name and tagline
   - Logo (upload any PNG/JPG/SVG — replaces the pink logo instantly)
   - Theme colors (main pink + light pink, picked from a color box)
   - First-visit mode (Dark or Bright)
   - Homepage heading, text, and footer wording
   - Show/hide buttons: episode Thumbnail button, Download Full Series
     button, and the select / Download selected bar

Settings are saved on the server in `settings.json`. One caution: Render's
free plan wipes saved files when the service restarts or redeploys, so your
settings can reset there. A paid plan with a persistent disk — or simply
re-saving after a redeploy — avoids it.

## Honest notes

- The resolver uses the same public resolver services the original sites
  rely on. If those services are blocked or shut down, resolving stops until
  they recover — this is true for dramasave.app too.
- Private, paid, or region-locked episodes may not resolve.
- Drama-download sites can receive copyright complaints; Google may remove
  pages from search results. Keep the "personal offline viewing" wording on
  the page (already included) and never host the videos yourself — this app
  does not store any video; it only passes files through at download time.
- Episode quality depends on what the source serves; the app always picks
  the largest file the resolvers return for each episode.
