const { Pool } = require('pg');

let pool = null;

/**
 * Lazily creates the real PostgreSQL pool from DATABASE_URL.
 * Tests can bypass this entirely by calling setPool() with a fake pool
 * (e.g. a pg-mem adapter) before any queries run.
 */
function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL is not set. Copy .env.example to .env and fill in your Postgres connection string.'
      );
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Most hosted Postgres providers (Render, Supabase, Neon) require SSL.
      ssl: process.env.DATABASE_URL.includes('localhost')
        ? false
        : { rejectUnauthorized: false },
    });
  }
  return pool;
}

/** Used by tests to inject an in-memory / mock pool. */
function setPool(customPool) {
  pool = customPool;
}

function query(text, params) {
  return getPool().query(text, params);
}

/** Returns a checked-out client for running a multi-statement transaction. */
function getClient() {
  return getPool().connect();
}

module.exports = { getPool, setPool, query, getClient };
