import { getPool } from '../db.js';
import { measureDbQuery } from '../db-metrics.js';

const COLUMNS = 'id, name, host, port, weight, enabled, note, created_at, updated_at';

function mapRow(row) {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    weight: row.weight,
    enabled: Boolean(row.enabled),
    note: row.note,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

async function fetchServerById(id, db) {
  const conn = db ?? (await getPool());
  const [rows] = await conn.execute(`SELECT ${COLUMNS} FROM registered_servers WHERE id = ? LIMIT 1`, [id]);
  return rows.length ? mapRow(rows[0]) : null;
}

export async function listServers(db) {
  const conn = db ?? (await getPool());
  const [rows] = await measureDbQuery('list', () =>
    conn.query(`SELECT ${COLUMNS} FROM registered_servers ORDER BY name ASC, id ASC`),
  );
  return rows.map(mapRow);
}

export async function getServer(id, db) {
  return measureDbQuery('get', () => fetchServerById(id, db));
}

export async function createServer(input, db) {
  const conn = db ?? (await getPool());
  const [result] = await measureDbQuery('insert', () =>
    conn.execute(
      `INSERT INTO registered_servers (name, host, port, weight, enabled, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [input.name, input.host, input.port, input.weight, input.enabled ? 1 : 0, input.note],
    ),
  );
  return fetchServerById(result.insertId, conn);
}

export async function updateServer(id, input, db) {
  const conn = db ?? (await getPool());
  const [result] = await measureDbQuery('update', () =>
    conn.execute(
      `UPDATE registered_servers
          SET name = ?, host = ?, port = ?, weight = ?, enabled = ?, note = ?
        WHERE id = ?`,
      [input.name, input.host, input.port, input.weight, input.enabled ? 1 : 0, input.note, id],
    ),
  );
  if (result.affectedRows === 0) return null;
  return fetchServerById(id, conn);
}

export async function deleteServer(id, db) {
  const conn = db ?? (await getPool());
  const [result] = await measureDbQuery('delete', () =>
    conn.execute('DELETE FROM registered_servers WHERE id = ?', [id]),
  );
  return result.affectedRows > 0;
}
