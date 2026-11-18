import { int, mysqlTable, smallint, tinyint, timestamp, varchar } from 'drizzle-orm/mysql-core';

/**
 * Cermin tabel `registered_servers` di db/init/001-schema.sql.
 * SQL init tetap sumber kebenaran schema; file ini hanya memberi tipe ke query.
 */
export const registeredServers = mysqlTable('registered_servers', {
  id: int('id', { unsigned: true }).autoincrement().primaryKey(),
  name: varchar('name', { length: 64 }).notNull(),
  host: varchar('host', { length: 255 }).notNull(),
  port: smallint('port', { unsigned: true }).notNull(),
  weight: tinyint('weight', { unsigned: true }).notNull().default(1),
  enabled: tinyint('enabled').notNull().default(1),
  note: varchar('note', { length: 255 }),
  createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow().onUpdateNow(),
});
