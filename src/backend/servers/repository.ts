import { asc, eq } from 'drizzle-orm';
import { getDb, type AppDatabase } from '../db';
import { measureDbQuery } from '../db-metrics';
import { registeredServers } from '../schema';
import type { ServerInput } from './validation';

export type ServerRecord = {
  id: number;
  name: string;
  host: string;
  port: number;
  weight: number;
  enabled: boolean;
  note: string | null;
  createdAt: string;
  updatedAt: string;
};

type ServerRow = typeof registeredServers.$inferSelect;

const INSERT_SQL =
  'INSERT INTO registered_servers (name, host, port, weight, enabled, note) VALUES (?, ?, ?, ?, ?, ?)';
const UPDATE_SQL =
  'UPDATE registered_servers SET name = ?, host = ?, port = ?, weight = ?, enabled = ?, note = ? WHERE id = ?';

/** MariaDB mengembalikan `YYYY-MM-DD HH:MM:SS` (UTC); kontrak API memakai ISO-8601. */
export function toIso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  return value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
}

function mapRow(row: ServerRow): ServerRecord {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    weight: row.weight,
    enabled: Boolean(row.enabled),
    note: row.note,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

async function fetchServerById(id: number, db: AppDatabase): Promise<ServerRecord | null> {
  const [row] = await db.select().from(registeredServers).where(eq(registeredServers.id, id)).limit(1);
  return row ? mapRow(row) : null;
}

export async function listServers(db: AppDatabase = getDb()): Promise<ServerRecord[]> {
  return measureDbQuery('list', async () => {
    const rows = await db
      .select()
      .from(registeredServers)
      .orderBy(asc(registeredServers.name), asc(registeredServers.id));
    return rows.map(mapRow);
  });
}

export async function getServer(id: number, db: AppDatabase = getDb()): Promise<ServerRecord | null> {
  return measureDbQuery('get', () => fetchServerById(id, db));
}

export async function createServer(input: ServerInput, db: AppDatabase = getDb()): Promise<ServerRecord> {
  // Tulis pakai Bun SQL langsung: Drizzle 1.0-rc belum meneruskan insertId dari
  // driver Bun (hasil `db.insert()` selalu kosong), sedangkan kontrak CRUD butuh
  // id baris baru untuk header Location dan body 201.
  const result = await measureDbQuery('insert', () =>
    db.$client.unsafe(INSERT_SQL, [
      input.name,
      input.host,
      input.port,
      input.weight,
      input.enabled ? 1 : 0,
      input.note,
    ]),
  );
  const created = await fetchServerById(Number(result.lastInsertRowid), db);
  // Nama unik sehingga baris pasti ada; null hanya mungkin saat replikasi tertinggal.
  return created as ServerRecord;
}

export async function updateServer(
  id: number,
  input: ServerInput,
  db: AppDatabase = getDb(),
): Promise<ServerRecord | null> {
  const result = await measureDbQuery('update', () =>
    db.$client.unsafe(UPDATE_SQL, [
      input.name,
      input.host,
      input.port,
      input.weight,
      input.enabled ? 1 : 0,
      input.note,
      id,
    ]),
  );
  if (result.affectedRows === 0) return null;
  return fetchServerById(id, db);
}

export async function deleteServer(id: number, db: AppDatabase = getDb()): Promise<boolean> {
  const result = await measureDbQuery('delete', () =>
    db.$client.unsafe('DELETE FROM registered_servers WHERE id = ?', [id]),
  );
  return result.affectedRows > 0;
}
