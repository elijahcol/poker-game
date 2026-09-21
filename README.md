# ♛ ROYALE POKER — Realtime Multiplayer VIP Lounge

Texas Hold'em for **2–9 real online players per table**: name entry, bento lobby,
radial VIP table, tactile HUD (Fold / Check-Call / raise slider + ½Pot·Pot·Max·All-In),
table chat, hand history, fair side-pots and split pots.

## How it plays
1. Open the site, **enter your alias** → Enter Lounge
2. Lobby shows **🟢 online players** and **🃏 active tables** (blinds, seats, host)
3. **Open a table** (pick stakes: Lounge 10/20, High Rollers 25/50, Blitz 50/100)
   or **Join** from the list / 6-letter code
4. Share the **CODE** with friends — they join mid-hand and are dealt in next hand
5. Host clicks **▶ Start hand**. Hands auto-deal. 9s showdown pause.
6. 60s turns with countdown (auto fold/check), broke players auto-rebuy to 1,000.

Fair pots: contributions tracked per-hand, side-pots by contribution level, ties split
evenly (odd chips left-of-dealer), leavers' bets stay in the pot.

## Run locally + test
```bash
cd poker-game
npm install
npm start          # open http://localhost:3000
npm test           # 74 engine + live multiplayer tests
```

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
