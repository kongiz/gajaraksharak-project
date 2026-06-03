require('dotenv').config();
const express  = require('express');
const http     = require('http');
const { Pool } = require('pg');
const fs       = require('fs');
const path     = require('path');


const PORT       = process.env.PORT || 3000;
const FRAMES_DIR = path.join(__dirname, 'public', 'frames');

if (!fs.existsSync(FRAMES_DIR)) fs.mkdirSync(FRAMES_DIR, { recursive: true });


const pool = new Pool({
  connectionString: process.env.DATABASE_URL
    || 'postgresql://postgres:password@localhost:5432/gejarastha'
});


const deviceCache = new Map();

async function loadDevices() {
  const { rows } = await pool.query(
    `SELECT id, device_key, name, tag FROM devices ORDER BY id`
  );
  rows.forEach(r => deviceCache.set(r.device_key, r));
  console.log(`[DB]  loaded ${rows.length} devices`);
  if (rows.length === 0) {
    console.warn('[DB]  WARNING: no devices found — run seed-devices.sql first');
  }
}

async function resolveDevice(key) {
  if (deviceCache.has(key)) return deviceCache.get(key);
  // Not in cache — try DB (might have been added after startup)
  const { rows } = await pool.query(
    `SELECT id, device_key, name, tag FROM devices WHERE device_key = $1`, [key]
  );
  if (!rows.length) return null;
  deviceCache.set(key, rows[0]);
  return rows[0];
}


const sseClients = new Map();

function sseNotify(deviceId, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  // Notify subscribers of this specific elephant
  if (sseClients.has(deviceId)) {
    for (const res of sseClients.get(deviceId)) res.write(msg);
  }
  // Notify fleet-level subscribers
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

// Express app + HTTP server setup
const app    = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/frames', express.static(FRAMES_DIR));

// SSE: fleet-level (all elephants) — dashboard connects here for map + alerts feed
app.get('/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();
  res.write(':ok\n\n');
  addSseClient('all', res);
  console.log(`[SSE/all] +client`);
  req.on('close', () => removeSseClient('all', res));
});

