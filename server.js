require('dotenv').config();
const express  = require('express');
const http     = require('http');
const { Pool } = require('pg');
const fs       = require('fs');
const path     = require('path');
const session  = require('express-session');
const bcrypt   = require('bcryptjs');

const PORT       = process.env.PORT || 3000;
const FRAMES_DIR = path.join(__dirname, 'public', 'frames');
const UPLOADS_DIR = path.join(__dirname, 'public', 'personnel_uploads'); // NEW: personnel photo/doc uploads

if (!fs.existsSync(FRAMES_DIR)) fs.mkdirSync(FRAMES_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true }); // NEW

const connectionString = process.env.DATABASE_URL
  || 'postgresql://ryuser:Lastresort61$@scopx-ry.postgres.database.azure.com/Gejarastra?sslmode=require';

const needsSSL = /sslmode=require/i.test(connectionString) || /azure\.com/i.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: needsSSL ? { rejectUnauthorized: false } : false
});

// ── Device cache ──
const deviceCache = new Map();

async function loadDevices() {
  const { rows } = await pool.query(
    `SELECT id, device_key, name, tag, meta FROM devices ORDER BY id`
  );
  rows.forEach(r => deviceCache.set(r.device_key, r));
  console.log(`[DB]  loaded ${rows.length} devices`);
  if (rows.length === 0) {
    console.warn('[DB]  WARNING: no devices found — run seed-devices.sql first');
  }
}

async function resolveDevice(key) {
  if (deviceCache.has(key)) return deviceCache.get(key);
  const { rows } = await pool.query(
    `SELECT id, device_key, name, tag, meta FROM devices WHERE device_key = $1`, [key]
  );
  if (!rows.length) return null;
  deviceCache.set(key, rows[0]);
  return rows[0];
}

// ── SSE helpers ──
const sseClients = new Map();

function sseNotify(deviceId, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  if (sseClients.has(deviceId)) {
    for (const res of sseClients.get(deviceId)) res.write(msg);
  }
  if (sseClients.has('all')) {
    const fleetMsg = `event: ${event}\ndata: ${JSON.stringify({ ...data, deviceId })}\n\n`;
    for (const res of sseClients.get('all')) res.write(fleetMsg);
  }
}

function addSseClient(channel, res) {
  if (!sseClients.has(channel)) sseClients.set(channel, new Set());
  sseClients.get(channel).add(res);
}

function removeSseClient(channel, res) {
  if (sseClients.has(channel)) sseClients.get(channel).delete(res);
}

// ── Create app FIRST ──
const app    = express();
const server = http.createServer(app);

