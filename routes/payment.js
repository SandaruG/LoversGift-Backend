// routes/payment.js
// Whop checkout flow — create a checkout session and activate the gift from webhook confirmation.
//
// 1. POST /api/payment/create-order  → creates a local pending order and a Whop checkout session
// 2. POST /api/payment/whop/webhook  → verifies Whop webhook signature and activates the gift
// 3. POST /api/payment/free-gift     → free products skip payment, go straight to gift

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router  = express.Router();
const axios   = require('axios');
const { getDb } = require('../db/database');
const { nanoid } = require('nanoid');

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

function resolvePaymentMethod(preferredMethod) {
  const requested = (preferredMethod || '').toLowerCase();
  if (requested === 'paypal' || requested === 'whop') {
    return requested;
  }

  const whopRevenueUsd = parseFloat(process.env.WHOP_REVENUE_USD || '0');
  const thresholdUsd = parseFloat(process.env.PAYPAL_FALLBACK_THRESHOLD_USD || '200');
  return whopRevenueUsd >= thresholdUsd ? 'paypal' : 'whop';
}

function getPaymentConfig() {
  const whopEnabled = Boolean(process.env.WHOP_API_KEY && process.env.WHOP_COMPANY_ID && process.env.WHOP_WEBHOOK_SECRET);
  const paypalEnabled = Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
  return {
    whopEnabled,
    paypalEnabled,
    preferredMethod: resolvePaymentMethod(),
    thresholdUsd: parseFloat(process.env.PAYPAL_FALLBACK_THRESHOLD_USD || '200'),
    whopRevenueUsd: parseFloat(process.env.WHOP_REVENUE_USD || '0'),
  };
}

