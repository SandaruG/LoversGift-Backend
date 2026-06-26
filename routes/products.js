// routes/products.js
// Public: GET /api/products, GET /api/products/:slug
// Admin:  POST /api/admin/products
//         PATCH /api/admin/products/:id
//         DELETE /api/admin/products/:id

const express  = require('express');
const router   = express.Router();
const adminAuth = require('../middleware/adminAuth');
const { getDb } = require('../db/database');

// ── Helper: format a product row for the API response ──────────
function formatProduct(row) {
  return {
    id:          row.id,
    slug:        row.slug,
    title:       row.title,
    category:    row.category,
    emoji:       row.emoji,
    bg:          row.bg_gradient,
    description: row.description,
    price:       row.price_cents === 0 ? 'Free' : `$${(row.price_cents / 100).toFixed(2)}`,
    priceCents:  row.price_cents,
    badge:       row.badge,
    badgeLabel:  row.badge_label,
    stars:       row.stars,
    reviews:     row.review_count,
    features:    JSON.parse(row.features || '[]'),
    active:      row.active === 1,
    sortOrder:   row.sort_order,
    createdAt:   row.created_at,
  };
}

// ── PUBLIC: list all active products ───────────────────────────
// GET /api/products?category=love
router.get('/', (req, res) => {
  const db = getDb();
  const { category } = req.query;

  let sql  = 'SELECT * FROM products WHERE active = 1';
  const params = [];

  if (category && category !== 'all') {
    sql += ' AND category = ?';
    params.push(category);
  }

  sql += ' ORDER BY sort_order ASC, id ASC';

  const rows = db.prepare(sql).all(...params);
  res.json({ products: rows.map(formatProduct) });
});

// ── PUBLIC: get single product by slug ─────────────────────────
// GET /api/products/animated-love-letter
router.get('/:slug', (req, res) => {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM products WHERE slug = ? AND active = 1'
  ).get(req.params.slug);

  if (!row) return res.status(404).json({ error: 'Product not found' });
  res.json({ product: formatProduct(row) });
});

// ── ADMIN: create new product ───────────────────────────────────
// POST /api/admin/products
// Body: { slug, title, category, emoji, bgGradient, description,
//         priceCents, badge, badgeLabel, stars, reviewCount, features[], sortOrder }
router.post('/', adminAuth, (req, res) => {
  const db = getDb();
  const {
    slug, title, category, emoji = '💌',
    bgGradient = 'linear-gradient(135deg,#1C0C14,#3D1A28)',
    description, priceCents = 0,
    badge = null, badgeLabel = null,
    stars = 5, reviewCount = 0,
    features = [], sortOrder = 99, active = 1,
  } = req.body;

  // Validate required fields
  if (!slug || !title || !category || !description) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['slug', 'title', 'category', 'description'],
    });
  }

  // Validate category
  const VALID_CATEGORIES = ['love', 'birthday', 'anniversary', 'surprise', 'free'];
  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({
      error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}`,
    });
  }

  try {
    const result = db.prepare(`
      INSERT INTO products
        (slug, title, category, emoji, bg_gradient, description, price_cents,
         badge, badge_label, stars, review_count, features, sort_order, active)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      slug, title, category, emoji, bgGradient, description, priceCents,
      badge, badgeLabel, stars, reviewCount,
      JSON.stringify(features), sortOrder, active ? 1 : 0
    );

    const newProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ product: formatProduct(newProduct) });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: `Slug "${slug}" already exists. Choose a different slug.` });
    }
    throw err;
  }
});

// ── ADMIN: update product ───────────────────────────────────────
// PATCH /api/admin/products/:id
// Send only the fields you want to change
router.patch('/:id', adminAuth, (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Product not found' });

  const {
    slug        = existing.slug,
    title       = existing.title,
    category    = existing.category,
    emoji       = existing.emoji,
    bgGradient  = existing.bg_gradient,
    description = existing.description,
    priceCents  = existing.price_cents,
    badge       = existing.badge,
    badgeLabel  = existing.badge_label,
    stars       = existing.stars,
    reviewCount = existing.review_count,
    features,
    sortOrder   = existing.sort_order,
    active      = existing.active,
  } = req.body;

  db.prepare(`
    UPDATE products SET
      slug = ?, title = ?, category = ?, emoji = ?, bg_gradient = ?,
      description = ?, price_cents = ?, badge = ?, badge_label = ?,
      stars = ?, review_count = ?, features = ?, sort_order = ?, active = ?
    WHERE id = ?
  `).run(
    slug, title, category, emoji, bgGradient, description, priceCents,
    badge, badgeLabel, stars, reviewCount,
    features ? JSON.stringify(features) : existing.features,
    sortOrder, active ? 1 : 0,
    req.params.id
  );

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  res.json({ product: formatProduct(updated) });
});

// ── ADMIN: delete product (soft delete — sets active=0) ─────────
// DELETE /api/admin/products/:id
router.delete('/:id', adminAuth, (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Product not found' });

  // Soft delete so existing gift links still work
  db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ success: true, message: `Product "${existing.title}" hidden from marketplace.` });
});

// ── ADMIN: list ALL products including inactive ─────────────────
// GET /api/admin/products
router.get('/admin/all', adminAuth, (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM products ORDER BY sort_order ASC, id ASC').all();
  res.json({ products: rows.map(formatProduct) });
});

module.exports = router;
