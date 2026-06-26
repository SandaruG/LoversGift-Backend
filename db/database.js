// db/database.js
// SQLite database — no external database server needed.
// The .db file is created automatically on first run.

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'loversgift.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL'); // faster writes
    db.pragma('foreign_keys = ON');
    setupSchema();
  }
  return db;
}

function setupSchema() {
  // ── PRODUCTS table ─────────────────────────────────────────────
  // This is your marketplace catalogue. Add as many products as you
  // want by inserting rows here (or via the admin API).
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      slug        TEXT    UNIQUE NOT NULL,   -- url-friendly id e.g. "animated-love-letter"
      title       TEXT    NOT NULL,
      category    TEXT    NOT NULL,          -- love | birthday | anniversary | surprise | free
      emoji       TEXT    NOT NULL DEFAULT '💌',
      bg_gradient TEXT    NOT NULL DEFAULT 'linear-gradient(135deg,#1C0C14,#3D1A28)',
      description TEXT    NOT NULL,
      price_cents INTEGER NOT NULL DEFAULT 0, -- 0 = free, 499 = $4.99
      badge       TEXT,                      -- null | "new" | "hot" | "free"
      badge_label TEXT,
      stars       INTEGER NOT NULL DEFAULT 5,
      review_count INTEGER NOT NULL DEFAULT 0,
      features    TEXT    NOT NULL DEFAULT '[]', -- JSON array of feature strings
      active      INTEGER NOT NULL DEFAULT 1,    -- 0 = hidden from marketplace
      sort_order  INTEGER NOT NULL DEFAULT 0,    -- lower = shown first
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ── GIFTS table ────────────────────────────────────────────────
  // Each created gift gets a row. Auto-deleted after expiry_hours.
  db.exec(`
    CREATE TABLE IF NOT EXISTS gifts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      code         TEXT UNIQUE NOT NULL,   -- the short random URL code e.g. "xK9m2pAb"
      product_id   INTEGER REFERENCES products(id),
      sender_name  TEXT NOT NULL,
      receiver_name TEXT NOT NULL,
      message      TEXT NOT NULL,
      special_date TEXT,
      theme        TEXT NOT NULL DEFAULT 'rose',
      photo_path   TEXT,                  -- relative path under /public/gifts/ if uploaded
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at   TEXT NOT NULL,         -- ISO datetime string
      view_count   INTEGER NOT NULL DEFAULT 0,
      paid         INTEGER NOT NULL DEFAULT 0  -- 0 = unpaid/free, 1 = paid
    );
  `);

  // ── SEED default products if table is empty ────────────────────
  const count = db.prepare('SELECT COUNT(*) as n FROM products').get().n;
  if (count === 0) {
    seedProducts();
  }
}

