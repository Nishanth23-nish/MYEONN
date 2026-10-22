const fs = require('fs/promises');
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const mysqlUrl = process.env.MYSQL_URL || '';
let pool;
let setupPromise;

function useMySql() {
  return Boolean(mysqlUrl);
}

async function mysqlPool() {
  if (!useMySql()) return null;
  if (!pool) {
    const mysql = require('mysql2/promise');
    pool = mysql.createPool({
      uri: mysqlUrl,
      waitForConnections: true,
      connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 5),
      ssl: process.env.MYSQL_SSL === 'false' ? undefined : { rejectUnauthorized: false }
    });
  }
  return pool;
}

async function ensureSchema() {
  if (!useMySql()) return;
  if (!setupPromise) {
    setupPromise = (async () => {
      const connection = await mysqlPool();
      await connection.query(`
        CREATE TABLE IF NOT EXISTS myeonn_documents (
          document_key VARCHAR(128) PRIMARY KEY,
          payload JSON NOT NULL,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    })();
  }
  return setupPromise;
}

async function readLocalJson(fileName, fallback) {
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, fileName), 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function readJson(fileName, fallback) {
  if (!useMySql()) return readLocalJson(fileName, fallback);
  await ensureSchema();
  const connection = await mysqlPool();
  const [rows] = await connection.execute('SELECT payload FROM myeonn_documents WHERE document_key = ?', [fileName]);
  if (rows.length) {
    const value = rows[0].payload;
    return typeof value === 'string' ? JSON.parse(value) : value;
  }
  const seed = await readLocalJson(fileName, fallback);
  await writeJson(fileName, seed);
  return seed;
}

async function writeJson(fileName, value) {
  if (!useMySql()) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(path.join(DATA_DIR, fileName), JSON.stringify(value, null, 2) + '\n');
    return;
  }
  await ensureSchema();
  const connection = await mysqlPool();
  await connection.execute(
    'INSERT INTO myeonn_documents (document_key, payload) VALUES (?, ?) ON DUPLICATE KEY UPDATE payload = VALUES(payload)',
    [fileName, JSON.stringify(value)]
  );
}

module.exports = { ensureSchema, readJson, useMySql, writeJson };