function verifyWhopSignature(payload, signatureHeader, timestampHeader, secret) {
  if (!payload || !signatureHeader || !timestampHeader || !secret) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(`${timestampHeader}.${payload}`)
    .digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature);
  const providedBuffer = Buffer.from(signatureHeader.replace(/^v1=/, ''));

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function paypalBase() {
  return process.env.PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

function getPayPalRedirectUrls(baseUrl) {
  const normalizedBase = normalizeBaseUrl(baseUrl || process.env.BASE_URL || process.env.FRONTEND_URL);
  return {
    returnUrl: `${normalizedBase}/api/payment/paypal/return`,
    cancelUrl: `${normalizedBase}/api/payment/paypal/cancel`,
  };
}

async function getPayPalToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('PayPal credentials not configured in .env');
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await axios.post(
    `${paypalBase()}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  return response.data.access_token;
}

async function createPayPalOrder(orderRef, product, amountCents, metadata) {
  const token = await getPayPalToken();
  const amountStr = (amountCents / 100).toFixed(2);
  const { returnUrl, cancelUrl } = getPayPalRedirectUrls(process.env.BASE_URL || process.env.FRONTEND_URL);
  const response = await axios.post(
    `${paypalBase()}/v2/checkout/orders`,
    {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: orderRef,
          description: `LoversGift – ${product.title}`,
          amount: {
            currency_code: 'USD',
            value: amountStr,
          },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'LoversGift',
            landing_page: 'NO_PREFERENCE',
            user_action: 'PAY_NOW',
            return_url: `${returnUrl}?orderRef=${orderRef}`,
            cancel_url: `${cancelUrl}?orderRef=${orderRef}`,
          },
        },
      },
      application_context: {
        brand_name: 'LoversGift',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'PAY_NOW',
      },
      metadata,
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return response.data;
}

async function capturePayPalOrder(paypalOrderId) {
  const token = await getPayPalToken();
  const response = await axios.post(
    `${paypalBase()}/v2/checkout/orders/${paypalOrderId}/capture`,
    {},
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return response.data;
}

async function createWhopCheckoutSession(orderRef, product, amountCents, metadata) {
  const apiKey = process.env.WHOP_API_KEY;
  const companyId = process.env.WHOP_COMPANY_ID;

  if (!apiKey || !companyId) {
    throw new Error('Whop credentials not configured in .env');
  }

  const amount = (amountCents / 100).toFixed(2);
  const response = await axios.post(
    `${process.env.WHOP_API_BASE_URL || 'https://api.whop.com/v2'}/checkout_configurations`,
    {
      mode: 'payment',
      plan: {
        company_id: companyId,
        currency: 'usd',
        initial_price: parseFloat(amount),
        renewal_price: 0,
        plan_type: 'one_time',
        release_method: 'buy_now',
        title: `LoversGift – ${product.title}`,
        visibility: 'hidden',
        product: {
          external_identifier: orderRef,
          title: `LoversGift – ${product.title}`,
          visibility: 'hidden',
        },
      },
      metadata: {
        order_ref: orderRef,
        ...metadata,
      },
      redirect_url: `${normalizeBaseUrl(process.env.BASE_URL || process.env.FRONTEND_URL)}/payment-success`,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return response.data;
}

// ── Helper: create the gift after payment confirmed ─────────────
function activateGift(db, order) {
  const code      = nanoid(8);
  const expiryHrs = parseInt(process.env.GIFT_EXPIRY_HOURS) || 24;
  const expiresAt = new Date(Date.now() + expiryHrs * 60 * 60 * 1000).toISOString();
  const baseUrl   = normalizeBaseUrl(process.env.BASE_URL || process.env.FRONTEND_URL);

  // Insert the gift row
  db.prepare(`
    INSERT INTO gifts
      (code, product_id, order_id, sender_name, receiver_name,
       message, special_date, theme, extra_data, expires_at, paid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    code,
    order.product_id,
    order.id,
    order.sender_name,
    order.receiver_name,
    order.message,
    order.special_date,
    order.theme,
    order.extra_data || '{}',
    expiresAt
  );

  // Link the gift code back to the order
  db.prepare(`UPDATE orders SET gift_code = ?, status = 'paid', paid_at = datetime('now') WHERE id = ?`)
    .run(code, order.id);

  return {
    code,
    expiresAt,
    shareUrl: `${baseUrl}/g/${code}`,
  };
}

// ── Format gift link response ───────────────────────────────────
function giftResponse(gift, product) {
  const baseUrl = normalizeBaseUrl(process.env.BASE_URL || process.env.FRONTEND_URL);
  return {
    success:      true,
    giftCode:     gift.code,
    shareUrl:     `${baseUrl}/g/${gift.code}`,
    expiresAt:    gift.expiresAt,
    product:      product ? { title: product.title, emoji: product.emoji } : null,
    whatsappUrl:  `https://wa.me/?text=${encodeURIComponent(`💌 I made you something special → ${baseUrl}/g/${gift.code}`)}`,
    messengerUrl: `fb-messenger://share/?link=${encodeURIComponent(`${baseUrl}/g/${gift.code}`)}`,
  };
}

// ═══════════════════════════════════════════════════════════════
// STEP 1 — POST /api/payment/create-order
// Frontend calls this when user clicks "Pay"
// Returns: { checkoutUrl, orderRef, checkoutId }
// ═══════════════════════════════════════════════════════════════
router.post('/create-order', upload.single('photo'), async (req, res) => {
  try {
    const db = getDb();
    const rawExtraData = req.body.extraData || {};
    let extraData = {};
    try {
      extraData = typeof rawExtraData === 'string' ? JSON.parse(rawExtraData) : rawExtraData || {};
    } catch (_err) {
      extraData = {};
    }

    const {
      productId,
      senderName,
      receiverName,
      message,
      specialDate,
      theme = 'rose',
      paymentMethod,
    } = req.body;

    if (!productId || !senderName || !receiverName || !message) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['productId', 'senderName', 'receiverName', 'message'],
      });
    }

    const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (product.price_cents === 0) {
      return res.status(400).json({ error: 'This is a free product. Use /api/payment/free-gift instead.' });
    }

    const paymentType = resolvePaymentMethod(paymentMethod);
    const orderRef = `LG-${nanoid(8).toUpperCase()}`;
    const photoPath = req.file ? req.file.filename : extraData.photo_path || null;
    const normalizedExtraData = { ...extraData, ...(photoPath ? { photo_path: photoPath } : {}) };

    db.prepare(`
      INSERT INTO orders
        (order_ref, product_id, amount_cents, currency, sender_name,
         receiver_name, message, special_date, theme, extra_data, status)
      VALUES (?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      orderRef,
      product.id,
      product.price_cents,
      senderName.trim(),
      receiverName.trim(),
      message.trim(),
      specialDate || null,
      theme,
      JSON.stringify(normalizedExtraData)
    );

    if (paymentType === 'paypal') {
      const paypalOrder = await createPayPalOrder(orderRef, product, product.price_cents, {
        sender_name: senderName.trim(),
        receiver_name: receiverName.trim(),
        message: message.trim(),
      });
      db.prepare('UPDATE orders SET provider_order_id = ? WHERE order_ref = ?').run(paypalOrder.id || orderRef, orderRef);
      const approvalUrl = paypalOrder.links?.find(link => link.rel === 'approve')?.href || null;
      return res.json({
        orderRef,
        paymentMethod: 'paypal',
        paypalOrderId: paypalOrder.id,
        approvalUrl,
        links: paypalOrder.links || [],
      });
    }

    const checkout = await createWhopCheckoutSession(orderRef, product, product.price_cents, {
      sender_name: senderName.trim(),
      receiver_name: receiverName.trim(),
      message: message.trim(),
    });

    db.prepare('UPDATE orders SET provider_order_id = ? WHERE order_ref = ?').run(checkout.id || checkout.purchase_url || orderRef, orderRef);

    res.json({
      orderRef,
      paymentMethod: 'whop',
      checkoutId: checkout.id || null,
      checkoutUrl: checkout.purchase_url || checkout.redirect_url || null,
    });
  } catch (err) {
    console.error('❌ create-order error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create checkout. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// STEP 2 — POST /api/payment/capture
// Kept for compatibility: actual activation happens from the Whop webhook.
// ═══════════════════════════════════════════════════════════════
router.post('/capture', async (req, res) => {
  try {
    const db = getDb();
    const { orderRef, paymentMethod, paypalOrderId } = req.body;

    if (!orderRef) {
      return res.status(400).json({ error: 'Missing orderRef' });
    }

    const order = db.prepare('SELECT * FROM orders WHERE order_ref = ?').get(orderRef);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (order.status === 'paid') {
      const gift = db.prepare('SELECT * FROM gifts WHERE code = ?').get(order.gift_code);
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
      return res.json(giftResponse({ code: gift.code, expiresAt: gift.expires_at }, product));
    }

    if ((paymentMethod || resolvePaymentMethod()).toLowerCase() === 'paypal') {
      const captureData = await capturePayPalOrder(paypalOrderId);
      const captureStatus = captureData.status;
      const captureUnit = captureData.purchase_units?.[0]?.payments?.captures?.[0];
      if (captureStatus !== 'COMPLETED' || captureUnit?.status !== 'COMPLETED') {
        db.prepare("UPDATE orders SET status = 'failed' WHERE order_ref = ?").run(orderRef);
        return res.status(402).json({ error: 'PayPal payment was not completed.' });
      }
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
      const gift = activateGift(db, order);
      return res.json(giftResponse(gift, product));
    }

    return res.status(202).json({ status: 'pending', message: 'Payment confirmation is pending webhook activation.' });
  } catch (err) {
    console.error('❌ capture error:', err.message);
    res.status(500).json({ error: 'Capture failed.' });
  }
});

router.get('/config', (_req, res) => {
  res.json(getPaymentConfig());
});

router.get('/status/:orderRef', (req, res) => {
  try {
    const db = getDb();
    const order = db.prepare('SELECT * FROM orders WHERE order_ref = ?').get(req.params.orderRef);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (order.status !== 'paid') {
      return res.json({ status: 'pending', orderRef: order.order_ref });
    }

    const gift = db.prepare('SELECT * FROM gifts WHERE code = ?').get(order.gift_code);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
    return res.json({
      status: 'paid',
      orderRef: order.order_ref,
      shareUrl: gift ? `${normalizeBaseUrl(process.env.BASE_URL || process.env.FRONTEND_URL)}/g/${gift.code}` : null,
      whatsappUrl: gift ? `https://wa.me/?text=${encodeURIComponent(`💌 I made you something special → ${normalizeBaseUrl(process.env.BASE_URL || process.env.FRONTEND_URL)}/g/${gift.code}`)}` : null,
      messengerUrl: gift ? `fb-messenger://share/?link=${encodeURIComponent(`${normalizeBaseUrl(process.env.BASE_URL || process.env.FRONTEND_URL)}/g/${gift.code}`)}` : null,
      expiresAt: gift?.expires_at || null,
      product: product ? { title: product.title, emoji: product.emoji } : null,
    });
  } catch (err) {
    console.error('❌ status error:', err.message);
    return res.status(500).json({ error: 'Status lookup failed.' });
  }
});

