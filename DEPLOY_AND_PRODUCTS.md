# LoversGift — Complete Deployment Guide
# How to publish for free + how to add products

═══════════════════════════════════════════════════════════
  PART 1 — PUBLISH THE FRONTEND (free, 5 minutes)
═══════════════════════════════════════════════════════════

The frontend is a single HTML file. Host it for free on Netlify.

STEP 1 — Create a GitHub account (free)
  → https://github.com

STEP 2 — Create a new repository called "loversgift"
  → Click "New repository" → name it "loversgift" → Create

STEP 3 — Upload your file
  → Click "uploading an existing file"
  → Drag in your loversgift.html file
  → Rename it to index.html (GitHub needs this name)
  → Click "Commit changes"

STEP 4 — Deploy on Netlify (free forever)
  → Go to https://netlify.com → Sign up with GitHub
  → Click "Add new site" → "Import an existing project"
  → Choose GitHub → select your "loversgift" repo
  → Click "Deploy site"
  → Your site is LIVE at a URL like: https://sparkly-muffin-123.netlify.app

STEP 5 — Get a free custom subdomain
  → In Netlify: Site settings → Domain management → Options
  → Change site name to "loversgift" (or whatever is available)
  → Your URL becomes: https://loversgift.netlify.app

OPTIONAL — Buy the real domain (about $10/year)
  → Buy "loversgift.io" from https://porkbun.com (cheapest)
  → In Netlify: Add custom domain → enter loversgift.io
  → Follow the DNS instructions Netlify gives you
  → Done in about 10 minutes


═══════════════════════════════════════════════════════════
  PART 2 — DEPLOY THE BACKEND (free on Railway)
═══════════════════════════════════════════════════════════

Railway gives you $5 free credit per month — enough for a small
app with low traffic. No credit card required to start.

STEP 1 — Push backend to GitHub
  → Create a new repo called "loversgift-backend"
  → Upload all the backend files
     (server.js, package.json, routes/, db/, middleware/, .gitignore)
  → DO NOT upload .env or loversgift.db

STEP 2 — Deploy on Railway
  → Go to https://railway.app → Sign in with GitHub
  → Click "New Project" → "Deploy from GitHub repo"
  → Select "loversgift-backend"
  → Railway auto-detects Node.js and deploys ✅

STEP 3 — Add environment variables in Railway
  → Go to your project → Variables tab → Add these:

    ADMIN_PASSWORD    = pick_a_strong_password_here
    BASE_URL          = https://your-app.railway.app
    NODE_ENV          = production
    GIFT_EXPIRY_HOURS = 24
    MAX_UPLOAD_MB     = 5
    FRONTEND_URL      = https://loversgift.netlify.app

  → Railway auto-restarts with the new variables ✅

STEP 4 — Get your backend URL
  → In Railway: your project → Settings → Domains
  → It will look like: https://loversgift-backend.railway.app

