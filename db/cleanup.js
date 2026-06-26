// db/cleanup.js
// Runs every hour via node-cron.
// Deletes gifts whose expires_at timestamp has passed,
// and removes any uploaded photos from disk.

const cron = require('node-cron');
const path = require('path');
const fs   = require('fs');
const { getDb } = require('./database');

const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'gifts');

function runCleanup() {
  const db = getDb();

  // Find expired gifts that have photo files to delete
  const expiredWithPhotos = db.prepare(`
    SELECT photo_path FROM gifts
    WHERE expires_at <= datetime('now')
      AND photo_path IS NOT NULL
  `).all();

  // Delete photo files from disk
  let photosDeleted = 0;
  for (const row of expiredWithPhotos) {
    const filePath = path.join(UPLOADS_DIR, row.photo_path);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        photosDeleted++;
      }
    } catch (e) {
      console.warn(`⚠️  Could not delete photo ${row.photo_path}:`, e.message);
    }
  }

  // Delete expired gift rows from the database
  const result = db.prepare(`
    DELETE FROM gifts WHERE expires_at <= datetime('now')
  `).run();

  if (result.changes > 0 || photosDeleted > 0) {
    console.log(
      `🧹  Cleanup [${new Date().toISOString()}]: ` +
      `removed ${result.changes} expired gifts, ${photosDeleted} photos.`
    );
  }
}

function startCleanupJob() {
  // Run immediately on startup
  runCleanup();

  // Then every hour at :00
  cron.schedule('0 * * * *', runCleanup);
  console.log('🕐  Gift cleanup cron job started (runs every hour).');
}

module.exports = { startCleanupJob, runCleanup };