router.get('/paypal/return', async (req, res) => {
  try {
    const db = getDb();
    const { orderRef } = req.query;
    const order = db.prepare('SELECT * FROM orders WHERE order_ref = ?').get(orderRef);

    if (!order) {
      return res.redirect(`${normalizeBaseUrl(process.env.FRONTEND_URL || process.env.BASE_URL)}?payment=cancel`);
    }

    if (order.status === 'paid') {
      return res.redirect(`${normalizeBaseUrl(process.env.FRONTEND_URL || process.env.BASE_URL)}?payment=success&orderRef=${orderRef}`);
    }

    const captureData = await capturePayPalOrder(order.provider_order_id || order.order_ref);
    const captureStatus = captureData.status;
    const captureUnit = captureData.purchase_units?.[0]?.payments?.captures?.[0];

    if (captureStatus !== 'COMPLETED' || captureUnit?.status !== 'COMPLETED') {
      db.prepare("UPDATE orders SET status = 'failed' WHERE order_ref = ?").run(orderRef);
      return res.redirect(`${normalizeBaseUrl(process.env.FRONTEND_URL || process.env.BASE_URL)}?payment=cancel&orderRef=${orderRef}`);
    }

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
    const gift = activateGift(db, order);
    console.log(`💕 Gift activated from PayPal return: ${gift.code} | Order: ${orderRef}`);

    return res.redirect(`${normalizeBaseUrl(process.env.FRONTEND_URL || process.env.BASE_URL)}?payment=success&orderRef=${orderRef}`);
  } catch (err) {
    console.error('❌ paypal return error:', err.message);
    return res.redirect(`${normalizeBaseUrl(process.env.FRONTEND_URL || process.env.BASE_URL)}?payment=cancel`);
  }
});

