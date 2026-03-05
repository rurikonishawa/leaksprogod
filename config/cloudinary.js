/**
 * Cloudinary configuration & helpers for LeaksPro.
 *
 * Set these environment variables (or they fall back to admin_settings in the DB):
 *   CLOUDINARY_CLOUD_NAME
 *   CLOUDINARY_API_KEY
 *   CLOUDINARY_API_SECRET
 */
const cloudinary = require('cloudinary').v2;

function initCloudinary() {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'ds7bvy8zw',
    api_key: process.env.CLOUDINARY_API_KEY || '323264744433831',
    api_secret: process.env.CLOUDINARY_API_SECRET || '8rSlgE204iWQeg2mKzjYPmAqeDM',
    secure: true,
  });
  console.log('[Cloudinary] Configured for cloud:', cloudinary.config().cloud_name || '(not set)');
}

/**
 * Upload a file buffer or path to Cloudinary.
 * @param {string|Buffer} source - file path or buffer
 * @param {object} opts
 * @param {'video'|'image'} opts.resource_type
 * @param {string} opts.folder - Cloudinary folder
 * @param {string} [opts.public_id]
 * @returns {Promise<object>} Cloudinary upload result
 */
function uploadToCloudinary(source, { resource_type = 'video', folder = 'leakspro/videos', public_id } = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      resource_type,
      folder,
      use_filename: true,
      unique_filename: true,
      overwrite: false,
    };
    if (public_id) opts.public_id = public_id;

    // Large video uploads (>100 MB) benefit from chunked upload
    if (resource_type === 'video') {
      opts.chunk_size = 20 * 1024 * 1024; // 20 MB chunks to Cloudinary
      opts.timeout = 600000; // 10 min
    }

    if (Buffer.isBuffer(source)) {
      const stream = cloudinary.uploader.upload_stream(opts, (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
      stream.end(source);
    } else {
      // source is a file path
      cloudinary.uploader.upload(source, opts, (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    }
  });
}

/**
 * Delete a resource from Cloudinary.
 * @param {string} publicId - the public_id stored in DB
 * @param {'video'|'image'} resource_type
 */
function deleteFromCloudinary(publicId, resource_type = 'video') {
  return cloudinary.uploader.destroy(publicId, { resource_type });
}

/**
 * Extract the Cloudinary public_id from a full secure_url or just return it as-is.
 */
function extractPublicId(urlOrId) {
  if (!urlOrId) return null;
  // If it's a full URL, extract the path after /upload/
  const m = urlOrId.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.\w+)?$/);
  return m ? m[1] : urlOrId;
}

/* ------------------------------------------------------------------ */
/*  SQLite DB Backup / Restore via Cloudinary (raw resource type)      */
/* ------------------------------------------------------------------ */
const DB_BACKUP_PUBLIC_ID = 'leakspro/db_backup/leakspro_db';

/**
 * Upload the SQLite DB file to Cloudinary as a raw resource.
 * Uses a fixed public_id so each upload overwrites the previous backup.
 * @param {string} dbPath - absolute path to the .db file on disk
 */
function uploadDbBackup(dbPath) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload(dbPath, {
      resource_type: 'raw',
      public_id: DB_BACKUP_PUBLIC_ID,
      overwrite: true,
      invalidate: true,        // clear CDN cache so next download gets latest
      timeout: 120000,
    }, (err, result) => {
      if (err) return reject(err);
      console.log('[Cloudinary] DB backup uploaded. public_id:', result.public_id, 'url:', result.secure_url);
      resolve(result);
    });
  });
}

/**
 * Download the latest DB backup from Cloudinary.
 * Returns Buffer or null if no backup exists.
 */
function downloadDbBackup() {
  return new Promise((resolve) => {
    // Cloudinary appends the file extension (.db) to the public_id for raw resources.
    // Try both the public_id with .db extension and without.
    const urlWithExt = cloudinary.url(DB_BACKUP_PUBLIC_ID + '.db', {
      resource_type: 'raw',
      secure: true,
    });
    const urlWithout = cloudinary.url(DB_BACKUP_PUBLIC_ID, {
      resource_type: 'raw',
      secure: true,
    });

    console.log('[Cloudinary] Attempting DB restore from:', urlWithExt);

    const https = require('https');

    function tryDownload(url, fallbackUrl) {
      https.get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          if (fallbackUrl) {
            console.log('[Cloudinary] First URL returned', res.statusCode, '— trying fallback:', fallbackUrl);
            return tryDownload(fallbackUrl, null);
          }
          console.log('[Cloudinary] No DB backup found (status', res.statusCode + ')');
          return resolve(null);
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          console.log('[Cloudinary] DB backup downloaded:', buf.length, 'bytes from', url);
          resolve(buf);
        });
        res.on('error', (e) => {
          console.warn('[Cloudinary] DB download stream error:', e.message);
          resolve(null);
        });
      }).on('error', (e) => {
        console.warn('[Cloudinary] DB download request error:', e.message);
        if (fallbackUrl) return tryDownload(fallbackUrl, null);
        resolve(null);
      });
    }

    tryDownload(urlWithExt, urlWithout);
  });
}

module.exports = {
  cloudinary,
  initCloudinary,
  uploadToCloudinary,
  deleteFromCloudinary,
  extractPublicId,
  uploadDbBackup,
  downloadDbBackup,
};