function seedProducts() {
  const insert = db.prepare(`
    INSERT INTO products
      (slug, title, category, emoji, bg_gradient, description, price_cents,
       badge, badge_label, stars, review_count, features, sort_order)
    VALUES
      (@slug, @title, @category, @emoji, @bg_gradient, @description, @price_cents,
       @badge, @badge_label, @stars, @review_count, @features, @sort_order)
  `);

  const seedMany = db.transaction((products) => {
    for (const p of products) insert.run(p);
  });

  seedMany([
    {
      slug: 'animated-love-letter',
      title: 'Animated Love Letter',
      category: 'love',
      emoji: '💌',
      bg_gradient: 'linear-gradient(135deg,#1C0C14,#3D1A28)',
      description: 'A hand-written style letter that reveals word by word, with a soft rose theme and your personal message.',
      price_cents: 499,
      badge: 'hot', badge_label: '🔥 Popular',
      stars: 5, review_count: 412,
      features: JSON.stringify(['Typewriter animation','Custom names & message','Rose or navy theme','Mobile-first design','Shareable in seconds']),
      sort_order: 1,
    },
    {
      slug: 'birthday-surprise-page',
      title: 'Birthday Surprise Page',
      category: 'birthday',
      emoji: '🎂',
      bg_gradient: 'linear-gradient(135deg,#1A0F00,#3D2800)',
      description: 'Confetti, their favourite photo, and your birthday message — waiting for them the moment they open the link.',
      price_cents: 399,
      badge: 'new', badge_label: '✨ New',
      stars: 5, review_count: 289,
      features: JSON.stringify(['Confetti animation','Photo upload support','Birthday countdown','Custom colour theme','WhatsApp-ready link']),
      sort_order: 2,
    },
    {
      slug: 'relationship-timeline',
      title: 'Relationship Timeline',
      category: 'anniversary',
      emoji: '💑',
      bg_gradient: 'linear-gradient(135deg,#0A0F1A,#1A2840)',
      description: 'A scrollable journey through your relationship — add dates, milestones, and photos for each chapter.',
      price_cents: 699,
      badge: null, badge_label: null,
      stars: 5, review_count: 178,
      features: JSON.stringify(['Unlimited milestones','Photo per milestone','Animated scroll reveal','Couples theme','Printable PDF option']),
      sort_order: 3,
    },
    {
      slug: 'open-when-letters',
      title: 'Open When Letters',
      category: 'surprise',
      emoji: '📬',
      bg_gradient: 'linear-gradient(135deg,#120A1A,#2A1040)',
      description: 'A collection of sealed letters they open for specific moments — "open when you miss me", "open when you need a laugh".',
      price_cents: 549,
      badge: null, badge_label: null,
      stars: 4, review_count: 95,
      features: JSON.stringify(['Up to 8 sealed letters','Custom trigger phrases','Reveal animation','Long-distance favourite','Mobile optimised']),
      sort_order: 4,
    },
    {
      slug: 'reasons-i-love-you',
      title: 'Reasons I Love You',
      category: 'love',
      emoji: '🌹',
      bg_gradient: 'linear-gradient(135deg,#1A0808,#3D1010)',
      description: '30 animated cards that flip one by one, each revealing a personal reason you love them.',
      price_cents: 449,
      badge: null, badge_label: null,
      stars: 5, review_count: 203,
      features: JSON.stringify(['Up to 30 reasons','Card flip animation','Custom names','4 colour themes','No sign-up needed']),
      sort_order: 5,
    },
    {
      slug: 'simple-love-note',
      title: 'Simple Love Note',
      category: 'free',
      emoji: '🌸',
      bg_gradient: 'linear-gradient(135deg,#0A1A0F,#102814)',
      description: 'A clean, beautiful note with your message and names. Free forever — the perfect way to try LoversGift.',
      price_cents: 0,
      badge: 'free', badge_label: 'Free',
      stars: 4, review_count: 1204,
      features: JSON.stringify(['Instant generation','No payment needed','Custom message','Expires in 24h','Try before you buy']),
      sort_order: 6,
    },
    {
      slug: 'secret-gift-reveal',
      title: 'Secret Gift Reveal',
      category: 'birthday',
      emoji: '🎁',
      bg_gradient: 'linear-gradient(135deg,#1A0F00,#3D2200)',
      description: 'A mystery box that slowly unwraps on screen — reveal a surprise gift, trip, or experience in style.',
      price_cents: 349,
      badge: null, badge_label: null,
      stars: 4, review_count: 67,
      features: JSON.stringify(['Unwrap animation','Custom reveal message','Photo support','Shareable link','Any occasion']),
      sort_order: 7,
    },
    {
      slug: 'our-song-page',
      title: 'Our Song Page',
      category: 'anniversary',
      emoji: '🎵',
      bg_gradient: 'linear-gradient(135deg,#0A0A1A,#181040)',
      description: 'A dedicated page for your song — with lyrics (optional), the story of how it became yours, and a Spotify play button.',
      price_cents: 599,
      badge: 'new', badge_label: '✨ New',
      stars: 5, review_count: 44,
      features: JSON.stringify(['Spotify embed','Animated lyrics (optional)','Your story section','Album art display','Couples photo option']),
      sort_order: 8,
    },
  ]);

  console.log('✅  Seeded 8 default products into the database.');
}

module.exports = { getDb };
