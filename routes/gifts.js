// routes/gifts.js
// POST /api/gifts          — create a gift, get back a shareable code
// GET  /api/gifts/:code    — fetch gift data (for the gift view page)
// GET  /api/gifts/:code/view — increment view count + return gift
// Admin:
// GET  /api/admin/gifts    — list all active gifts

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');
const adminAuth = require('../middleware/adminAuth');
const { getDb } = require('../db/database');

function normalizeBaseUrl(url) {
  let baseUrl = (url || '').trim();
  if (!baseUrl) {
    baseUrl = 'http://localhost:3000';
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    baseUrl = `https://${baseUrl}`;
  }
  return baseUrl.replace(/\/+$/, '');
}

// ── Nanoid (CommonJS compat shim) ──────────────────────────────
// nanoid v3 is CommonJS, v4+ is ESM only. We use v3 in package.json.
const { nanoid } = require('nanoid');

// ── File upload config ──────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'gifts');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${nanoid(10)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_UPLOAD_MB) || 5) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

// ── Helper: format a gift for API response ─────────────────────
function formatGift(row, db) {
  const product = row.product_id
    ? db.prepare('SELECT * FROM products WHERE id = ?').get(row.product_id)
    : null;

  const baseUrl = normalizeBaseUrl(process.env.BASE_URL || process.env.FRONTEND_URL);

  return {
    id:           row.id,
    code:         row.code,
    shareUrl:     `${baseUrl}/g/${row.code}`,
    senderName:   row.sender_name,
    receiverName: row.receiver_name,
    message:      row.message,
    specialDate:  row.special_date,
    theme:        row.theme,
    photoUrl:     row.photo_path ? `${baseUrl}/gifts/${row.photo_path}` : null,
    product:      product ? { id: product.id, title: product.title, emoji: product.emoji } : null,
    createdAt:    row.created_at,
    expiresAt:    row.expires_at,
    expired:      new Date(row.expires_at) < new Date(),
    viewCount:    row.view_count,
    paid:         row.paid === 1,
  };
}

// ── POST /api/gifts — create a new gift ────────────────────────
// Accepts multipart/form-data (for optional photo upload) or JSON.
// Required: senderName, receiverName, message
// Optional: productId, specialDate, theme, photo
router.post('/', upload.single('photo'), (req, res) => {
  const db = getDb();

  const {
    senderName, receiverName, message,
    productId, specialDate,
    theme = 'rose',
  } = req.body;

  // Validation
  if (!senderName || !receiverName || !message) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['senderName', 'receiverName', 'message'],
    });
  }
  if (message.length > 1000) {
    return res.status(400).json({ error: 'Message too long (max 1000 characters)' });
  }

  // Check product exists if provided
  if (productId) {
    const product = db.prepare('SELECT id FROM products WHERE id = ? AND active = 1').get(productId);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
  }

  // Generate unique code and expiry
  const code = nanoid(8);
  const expiryHours = parseInt(process.env.GIFT_EXPIRY_HOURS) || 24;
  const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000).toISOString();

  const photoPath = req.file ? req.file.filename : null;

  const result = db.prepare(`
    INSERT INTO gifts
      (code, product_id, sender_name, receiver_name, message,
       special_date, theme, photo_path, expires_at, paid)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    code,
    productId || null,
    senderName.trim(),
    receiverName.trim(),
    message.trim(),
    specialDate || null,
    theme,
    photoPath,
    expiresAt,
    0  // paid = false until payment confirmed
  );

  const gift = db.prepare('SELECT * FROM gifts WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ gift: formatGift(gift, db) });
});

// ── GET /api/gifts/:code — fetch gift (no view count bump) ─────
router.get('/:code', (req, res) => {
  const db = getDb();
  const gift = db.prepare('SELECT * FROM gifts WHERE code = ?').get(req.params.code);

  if (!gift) return res.status(404).json({ error: 'Gift not found or link has expired' });

  if (new Date(gift.expires_at) < new Date()) {
    return res.status(410).json({ error: 'This gift link has expired', expired: true });
  }

  res.json({ gift: formatGift(gift, db) });
});

// ── GET /api/gifts/:code/view — open gift (bumps view count) ───
// Call this when the recipient actually opens and views the gift page
router.get('/:code/view', (req, res) => {
  const db = getDb();
  const gift = db.prepare('SELECT * FROM gifts WHERE code = ?').get(req.params.code);

  if (!gift) return res.status(404).json({ error: 'Gift not found' });

  if (new Date(gift.expires_at) < new Date()) {
    return res.status(410).json({ error: 'This gift link has expired', expired: true });
  }

  // Increment view count
  db.prepare('UPDATE gifts SET view_count = view_count + 1 WHERE code = ?').run(req.params.code);

  const updated = db.prepare('SELECT * FROM gifts WHERE code = ?').get(req.params.code);
  res.json({ gift: formatGift(updated, db) });
});

// ── ADMIN: list all non-expired gifts ──────────────────────────
// GET /api/admin/gifts
router.get('/admin/all', adminAuth, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM gifts
    WHERE expires_at > datetime('now')
    ORDER BY created_at DESC
    LIMIT 200
  `).all();

  res.json({
    gifts: rows.map(g => formatGift(g, db)),
    total: rows.length,
  });
});

// ── ADMIN: dashboard stats ──────────────────────────────────────
// GET /api/admin/stats
router.get('/admin/stats', adminAuth, (req, res) => {
  const db = getDb();

  const totalGifts   = db.prepare("SELECT COUNT(*) as n FROM gifts").get().n;
  const activeGifts  = db.prepare("SELECT COUNT(*) as n FROM gifts WHERE expires_at > datetime('now')").get().n;
  const totalViews   = db.prepare("SELECT SUM(view_count) as n FROM gifts").get().n || 0;
  const todayGifts   = db.prepare("SELECT COUNT(*) as n FROM gifts WHERE date(created_at) = date('now')").get().n;
  const totalProducts = db.prepare("SELECT COUNT(*) as n FROM products WHERE active = 1").get().n;

  const topProducts = db.prepare(`
    SELECT p.title, p.emoji, COUNT(g.id) as gift_count
    FROM products p
    LEFT JOIN gifts g ON g.product_id = p.id
    GROUP BY p.id
    ORDER BY gift_count DESC
    LIMIT 5
  `).all();

  res.json({
    stats: {
      totalGifts, activeGifts, totalViews, todayGifts, totalProducts,
    },
    topProducts,
  });
});

module.exports = router;
