# codex queue

A tiny booking site for four people sharing one Codex account: Sanchay, Hars, Assank, Abinov.

- See who is on Codex right now, with a live countdown (the tab title shows it too)
- Book "right now" or schedule a slot (30m to 5h), clashes are blocked
- **Limit hit** button: tells everyone the 5h limit is burned and when it resets, and blocks bookings until then
- **Log usage**: after a session, say how much % of the 5h window you ate. The home bar shows what's left, and if the total reaches 100% it flips to "limit hit" automatically (ending a session prompts you for this)
- Timeline of the day, queue, and a 7 day leaderboard (hours used, limit burns)
- No logins: you tap your name once and it is remembered in your browser

No build step, it is plain HTML/CSS/JS.

## 1. Set up the shared database (2 minutes, free)

GitHub Pages only serves static files, so the bookings need somewhere shared to live.
Without this step the site works, but each person only sees their own bookings ("local only" badge).

1. Go to https://console.firebase.google.com and create a project (disable Google Analytics, it is not needed).
2. **Build → Realtime Database → Create Database**, pick any location, start in **test mode**.
3. Open the **Rules** tab and paste this, then **Publish** (test mode expires after 30 days, this keeps it working):
   ```json
   {
     "rules": {
       "queue": { ".read": true, ".write": true },
       ".read": false,
       ".write": false
     }
   }
   ```
4. Copy the database URL shown at the top of the **Data** tab (looks like `https://xxxx-default-rtdb.firebaseio.com`).
5. Paste it into [config.js](config.js) as `databaseURL`.

Anyone who knows your site URL can technically write to the database. For a private friend group that is fine; just don't share the link around.

## 2. Deploy on GitHub Pages

```bash
git init
git add .
git commit -m "codex queue"
git branch -M main
git remote add origin https://github.com/<you>/codex-queue.git
git push -u origin main
```

Then in the repo: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`**.
Your site will be at `https://<you>.github.io/codex-queue/`. Share that link in the group chat.

## Run locally

```bash
python3 -m http.server 8000
```

Open http://localhost:8000.