router.get('/paypal/cancel', (req, res) => {
  const { orderRef } = req.query;
  return res.redirect(`${normalizeBaseUrl(process.env.FRONTEND_URL || process.env.BASE_URL)}?payment=cancel&orderRef=${orderRef || ''}`);
});

router.post('/whop/webhook', express.json({ type: 'application/json' }), (req, res) => {
  try {
    const db = getDb();
    const rawPayload = JSON.stringify(req.body || {});
    const signatureHeader = req.get('webhook-signature') || req.get('x-whop-signature');
    const timestampHeader = req.get('webhook-timestamp') || req.get('x-whop-timestamp');
    const secret = process.env.WHOP_WEBHOOK_SECRET;

    if (!verifyWhopSignature(rawPayload, signatureHeader, timestampHeader, secret)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const payload = req.body || {};
    const eventType = payload.event || payload.event_type || payload.type || '';
    if (eventType !== 'payment.succeeded' && eventType !== 'payment_paid' && payload?.data?.status !== 'paid') {
      return res.json({ received: true });
    }

    const orderRef = payload?.data?.metadata?.order_ref || payload?.metadata?.order_ref || payload?.data?.plan?.metadata?.order_ref || payload?.data?.product?.metadata?.order_ref;
    if (!orderRef) {
      return res.status(400).json({ error: 'Missing order reference in webhook payload' });
    }

    const order = db.prepare('SELECT * FROM orders WHERE order_ref = ?').get(orderRef);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'paid') {
      return res.json({ received: true, already_processed: true });
    }

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
    const gift = activateGift(db, order);
    console.log(`💕 Gift activated from Whop webhook: ${gift.code} | Order: ${orderRef} | Product: ${product?.title || 'unknown'}`);

    res.json({ received: true, giftCode: gift.code });
  } catch (err) {
    console.error('❌ webhook error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// FREE GIFTS — POST /api/payment/free-gift
// For the "Simple Love Note" (price_cents = 0)
// No PayPal needed — creates gift immediately
// ═══════════════════════════════════════════════════════════════
router.post('/free-gift', (req, res) => {
  try {
    const db = getDb();
    const {
      productId,
      senderName,
      receiverName,
      message,
      specialDate,
      theme = 'rose',
      extraData = {},
    } = req.body;

    if (!productId || !senderName || !receiverName || !message) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['productId', 'senderName', 'receiverName', 'message'],
      });
    }

    const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (product.price_cents !== 0) {
      return res.status(400).json({ error: 'This product requires payment. Use /api/payment/create-order instead.' });
    }

    // Rate limit free gifts more strictly (handled by express-rate-limit in server.js)
    // Create a fake "paid" order record for consistency
    const orderRef = `LG-FREE-${nanoid(8).toUpperCase()}`;
    db.prepare(`
      INSERT INTO orders
        (order_ref, product_id, amount_cents, currency, sender_name,
         receiver_name, message, special_date, theme, extra_data, status)
      VALUES (?, ?, 0, 'USD', ?, ?, ?, ?, ?, ?, 'paid')
    `).run(
      orderRef, product.id,
      senderName.trim(), receiverName.trim(), message.trim(),
      specialDate || null, theme, JSON.stringify(extraData)
    );

    const order = db.prepare('SELECT * FROM orders WHERE order_ref = ?').get(orderRef);
    const gift  = activateGift(db, order);

    res.json(giftResponse(gift, product));

  } catch (err) {
    console.error('❌ free-gift error:', err.message);
    res.status(500).json({ error: 'Failed to create gift. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POLL — GET /api/payment/status/:orderRef
// Frontend polls this after PayPal redirect (fallback for popup blockers)
// ═══════════════════════════════════════════════════════════════
router.get('/status/:orderRef', (req, res) => {
  const db    = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE order_ref = ?').get(req.params.orderRef);

  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (order.status === 'paid' && order.gift_code) {
    const gift    = db.prepare('SELECT * FROM gifts WHERE code = ?').get(order.gift_code);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
    const baseUrl = normalizeBaseUrl(process.env.BASE_URL || process.env.FRONTEND_URL || 'http://localhost:3000');
    return res.json({
      status: 'paid',
      shareUrl:     `${baseUrl}/g/${order.gift_code}`,
      giftCode:     order.gift_code,
      expiresAt:    gift?.expires_at,
      whatsappUrl:  `https://wa.me/?text=${encodeURIComponent(`💌 I made you something special → ${baseUrl}/g/${order.gift_code}`)}`,
      messengerUrl: `fb-messenger://share/?link=${encodeURIComponent(`${baseUrl}/g/${order.gift_code}`)}`,
      product:      product ? { title: product.title, emoji: product.emoji } : null,
    });
  }

  res.json({ status: order.status });
});

module.exports = { router, normalizeBaseUrl, verifyWhopSignature, getPayPalRedirectUrls };