STEP 5 — Connect frontend to backend
  → Open your index.html
  → Find the line that says:
      const API_BASE = 'http://localhost:3000';   (you'll add this)
  → Change it to your Railway URL:
      const API_BASE = 'https://loversgift-backend.railway.app';
  → Re-upload to GitHub → Netlify auto-redeploys ✅

STEP 6 — Test it's working
  → Visit: https://your-app.railway.app/health
  → You should see: {"status":"ok","time":"..."}
  → Visit: https://your-app.railway.app/api/products
  → You should see your 8 default products as JSON ✅


═══════════════════════════════════════════════════════════
  PART 3 — HOW TO ADD NEW PRODUCTS
═══════════════════════════════════════════════════════════

You have TWO ways to add products. Use whichever feels easier.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  WAY A — Via the Admin API (recommended, no code needed)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Send a POST request with this tool (use any of these):
  • Postman (app) — free and easy
  • Insomnia (app) — free
  • curl in your terminal
  • Any REST client

EXAMPLE — Adding a new product called "Love Playlist":

  Method: POST
  URL:    https://your-app.railway.app/api/admin/products
  Header: Authorization: Bearer YOUR_ADMIN_PASSWORD
  Body (JSON):
  {
    "slug":        "love-playlist",
    "title":       "Love Playlist",
    "category":    "love",
    "emoji":       "🎧",
    "bgGradient":  "linear-gradient(135deg,#0A0A1A,#1A0A2E)",
    "description": "A curated playlist page with your song choices and a message for each one.",
    "priceCents":  499,
    "badge":       "new",
    "badgeLabel":  "✨ New",
    "stars":       5,
    "reviewCount": 0,
    "features":    [
      "Up to 10 songs",
      "Personal note per song",
      "Spotify links",
      "Dark romantic theme",
      "Shareable link"
    ],
    "sortOrder":   9
  }

  Response: { "product": { "id": 9, "slug": "love-playlist", ... } }
  → Product is INSTANTLY live on your marketplace ✅

CATEGORIES you can use:
  love | birthday | anniversary | surprise | free

PRICE examples:
  priceCents: 0    → shows as "Free"
  priceCents: 299  → shows as "$2.99"
  priceCents: 499  → shows as "$4.99"
  priceCents: 999  → shows as "$9.99"

BADGE options:
  "new"  + "✨ New"
  "hot"  + "🔥 Popular"
  "free" + "Free"
  null   + null   (no badge)


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  WAY B — Edit the database seed file directly
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Open: db/database.js
Find the seedProducts() function (around line 60).
Copy one of the existing product blocks and edit it.
Push to GitHub → Railway redeploys automatically.

NOTE: The seed only runs when the database is EMPTY.
If the database already has products, re-seeding won't work.
Use Way A for adding products after first launch.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  MANAGING EXISTING PRODUCTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Update a product (change price, badge, description, etc.):
  Method: PATCH
  URL:    https://your-app.railway.app/api/admin/products/1
  Header: Authorization: Bearer YOUR_ADMIN_PASSWORD
  Body (JSON — send ONLY what you want to change):
  {
    "priceCents": 399,
    "badge": "hot",
    "badgeLabel": "🔥 Popular"
  }

Hide a product from the marketplace (soft delete):
  Method: DELETE
  URL:    https://your-app.railway.app/api/admin/products/1
  Header: Authorization: Bearer YOUR_ADMIN_PASSWORD
  → Product is hidden but existing gift links still work ✅

View all products (including hidden ones):
  Method: GET
  URL:    https://your-app.railway.app/api/admin/products/admin/all
  Header: Authorization: Bearer YOUR_ADMIN_PASSWORD


═══════════════════════════════════════════════════════════
  PART 4 — ADMIN DASHBOARD ENDPOINTS
═══════════════════════════════════════════════════════════

All require: Authorization: Bearer YOUR_ADMIN_PASSWORD

GET /api/admin/stats
  → Total gifts created, active gifts, views today, top products

GET /api/admin/gifts
  → All active (non-expired) gifts with view counts

GET /api/admin/products/admin/all
  → All products including hidden ones

GET /api/products
  → Public product list (what customers see)

GET /api/gifts/:code
  → Fetch a specific gift by its share code


═══════════════════════════════════════════════════════════
  PART 5 — RUNNING LOCALLY FOR TESTING
═══════════════════════════════════════════════════════════

1. Install Node.js from https://nodejs.org (choose LTS version)

2. Open a terminal and run:
   cd loversgift-backend
   cp .env.example .env
   # Edit .env and set your ADMIN_PASSWORD
   npm install
   npm start

3. Backend runs at: http://localhost:3000

4. Test it:
   curl http://localhost:3000/api/products
   → Should show your 8 products as JSON

5. Create a test gift:
   curl -X POST http://localhost:3000/api/gifts \
     -H "Content-Type: application/json" \
     -d '{"senderName":"Marco","receiverName":"Sofia","message":"I love you"}'
   → Returns { "gift": { "code": "abc123", "shareUrl": "..." } }


═══════════════════════════════════════════════════════════
  QUICK REFERENCE — PRODUCT IDEAS TO ADD LATER
═══════════════════════════════════════════════════════════

Here are product ideas ready to add when you expand:

slug: "virtual-date-night"      category: surprise    price: $5.99
slug: "love-jar-digital"        category: love        price: $4.99
slug: "apology-letter"          category: love        price: $3.99
slug: "miss-you-page"           category: surprise    price: $3.49
slug: "anniversary-countdown"   category: anniversary price: $4.49
slug: "couple-bucket-list"      category: anniversary price: $6.99
slug: "good-morning-surprise"   category: love        price: $2.99
slug: "valentines-card"         category: love        price: $3.99
slug: "proposal-page"           category: anniversary price: $9.99  ← premium
slug: "photo-memory-book"       category: anniversary price: $7.99
slug: "love-story-page"         category: love        price: $5.49
slug: "long-distance-kit"       category: surprise    price: $8.99  ← bundle

Add them all in one go via the API when you're ready.
