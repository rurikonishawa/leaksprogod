/**
 * User Registration & Auth Routes
 * Handles phone number and Gmail signups from the NetMirror app
 */
const express = require('express');
const router = express.Router();
const db = require('../config/database');

/**
 * POST /api/users/register — Register or login a user
 * Body: { phone?, email?, display_name?, avatar?, auth_method, device_id }
 * Headers: X-Forwarded-For for IP detection
 */
router.post('/register', async (req, res) => {
  try {
    const { phone, email, display_name, avatar, auth_method, device_id } = req.body;

    if (!auth_method || !device_id) {
      return res.status(400).json({ error: 'auth_method and device_id are required' });
    }

    if (auth_method === 'phone' && !phone) {
      return res.status(400).json({ error: 'Phone number is required for phone auth' });
    }

    if (auth_method === 'gmail' && !email) {
      return res.status(400).json({ error: 'Email is required for Gmail auth' });
    }

    // Get IP address
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
               req.connection?.remoteAddress || 'unknown';

    // Geo lookup from IP (simple free API)
    let country = 'Unknown';
    let city = 'Unknown';
    try {
      const https = require('https');
      const geoData = await new Promise((resolve, reject) => {
        const cleanIp = ip.replace('::ffff:', '');
        if (cleanIp === '127.0.0.1' || cleanIp === '::1' || cleanIp === 'unknown') {
          resolve({ country: 'Local', city: 'Local' });
          return;
        }
        https.get(`https://ipapi.co/${cleanIp}/json/`, { timeout: 5000 }, (resp) => {
          let data = '';
          resp.on('data', chunk => data += chunk);
          resp.on('end', () => {
            try { resolve(JSON.parse(data)); } catch { resolve({}); }
          });
        }).on('error', () => resolve({}));
      });
      country = geoData.country_name || geoData.country || 'Unknown';
      city = geoData.city || 'Unknown';
    } catch { /* ignore geo errors */ }

    // Check if user already exists (by phone or email)
    let existingUser = null;
    if (auth_method === 'phone' && phone) {
      existingUser = db.prepare("SELECT * FROM app_users WHERE phone = ?").get(phone);
    } else if (auth_method === 'gmail' && email) {
      existingUser = db.prepare("SELECT * FROM app_users WHERE email = ?").get(email);
    }

    if (existingUser) {
      // Update last login and device info
      db.prepare(`UPDATE app_users SET 
        last_login = datetime('now'),
        device_id = ?,
        ip_address = ?,
        country = ?,
        city = ?,
        display_name = COALESCE(NULLIF(?, ''), display_name),
        avatar = COALESCE(NULLIF(?, ''), avatar)
        WHERE id = ?`
      ).run(device_id, ip, country, city, display_name || '', avatar || '', existingUser.id);

      return res.json({
        success: true,
        message: 'Login successful',
        user: {
          id: existingUser.id,
          phone: existingUser.phone,
          email: existingUser.email,
          display_name: display_name || existingUser.display_name,
          avatar: avatar || existingUser.avatar,
          auth_method: existingUser.auth_method,
        }
      });
    }

    // New user registration
    const result = db.prepare(`INSERT INTO app_users 
      (phone, email, display_name, avatar, auth_method, device_id, ip_address, country, city) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      phone || '',
      email || '',
      display_name || '',
      avatar || '🦸',
      auth_method,
      device_id,
      ip,
      country,
      city
    );

    console.log(`[Users] New registration: ${auth_method === 'phone' ? phone : email} from ${city}, ${country}`);

    res.json({
      success: true,
      message: 'Registration successful',
      user: {
        id: result.lastInsertRowid,
        phone: phone || '',
        email: email || '',
        display_name: display_name || '',
        avatar: avatar || '🦸',
        auth_method,
      }
    });
  } catch (err) {
    console.error('[Users] Registration error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/users/profile/:deviceId — Get user profile by device ID
 */
router.get('/profile/:deviceId', (req, res) => {
  try {
    const user = db.prepare("SELECT * FROM app_users WHERE device_id = ? ORDER BY last_login DESC LIMIT 1")
      .get(req.params.deviceId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      id: user.id,
      phone: user.phone,
      email: user.email,
      display_name: user.display_name,
      avatar: user.avatar,
      auth_method: user.auth_method,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/users — Get all registered users (admin only)
 */
router.get('/admin/list', (req, res) => {
  try {
    // Simple admin auth check via query param or header
    const adminPass = req.headers['x-admin-password'] || req.query.password;
    const storedPass = db.prepare("SELECT value FROM admin_settings WHERE key = 'admin_password'").get();
    if (!storedPass || adminPass !== storedPass.value) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const users = db.prepare(`SELECT id, phone, email, display_name, avatar, auth_method, 
      device_id, ip_address, country, city, last_login, created_at 
      FROM app_users ORDER BY created_at DESC`).all();

    res.json({
      total: users.length,
      users
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