// SSE: elephant-specific — detail view connects here for live updates
app.get('/events/:deviceKey', async (req, res) => {
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

// ESP32 DevKit posts sensor data here. We store in DB and trigger alerts + SSE updates.
app.post('/ingest', async (req, res) => {
  try {
    const s = req.body;

    if (!s.device_key) {
      return res.status(400).json({ error: 'Missing device_key in body' });
    }

    const device = await resolveDevice(s.device_key);
    if (!device) {
      return res.status(404).json({
        error: `Unknown device_key: ${s.device_key}`,
        hint:  'Add this device to the devices table first'
      });
    }

    const { rows } = await pool.query(`
      INSERT INTO readings
        (device_id,
         lat, lng, alt_m, gps_valid,
         gyro_x,  gyro_y,  gyro_z,
         accel_x, accel_y, accel_z,
         sound)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING id, ts, gyro_mag, accel_mag`,
      [
        device.id,
        s.lat      ?? 0,  s.lng      ?? 0,  s.alt      ?? 0,
        s.gps_valid ?? false,
        s.gyro_x   ?? 0,  s.gyro_y   ?? 0,  s.gyro_z   ?? 0,
        s.accel_x  ?? 0,  s.accel_y  ?? 0,  s.accel_z  ?? 0,
        s.sound    ?? 0
      ]
    );
    const reading = rows[0];

    await pool.query(`UPDATE devices SET last_seen = NOW() WHERE id = $1`, [device.id]);

    // Auto-alerts
    if (reading.accel_mag > 25) {
      await pool.query(
        `INSERT INTO alerts (device_id, reading_id, kind, detail)
         VALUES ($1, $2, 'impact', $3)`,
        [device.id, reading.id, JSON.stringify({ accel_mag: reading.accel_mag })]
      );
      sseNotify(device.id, 'alert', {
        kind: 'impact', accel_mag: reading.accel_mag,
        ts: reading.ts, deviceKey: s.device_key, name: device.name
      });
    }
    if ((s.sound ?? 0) > 3000) {
      await pool.query(
        `INSERT INTO alerts (device_id, reading_id, kind, detail)
         VALUES ($1, $2, 'loud', $3)`,
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
        device_id:  device.id,
        device_key: s.device_key,
        name:       device.name,
        tag:        device.tag,
        gyro_mag:   reading.gyro_mag,
        accel_mag:  reading.accel_mag
      },
      frames: []
    });

    res.json({ ok: true, readingId: reading.id, deviceId: device.id });

  } catch (err) {
    console.error('[INGEST] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Frames (images) are posted here as multipart/form-data with ?cam=0&key=DEVICE_KEY and optional ?rid=READING_ID to link to a specific reading. If ?rid is missing, we link to the latest reading for that device.
app.post('/ingest-frame', async (req, res) => {
  const camId    = parseInt(req.query.cam)  || 0;
  const ridParam = req.query.rid ? parseInt(req.query.rid) : null;
  const devKey   = req.query.key;

  if (!devKey) return res.status(400).json({ error: 'Missing ?key= param' });

  const device = await resolveDevice(devKey);
  if (!device)  return res.status(404).json({ error: `Unknown device_key: ${devKey}` });

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end',  async () => {
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
        `INSERT INTO frames (reading_id, cam_id, filename, size_bytes)
         VALUES ($1, $2, $3, $4)`,
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


// All devices + their latest reading in one call
// Used by the fleet map on the dashboard
app.get('/api/fleet', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        d.id, d.device_key, d.name, d.tag, d.last_seen,
        r.id         AS reading_id,
        r.ts,
        r.lat,        r.lng,        r.alt_m,   r.gps_valid,
        r.gyro_x,     r.gyro_y,     r.gyro_z,  r.gyro_mag,
        r.accel_x,    r.accel_y,    r.accel_z, r.accel_mag,
        r.sound,
        f0.url       AS cam0_url,
        f1.url       AS cam1_url,
        f2.url       AS cam2_url
      FROM devices d
      LEFT JOIN LATERAL (
        SELECT * FROM readings
        WHERE device_id = d.id
        ORDER BY ts DESC LIMIT 1
      ) r ON true
      LEFT JOIN LATERAL (
        SELECT '/frames/' || fr.filename AS url
        FROM frames fr
        JOIN readings rr ON fr.reading_id = rr.id
        WHERE rr.device_id = d.id AND fr.cam_id = 0
        ORDER BY fr.id DESC LIMIT 1
      ) f0 ON true
      LEFT JOIN LATERAL (
        SELECT '/frames/' || fr.filename AS url
        FROM frames fr
        JOIN readings rr ON fr.reading_id = rr.id
        WHERE rr.device_id = d.id AND fr.cam_id = 1
        ORDER BY fr.id DESC LIMIT 1
      ) f1 ON true
      LEFT JOIN LATERAL (
        SELECT '/frames/' || fr.filename AS url
        FROM frames fr
        JOIN readings rr ON fr.reading_id = rr.id
        WHERE rr.device_id = d.id AND fr.cam_id = 2
        ORDER BY fr.id DESC LIMIT 1
      ) f2 ON true
      ORDER BY d.id
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// Latest reading + frames for one elephant
app.get('/api/elephant/:key/latest', async (req, res) => {
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
      device:  { id: device.id, key: device.device_key, name: device.name, tag: device.tag },
      reading: r.rows[0] || null,
      frames:  f.rows
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GPS track for one elephant
app.get('/api/elephant/:key/track', async (req, res) => {
  const device = await resolveDevice(req.params.key);
  if (!device) return res.status(404).json({ error: 'unknown device' });
  try {
    const { rows } = await pool.query(`
      SELECT ts, lat, lng, alt_m
      FROM   gps_track
      WHERE  device_id = $1
      ORDER  BY ts ASC`, [device.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Sensor history for one elephant
app.get('/api/elephant/:key/history', async (req, res) => {
  const device = await resolveDevice(req.params.key);
  if (!device) return res.status(404).json({ error: 'unknown device' });
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
  try {
    const { rows } = await pool.query(`
      SELECT id, ts,
             lat, lng, alt_m, gps_valid,
             gyro_x, gyro_y, gyro_z, gyro_mag,
             accel_x, accel_y, accel_z, accel_mag,
             sound
      FROM   readings
      WHERE  device_id = $1
      ORDER  BY ts DESC
      LIMIT  $2`, [device.id, limit]
    );
    res.json(rows.reverse());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Alerts for one elephant (or all if no key given)
app.get('/api/elephant/:key/alerts', async (req, res) => {
  const device = await resolveDevice(req.params.key);
  if (!device) return res.status(404).json({ error: 'unknown device' });
  const unseenOnly = req.query.unseen === 'true';
  try {
    const { rows } = await pool.query(`
      SELECT id, kind, detail, ts, seen
      FROM   alerts
      WHERE  device_id = $1
        ${unseenOnly ? 'AND seen = FALSE' : ''}
      ORDER  BY ts DESC LIMIT 50`, [device.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mark alert seen
app.patch('/api/alerts/:id/seen', async (req, res) => {
  try {
    await pool.query(`UPDATE alerts SET seen = TRUE WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Start server after loading devices into cache
loadDevices().then(() => {
  server.listen(PORT, '0.0.0.0', () =>
    console.log(`[HTTP] Listening on :${PORT}`)
  );
}).catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});

process.on('SIGINT', () => { pool.end(); server.close(); process.exit(0); });