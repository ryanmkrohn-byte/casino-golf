# Casino Golf — Standalone App

Golf betting app (Casino format) as a deployable Progressive Web App.
Works on iPhone, Android, and desktop — no Claude app required.

## Why this exists

The Claude artifact version hit two platform limits on mobile:
CORS blocking on the golf course API, and no AI-API bridge in the mobile app.
This standalone version fixes both with a serverless proxy — the golf course
API is called server-side where CORS doesn't apply and the API key stays secret.

## Deploy to Vercel (free, ~10 minutes)

### One-time setup

1. **Create a GitHub account** (if you don't have one) at github.com
2. **Create a Vercel account** at vercel.com — sign in with GitHub
3. **Push this folder to a new GitHub repo:**
   ```bash
   cd casino-golf-app
   git init
   git add .
   git commit -m "Casino Golf v1"
   # Create a repo named casino-golf on github.com, then:
   git remote add origin https://github.com/YOUR_USERNAME/casino-golf.git
   git push -u origin main
   ```
4. **Import to Vercel:** vercel.com → Add New → Project → select your
   `casino-golf` repo → Deploy (defaults are fine, Vercel auto-detects Vite)
5. **Add your API key:** Project → Settings → Environment Variables →
   Add `GOLF_API_KEY` = your key from golfcourseapi.com → Save →
   Deployments → Redeploy

   ⚠️ Regenerate your key at golfcourseapi.com first if it was ever
   shared in a chat or committed to code.

### Result

Vercel gives you a URL like `https://casino-golf-xyz.vercel.app`.

**On your iPhone:** open the URL in Safari → Share → Add to Home Screen.
It now launches full-screen like a native app, with its own icon.

## Local development

```bash
npm install
npm run dev          # UI at localhost:5173 (course search needs deploy or `vercel dev`)
```

To test the serverless function locally, install the Vercel CLI and run
`vercel dev` instead — it serves both the app and /api/golf.

## Architecture

```
Browser (React PWA)
   │
   ├── /api/golf?path=search&q=...     ─┐
   ├── /api/golf?path=course&id=...     ├─ Vercel serverless function
   │                                    ─┘   (holds GOLF_API_KEY, no CORS)
   │                                          │
   │                                          └──> api.golfcourseapi.com
   │
   └── localStorage  (round state, history, course config)
```

Storage note: the artifact version synced data across devices via Claude's
storage. This standalone version uses localStorage, which is **per-device**.
Rounds auto-save locally after every hole — a dead battery loses nothing —
but a round started on your phone stays on your phone.

## Feature summary

- 2–12 players, per-player handicaps with stroke-index allocation
- Dealer sets max bet; players bet up to max ($0 = sit out); double after tee shot
- Net birdie ×2 / eagle ×3 / albatross ×4 auto-multipliers
- Dealer-under-par multiplies all losses
- Automatic dealer rotation (low net score wins the deal)
- Course search with real scorecards + tee selection (par, SI, rating, slope)
- Manual par-per-hole fallback
- Edit any completed hole; full ledger recalculation
- Auto-save every hole, resume banner, round history (last 20)
- Final ledger with debt simplification ("who pays who") and share/copy results
