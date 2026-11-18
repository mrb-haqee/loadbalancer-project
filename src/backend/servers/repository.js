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

export async function listServers() {
  const [rows] = await measureDbQuery('list', () =>
    getPool().query(`SELECT ${COLUMNS} FROM registered_servers ORDER BY name ASC, id ASC`),
  );
  return rows.map(mapRow);
}

export async function getServer(id) {
  const [rows] = await measureDbQuery('get', () =>
    getPool().execute(`SELECT ${COLUMNS} FROM registered_servers WHERE id = ? LIMIT 1`, [id]),
  );
  return rows.length ? mapRow(rows[0]) : null;
}

export async function createServer(input) {
  const [result] = await measureDbQuery('insert', () =>
    getPool().execute(
      `INSERT INTO registered_servers (name, host, port, weight, enabled, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [input.name, input.host, input.port, input.weight, input.enabled ? 1 : 0, input.note],
    ),
  );
  return getServer(result.insertId);
}

export async function updateServer(id, input) {
  await measureDbQuery('update', () =>
    getPool().execute(
      `UPDATE registered_servers
          SET name = ?, host = ?, port = ?, weight = ?, enabled = ?, note = ?
        WHERE id = ?`,
      [input.name, input.host, input.port, input.weight, input.enabled ? 1 : 0, input.note, id],
    ),
  );
  // Dibaca ulang supaya respons selalu berisi nilai terbaru, termasuk updated_at.
  return getServer(id);
}

export async function deleteServer(id) {
  const [result] = await measureDbQuery('delete', () =>
    getPool().execute('DELETE FROM registered_servers WHERE id = ?', [id]),
  );
  return result.affectedRows > 0;
}