// ── Middleware in correct order ──
// NOTE: limit raised from the default 100kb so base64-encoded personnel
// photos/PDFs (up to ~8MB binary => ~11MB base64) can be POSTed as JSON.
app.use(express.json({ limit: '15mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'gajarakshak-scopx-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

// ── Auth middleware ──
function requireLogin(req, res, next) {
  if (req.session?.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not logged in' });
  res.redirect('/login.html');
}

function requireAdmin(req, res, next) {
  if (req.session?.user?.role === 'admin') return next();
  res.status(403).json({ error: 'Admin only' });
}

// ── Auth routes (public — no requireLogin) ──
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Missing credentials' });
  try {
    const { rows } = await pool.query(
      `SELECT * FROM departments WHERE username = $1`, [username]
    );
    if (!rows.length)
      return res.status(401).json({ error: 'Invalid username or password' });

    const dept  = rows[0];
    const valid = await bcrypt.compare(password, dept.password);
    if (!valid)
      return res.status(401).json({ error: 'Invalid username or password' });

    req.session.user = {
      id:       dept.id,
      username: dept.username,
      name:     dept.name,
      role:     dept.role
    };
    res.json({ ok: true, role: dept.role, name: dept.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Not logged in' });
  res.json(req.session.user);
});

// ── Department list for login dropdown (public) ──
app.get('/api/departments', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, username FROM departments ORDER BY id`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Protected page routes ──
app.get('/', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/personnel.html', requireLogin, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'personnel.html'));
});

// ── Static files (login.html is public) ──
app.use(express.static(path.join(__dirname, 'public')));
app.use('/frames', express.static(FRAMES_DIR));
app.use('/personnel_uploads', express.static(UPLOADS_DIR)); // NEW: serve uploaded photos/docs

// ── Admin routes ──
app.get('/api/admin/devices', requireLogin, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, device_key, name, tag, meta FROM devices ORDER BY id`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/devices/:key/meta', requireLogin, requireAdmin, async (req, res) => {
  const device = await resolveDevice(req.params.key);
  if (!device) return res.status(404).json({ error: 'unknown device' });
  try {
    await pool.query(
      `UPDATE devices SET meta = $1 WHERE id = $2`,
      [JSON.stringify(req.body), device.id]
    );
    device.meta = req.body;
    deviceCache.set(req.params.key, device);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── NEW: Personnel photo / document upload ──
// Accepts JSON: { section: 'police'|'forest'|'mahout', filename, mimetype, data (base64) }
// Stores the file on disk under /public/personnel_uploads and records its URL
// at meta[section].photo (kept alongside meta[section].name/designation/phone).
const ALLOWED_UPLOAD_TYPES = {
  'image/jpeg': '.jpg',
  'image/jpg':  '.jpg',
  'image/png':  '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf'
};
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB
// One attachment per elephant (not per police/forest/mahout role), stored at meta.attachment
const ATTACHMENT_KEY = 'attachment';

app.post('/api/admin/devices/:key/upload', requireLogin, requireAdmin, async (req, res) => {
  const { filename, mimetype, data } = req.body || {};

  if (!data || !mimetype)
    return res.status(400).json({ error: 'Missing file data' });

  const ext = ALLOWED_UPLOAD_TYPES[mimetype.toLowerCase()];
  if (!ext)
    return res.status(400).json({ error: 'Unsupported file type. Use JPG, PNG, WEBP, or PDF.' });

  const device = await resolveDevice(req.params.key);
  if (!device) return res.status(404).json({ error: 'unknown device' });

  try {
    const buf = Buffer.from(data, 'base64');
    if (!buf.length)
      return res.status(400).json({ error: 'Empty file' });
    if (buf.length > MAX_UPLOAD_BYTES)
      return res.status(400).json({ error: 'File too large (max 8MB)' });

    // NOTE: no longer deletes the previous file — attachments now accumulate in an array
    const meta = { ...(device.meta || {}) };
    const attachments = Array.isArray(meta.attachments) ? [...meta.attachments] : [];

    const attId    = `att_${device.id}_${Date.now()}`;
    const safeName = `${device.id}_${attId}${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, safeName), buf);

    const url = `/personnel_uploads/${safeName}`;
    const entry = {
      id:        attId,
      photo:     url,
      photoFile: safeName,
      photoName: String(filename || safeName).slice(0, 120),
      photoType: mimetype
    };
    attachments.push(entry);
    meta.attachments = attachments;

    await pool.query(`UPDATE devices SET meta = $1 WHERE id = $2`, [JSON.stringify(meta), device.id]);
    device.meta = meta;
    deviceCache.set(req.params.key, device);

    console.log(`[UPLOAD] ${device.name} · ${safeName} (${buf.length}b)`);
    res.json({ ok: true, url, attachment: entry, attachments });
  } catch (err) {
    console.error('[UPLOAD] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ── NEW: Remove the elephant's attached photo/document ──
app.delete('/api/admin/devices/:key/upload/:id', requireLogin, requireAdmin, async (req, res) => {
  const device = await resolveDevice(req.params.key);
  if (!device) return res.status(404).json({ error: 'unknown device' });

  try {
    const meta = { ...(device.meta || {}) };
    const attachments = Array.isArray(meta.attachments) ? [...meta.attachments] : [];
    const idx = attachments.findIndex(a => a.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'attachment not found' });

    const [removed] = attachments.splice(idx, 1);
    if (removed?.photoFile) {
      const prevPath = path.join(UPLOADS_DIR, removed.photoFile);
      if (fs.existsSync(prevPath)) {
        try { fs.unlinkSync(prevPath); } catch (_) { /* non-fatal */ }
      }
    }
    meta.attachments = attachments;

    await pool.query(`UPDATE devices SET meta = $1 WHERE id = $2`, [JSON.stringify(meta), device.id]);
    device.meta = meta;
    deviceCache.set(req.params.key, device);

    res.json({ ok: true, attachments });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SSE routes ──
app.get('/events', requireLogin, (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();
  res.write(':ok\n\n');
  addSseClient('all', res);
  console.log(`[SSE/all] +client`);
  req.on('close', () => removeSseClient('all', res));
});

app.get('/events/:deviceKey', requireLogin, async (req, res) => {
  const device = await resolveDevice(req.params.deviceKey);
  if (!device) return res.status(404).end();
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();
  res.write(':ok\n\n');
  addSseClient(device.id, res);
  console.log(`[SSE/${device.name}] +client`);
  req.on('close', () => removeSseClient(device.id, res));
});

// ── Ingest routes (ESP32 — no login required, device_key is auth) ──
app.post('/ingest', async (req, res) => {
  try {
    const s = req.body;
    if (!s.device_key)
      return res.status(400).json({ error: 'Missing device_key in body' });

    const device = await resolveDevice(s.device_key);
    if (!device)
      return res.status(404).json({ error: `Unknown device_key: ${s.device_key}`, hint: 'Add this device to the devices table first' });

    const { rows } = await pool.query(`
      INSERT INTO readings
        (device_id, lat, lng, alt_m, gps_valid,
         gyro_x, gyro_y, gyro_z, accel_x, accel_y, accel_z, sound)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING id, ts, gyro_mag, accel_mag`,
      [
        device.id,
        s.lat      ?? 0, s.lng      ?? 0, s.alt      ?? 0, s.gps_valid ?? false,
        s.gyro_x   ?? 0, s.gyro_y   ?? 0, s.gyro_z   ?? 0,
        s.accel_x  ?? 0, s.accel_y  ?? 0, s.accel_z  ?? 0, s.sound ?? 0
      ]
    );
    const reading = rows[0];

    await pool.query(`UPDATE devices SET last_seen = NOW() WHERE id = $1`, [device.id]);

    if (reading.accel_mag > 25) {
      await pool.query(
        `INSERT INTO alerts (device_id, reading_id, kind, detail) VALUES ($1,$2,'impact',$3)`,
        [device.id, reading.id, JSON.stringify({ accel_mag: reading.accel_mag })]
      );
      sseNotify(device.id, 'alert', {
        kind: 'impact', accel_mag: reading.accel_mag,
        ts: reading.ts, deviceKey: s.device_key, name: device.name
      });
    }
    if ((s.sound ?? 0) > 3000) {
      await pool.query(
        `INSERT INTO alerts (device_id, reading_id, kind, detail) VALUES ($1,$2,'loud',$3)`,
        [device.id, reading.id, JSON.stringify({ sound: s.sound })]
      );
      sseNotify(device.id, 'alert', {
        kind: 'loud', sound: s.sound,
        ts: reading.ts, deviceKey: s.device_key, name: device.name
      });
    }

    console.log(
      `[INGEST] ${device.name}  #${reading.id}` +
      `  gps:${s.gps_valid ? '✓' : '✗'}` +
      `  sound:${s.sound}  accel_mag:${reading.accel_mag?.toFixed(2)}`
    );

    sseNotify(device.id, 'update', {
      reading: {
        id: reading.id, ts: reading.ts, ...s,
        device_id: device.id, device_key: s.device_key,
        name: device.name, tag: device.tag,
        gyro_mag: reading.gyro_mag, accel_mag: reading.accel_mag
      },
      frames: []
    });

    res.json({ ok: true, readingId: reading.id, deviceId: device.id });
  } catch (err) {
    console.error('[INGEST] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/ingest-frame', async (req, res) => {
  const camId    = parseInt(req.query.cam) || 0;
  const ridParam = req.query.rid ? parseInt(req.query.rid) : null;
  const devKey   = req.query.key;

  if (!devKey) return res.status(400).json({ error: 'Missing ?key= param' });

  const device = await resolveDevice(devKey);
  if (!device) return res.status(404).json({ error: `Unknown device_key: ${devKey}` });

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) return res.status(400).json({ error: 'empty body' });

      let readingId = ridParam;
      if (!readingId) {
        const { rows } = await pool.query(
          `SELECT id FROM readings WHERE device_id = $1 ORDER BY ts DESC LIMIT 1`,
          [device.id]
        );
        readingId = rows[0]?.id ?? null;
      }

      const fname = `${Date.now()}_${device.id}_cam${camId}.jpg`;
      fs.writeFileSync(path.join(FRAMES_DIR, fname), buf);

      await pool.query(
        `INSERT INTO frames (reading_id, cam_id, filename, size_bytes) VALUES ($1,$2,$3,$4)`,
        [readingId, camId, fname, buf.length]
      );

      const url = `/frames/${fname}`;
      console.log(`[FRAME] ${device.name} cam${camId}  rid:${readingId}  ${buf.length}b`);

      sseNotify(device.id, 'update', {
        reading: null,
        frames: [{ camId, url, sizeBytes: buf.length }]
      });

      res.json({ ok: true, cam: camId, file: fname });
    } catch (err) {
      console.error('[FRAME] error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  req.on('error', err => {
    console.error('[FRAME] stream error:', err.message);
    res.status(500).json({ error: err.message });
  });
});

// ── API routes ──
app.get('/api/fleet', requireLogin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        d.id, d.device_key, d.name, d.tag, d.meta, d.last_seen,
        r.id AS reading_id, r.ts,
        r.lat, r.lng, r.alt_m, r.gps_valid,
        r.gyro_x, r.gyro_y, r.gyro_z, r.gyro_mag,
        r.accel_x, r.accel_y, r.accel_z, r.accel_mag,
        r.sound,
        f0.url AS cam0_url, f1.url AS cam1_url, f2.url AS cam2_url
      FROM devices d
      LEFT JOIN LATERAL (
        SELECT * FROM readings WHERE device_id = d.id ORDER BY ts DESC LIMIT 1
      ) r ON true
      LEFT JOIN LATERAL (
        SELECT '/frames/' || fr.filename AS url FROM frames fr
        JOIN readings rr ON fr.reading_id = rr.id
        WHERE rr.device_id = d.id AND fr.cam_id = 0 ORDER BY fr.id DESC LIMIT 1
      ) f0 ON true
      LEFT JOIN LATERAL (
        SELECT '/frames/' || fr.filename AS url FROM frames fr
        JOIN readings rr ON fr.reading_id = rr.id
        WHERE rr.device_id = d.id AND fr.cam_id = 1 ORDER BY fr.id DESC LIMIT 1
      ) f1 ON true
      LEFT JOIN LATERAL (
        SELECT '/frames/' || fr.filename AS url FROM frames fr
        JOIN readings rr ON fr.reading_id = rr.id
        WHERE rr.device_id = d.id AND fr.cam_id = 2 ORDER BY fr.id DESC LIMIT 1
      ) f2 ON true
      ORDER BY d.id
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/elephant/:key/latest', requireLogin, async (req, res) => {
  const device = await resolveDevice(req.params.key);
  if (!device) return res.status(404).json({ error: 'unknown device' });
  try {
    const r = await pool.query(
      `SELECT * FROM v_latest_reading WHERE device_id = $1`, [device.id]
    );
    const f = r.rows[0]
      ? await pool.query(`SELECT * FROM v_latest_frames WHERE device_id = $1`, [device.id])
      : { rows: [] };
    res.json({
      device:  { id: device.id, key: device.device_key, name: device.name, tag: device.tag, meta: device.meta || {} },
      reading: r.rows[0] || null,
      frames:  f.rows
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/elephant/:key/track', requireLogin, async (req, res) => {
  const device = await resolveDevice(req.params.key);
  if (!device) return res.status(404).json({ error: 'unknown device' });
  try {
    const { rows } = await pool.query(
      `SELECT ts, lat, lng, alt_m FROM gps_track WHERE device_id = $1 ORDER BY ts ASC`,
      [device.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/elephant/:key/history', requireLogin, async (req, res) => {
  const device = await resolveDevice(req.params.key);
  if (!device) return res.status(404).json({ error: 'unknown device' });
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
  try {
    const { rows } = await pool.query(`
      SELECT id, ts, lat, lng, alt_m, gps_valid,
             gyro_x, gyro_y, gyro_z, gyro_mag,
             accel_x, accel_y, accel_z, accel_mag, sound
      FROM readings WHERE device_id = $1
      ORDER BY ts DESC LIMIT $2`, [device.id, limit]
    );
    res.json(rows.reverse());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/elephant/:key/frames', requireLogin, async (req, res) => {
  const device = await resolveDevice(req.params.key);
  if (!device) return res.status(404).json({ error: 'unknown device' });
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  try {
    const { rows } = await pool.query(`
      SELECT f.cam_id AS "camId",
             '/frames/' || f.filename AS url,
             f.ts
      FROM frames f
      JOIN readings r ON f.reading_id = r.id
      WHERE r.device_id = $1
      ORDER BY f.ts DESC
      LIMIT $2
    `, [device.id, limit * 3]);
    res.json(rows);
  } catch (err) {
    console.error('[FRAMES]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/elephant/:key/alerts', requireLogin, async (req, res) => {
  const device = await resolveDevice(req.params.key);
  if (!device) return res.status(404).json({ error: 'unknown device' });
  const unseenOnly = req.query.unseen === 'true';
  try {
    const { rows } = await pool.query(`
      SELECT id, kind, detail, ts, seen FROM alerts
      WHERE device_id = $1 ${unseenOnly ? 'AND seen = FALSE' : ''}
      ORDER BY ts DESC LIMIT 50`, [device.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/alerts/:id/seen', requireLogin, async (req, res) => {
  try {
    await pool.query(`UPDATE alerts SET seen = TRUE WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Start ──
loadDevices().then(() => {
  server.listen(PORT, '0.0.0.0', () =>
    console.log(`[HTTP] Listening on :${PORT}`)
  );
}).catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});

process.on('SIGINT', () => { pool.end(); server.close(); process.exit(0); });