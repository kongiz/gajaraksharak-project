-- ════════════════════════════════════════════════════════════════
--  seed-devices.sql
--  Run this ONCE to add all 20 elephants to the devices table.
--
--  How to run:
--    psql -d gejarastha -f seed-devices.sql
--  Or paste into your PostgreSQL client (pgAdmin, DBeaver, etc.)
-- ════════════════════════════════════════════════════════════════

-- Make sure the devices table has the columns we need
-- (skip this block if your table already exists)
CREATE TABLE IF NOT EXISTS devices (
  id         SERIAL PRIMARY KEY,
  device_key TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  tag        TEXT NOT NULL,
  last_seen  TIMESTAMPTZ
);

-- Insert all 20 elephants
-- device_key  = what you program into each ESP32 (must be unique)
-- name        = display name shown on the dashboard
-- tag         = short collar ID shown on the map
INSERT INTO devices (device_key, name, tag) VALUES
  ('ESP32-ELEPHANT-01', 'Elephant 1',  'GJ-01'),
  ('ESP32-ELEPHANT-02', 'Elephant 2',  'GJ-02'),
  ('ESP32-ELEPHANT-03', 'Elephant 3',  'GJ-03'),
  ('ESP32-ELEPHANT-04', 'Elephant 4',  'GJ-04'),
  ('ESP32-ELEPHANT-05', 'Elephant 5',  'GJ-05'),
  ('ESP32-ELEPHANT-06', 'Elephant 6',  'GJ-06'),
  ('ESP32-ELEPHANT-07', 'Elephant 7',  'GJ-07'),
  ('ESP32-ELEPHANT-08', 'Elephant 8',  'GJ-08'),
  ('ESP32-ELEPHANT-09', 'Elephant 9',  'GJ-09'),
  ('ESP32-ELEPHANT-10', 'Elephant 10', 'GJ-10'),
  ('ESP32-ELEPHANT-11', 'Elephant 11', 'GJ-11'),
  ('ESP32-ELEPHANT-12', 'Elephant 12', 'GJ-12'),
  ('ESP32-ELEPHANT-13', 'Elephant 13', 'GJ-13'),
  ('ESP32-ELEPHANT-14', 'Elephant 14', 'GJ-14'),
  ('ESP32-ELEPHANT-15', 'Elephant 15', 'GJ-15'),
  ('ESP32-ELEPHANT-16', 'Elephant 16', 'GJ-16'),
  ('ESP32-ELEPHANT-17', 'Elephant 17', 'GJ-17'),
  ('ESP32-ELEPHANT-18', 'Elephant 18', 'GJ-18'),
  ('ESP32-ELEPHANT-19', 'Elephant 19', 'GJ-19'),
  ('ESP32-ELEPHANT-20', 'Elephant 20', 'GJ-20')
ON CONFLICT (device_key) DO NOTHING;  -- safe to run multiple times

-- Verify
SELECT id, device_key, name, tag FROM devices ORDER BY id;