// routes/payment.js
// PayPal Checkout — full automated flow
//
// 1. POST /api/payment/create-order  → creates PayPal order, returns paypalOrderId
// 2. POST /api/payment/capture       → captures payment, activates gift, returns gift link
// 3. POST /api/payment/free-gift     → free products skip payment, go straight to gift
//
// PayPal SDK-free — uses PayPal REST API v2 directly via axios.
// No extra npm packages needed beyond what's already installed.

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { getDb } = require('../db/database');
const { nanoid } = require('nanoid');

// ── PayPal API base URL ─────────────────────────────────────────
// Sandbox (testing):   https://api-m.sandbox.paypal.com
// Live (real money):   https://api-m.paypal.com
function paypalBase() {
  return process.env.PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

// ── Get PayPal access token ─────────────────────────────────────
// PayPal uses OAuth2. We exchange Client ID + Secret for a token.
// Token lasts ~9 hours; we get a fresh one per request (simple + reliable).
async function getPayPalToken() {
  const clientId     = process.env.PAYPAL_CLIENT_ID;
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
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  return response.data.access_token;
}

// ── Helper: create the gift after payment confirmed ─────────────
function activateGift(db, order) {
  const code      = nanoid(8);
  const expiryHrs = parseInt(process.env.GIFT_EXPIRY_HOURS) || 24;
  const expiresAt = new Date(Date.now() + expiryHrs * 60 * 60 * 1000).toISOString();

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
    shareUrl: `${process.env.BASE_URL || 'http://localhost:3000'}/g/${code}`,
  };
}

// ── Format gift link response ───────────────────────────────────
function giftResponse(gift, product) {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
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
// Frontend calls this when user clicks "Pay with PayPal"
// Returns: { paypalOrderId, orderRef } — frontend passes to PayPal SDK
// ═══════════════════════════════════════════════════════════════
router.post('/create-order', async (req, res) => {
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

    // Validate required fields
    if (!productId || !senderName || !receiverName || !message) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['productId', 'senderName', 'receiverName', 'message'],
      });
    }

    // Fetch product
    const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (product.price_cents === 0) {
      return res.status(400).json({ error: 'This is a free product. Use /api/payment/free-gift instead.' });
    }

    // Build our internal order reference
    const orderRef = `LG-${nanoid(8).toUpperCase()}`;
    const amountStr = (product.price_cents / 100).toFixed(2);

    // Save pending order BEFORE hitting PayPal
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
      JSON.stringify(extraData)
    );

    // Create PayPal order via REST API
    const token = await getPayPalToken();
    const ppResponse = await axios.post(
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
              return_url: `${process.env.BASE_URL}/payment-success`,
              cancel_url: `${process.env.BASE_URL}/payment-cancel`,
            },
          },
        },
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const paypalOrderId = ppResponse.data.id;

    // Store PayPal order ID against our order
    db.prepare('UPDATE orders SET paypal_order_id = ? WHERE order_ref = ?')
      .run(paypalOrderId, orderRef);

    res.json({ paypalOrderId, orderRef });

  } catch (err) {
    console.error('❌ create-order error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create PayPal order. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// STEP 2 — POST /api/payment/capture
// Frontend calls this after PayPal approves payment (onApprove callback)
// Body: { paypalOrderId, orderRef }
// Returns: { shareUrl, giftCode, expiresAt, whatsappUrl }
// ═══════════════════════════════════════════════════════════════
router.post('/capture', async (req, res) => {
  try {
    const db = getDb();
    const { paypalOrderId, orderRef } = req.body;

    if (!paypalOrderId || !orderRef) {
      return res.status(400).json({ error: 'Missing paypalOrderId or orderRef' });
    }

    // Find our order
    const order = db.prepare('SELECT * FROM orders WHERE order_ref = ?').get(orderRef);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Prevent double-capture
    if (order.status === 'paid') {
      // Already activated — return the existing gift link
      const gift = db.prepare('SELECT * FROM gifts WHERE code = ?').get(order.gift_code);
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
      return res.json(giftResponse({ code: gift.code, expiresAt: gift.expires_at }, product));
    }

    if (order.status === 'failed') {
      return res.status(400).json({ error: 'This order previously failed. Please start again.' });
    }

    // Capture the payment with PayPal
    const token = await getPayPalToken();
    const captureResponse = await axios.post(
      `${paypalBase()}/v2/checkout/orders/${paypalOrderId}/capture`,
      {},
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const captureData   = captureResponse.data;
    const captureStatus = captureData.status;
    const captureUnit   = captureData.purchase_units?.[0]?.payments?.captures?.[0];

    // Verify capture was successful
    if (captureStatus !== 'COMPLETED' || captureUnit?.status !== 'COMPLETED') {
      db.prepare("UPDATE orders SET status = 'failed' WHERE order_ref = ?").run(orderRef);
      return res.status(402).json({
        error: 'Payment was not completed. Please try again.',
        paypalStatus: captureStatus,
      });
    }

    // Verify the captured amount matches what we expected (fraud check)
    const capturedAmount = Math.round(parseFloat(captureUnit.amount.value) * 100);
    if (capturedAmount < order.amount_cents) {
      db.prepare("UPDATE orders SET status = 'failed' WHERE order_ref = ?").run(orderRef);
      return res.status(402).json({ error: 'Payment amount mismatch. Please contact support.' });
    }

    // ✅ Payment confirmed — activate the gift
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
    const gift    = activateGift(db, order);

    console.log(`💕 Gift activated: ${gift.code} | Order: ${orderRef} | Product: ${product.title}`);

    res.json(giftResponse(gift, product));

  } catch (err) {
    console.error('❌ capture error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Payment capture failed. If you were charged, contact support.' });
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
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
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

module.exports = router;
