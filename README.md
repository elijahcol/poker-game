# ♠ Hold'em Nights — Realtime Multiplayer Poker

Texas Hold'em for **2–4 real online players per table**, with name entry, lobby, table codes, fair side-pots and split pots.

## How it plays
1. Open the site, **enter your name** → Join lobby
2. You see **🟢 Online players** and **🃏 Tables**
3. **Create a table** (you're host) or **Join** with code / list
4. Share the 6-letter **CODE** with up to 3 friends — they enter name → Join by code
5. Host clicks **▶ Start hand**. Next hands auto-deal. 9s showdown pause.
6. Blinds 10/20, 1000 chips, 60s turn timer (auto fold/check).

Fair pots: contributions tracked per-hand, side-pots built by contribution levels, ties split evenly with odd chips going left-of-dealer first.

## Run locally
```bash
cd poker-game
npm install
npm start
# open http://localhost:3000
```
Open 2–4 browser windows/tabs to test multiplayer.

## Push to GitHub
```bash
cd poker-game
git init
git add .
git commit -m "Realtime poker game"
git branch -M main
git remote add origin https://github.com/YOURUSERNAME/poker-game.git
git push -u origin main
```

## Deploy on Vercel + Render (recommended for realtime)

Vercel alone can't run this game server — it's serverless with no persistent
WebSocket connections, so tables would disconnect. Split it:

1. **Backend (game server) → Render free:**
   Dashboard → New Web Service → pick this repo →
   Build `npm install`, Start `npm start`.
   You'll get e.g. `https://poker-game-xxxx.onrender.com`
2. **Frontend → Vercel:**
   - In `public/config.js` set:
     `window.BACKEND_URL = "https://poker-game-xxxx.onrender.com";`
     commit + push.
   - Go to https://vercel.com/new → Import `elijahcol/poker-game` →
     Framework: Other, Output Directory: `public`, Build: none → Deploy.
   - Share the `https://poker-game-xxx.vercel.app` URL with friends.
   - Local dev still works with `BACKEND_URL = ""` (same origin).

## Deploy backend-only on Render (free)
1. Push to GitHub as above
2. Go to https://dashboard.render.com → **New + → Web Service**
3. Select your `poker-game` repo
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - Environment: `Node`
   - `render.yaml` in repo already sets this up — you can also click **New + → Blueprint** and pick the repo
5. Deploy → you get `https://poker-game-xxxx.onrender.com` to share with friends

No database needed. Note: free Render sleeps when idle — first load takes ~30s to wake.
