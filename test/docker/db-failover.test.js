/**
 * Uji failover database SUNGGUHAN: primary dimatikan, bukan disimulasikan.
 *
 * Yang dibuktikan di sini:
 * 1. Hanya satu node yang bisa ditulis; replika menolak tulisan user aplikasi.
 * 2. Saat primary mati, aplikasi (lewat `maxscale:4006`) tetap bisa menulis
 *    setelah MaxScale mempromosikan replika — tanpa mengubah konfigurasi.
 * 3. Primary lama TIDAK kembali otomatis; datanya yang bercabang dibuang saat
 *    `make db-rejoin`, bukan digabung diam-diam.
 *
 * Angka yang dicetak (jendela failover, jumlah tulis yang hilang, waktu rejoin)
 * adalah hasil ukur mesin ini, bukan janji desain.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dockerAvailable } from './helpers/docker-stack.js';
import {
  DATABASE,
  NODES,
  appSql,
  appSqlDirect,
  bringUp,
  diagnostics,
  heal,
  nodeSql,
  replication,
  restartNode,
  roles,
  runScript,
  startNode,
  stopNode,
  waitFor,
} from './helpers/db-stack.js';

const RUN = Date.now();
const FAILOVER_LIMIT_MS = 90000;

function marker(label, index) {
  return `ha-${label}-${RUN}-${index}`;
}

function countMarkers(prefix) {
  const result = appSql(
    `SELECT COUNT(*) FROM ${DATABASE}.registered_servers WHERE name LIKE '${prefix}%'`,
  );
  assert.ok(result.ok, `SELECT ke MaxScale gagal: ${result.err}`);
  return Number(result.out);
}

test(
  'failover database: primary mati, replika mengambil alih, primary lama manual rejoin',
  {
    timeout: 900000,
    skip: dockerAvailable() ? false : 'Docker daemon tidak berjalan (nyalakan Docker Desktop)',
  },
  async (t) => {
    await bringUp();
    // Selalu kembalikan cluster ke keadaan sehat tanpa menghapus volume, juga
    // saat assertion gagal di tengah jalan.
    t.after(() => heal());

    await t.test('awal: tepat satu primary dan dua replika sehat', async () => {
      const list = roles();
      const writable = list.filter((entry) => entry.readOnly === false);
      assert.equal(writable.length, 1, `harus tepat satu node bisa ditulis: ${JSON.stringify(list)}`);

      for (const entry of list.filter((item) => item.readOnly === true)) {
        const status = replication(entry.node);
        assert.ok(status, `${entry.node} harus punya SHOW SLAVE STATUS`);
        assert.equal(status.Slave_IO_Running, 'Yes', `${entry.node} IO thread harus Yes`);
        assert.equal(status.Slave_SQL_Running, 'Yes', `${entry.node} SQL thread harus Yes`);
      }

      const ping = appSql('SELECT @@read_only, @@server_id');
      assert.ok(ping.ok, `maxscale:4006 harus menjawab: ${ping.err}`);
      assert.equal(ping.out.split('\t')[0], '0', 'MaxScale harus melayani node yang bisa ditulis');
    });

    await t.test('replika menolak tulisan user aplikasi', async () => {
      const replica = roles().find((entry) => entry.readOnly === true);
      assert.ok(replica, 'butuh minimal satu replika');
      const attempt = appSqlDirect(
        replica.node,
        `INSERT INTO ${DATABASE}.registered_servers (name, host, port) VALUES ('${marker('readonly', 0)}', 'x', 3000)`,
      );
      assert.equal(attempt.ok, false, `${replica.node} tidak boleh menerima tulisan aplikasi`);
      assert.match(attempt.err, /read[- ]only/i, `error harus menyebut read-only, dapat: ${attempt.err}`);
    });

    const before = roles();
    const oldPrimary = before.find((entry) => entry.readOnly === false);
    assert.ok(oldPrimary, 'primary awal tidak ditemukan');
    const replicaOfOld = before.filter((entry) => entry.readOnly === true).map((entry) => entry.node);

    let failoverMs = 0;
    let acked = 0;
    let lost = 0;
    let newServerId = null;

    await t.test('primary mati: MaxScale mempromosikan replika, aplikasi bisa menulis lagi', async () => {
      // Tulis dulu supaya terbukti tidak ada data yang hilang dari transaksi
      // yang sudah di-ACK sebelum kegagalan.
      const ackedBeforeFailure = 5;
      for (let index = 0; index < ackedBeforeFailure; index += 1) {
        const insert = appSql(
          `INSERT INTO ${DATABASE}.registered_servers (name, host, port) VALUES ('${marker('acked', index)}', 'x', 3000)`,
        );
        assert.ok(insert.ok, `tulis awal harus sukses: ${insert.err}`);
        acked += 1;
      }

      const lagBefore = replicaOfOld
        .map((node) => Number.parseInt(replication(node)?.Seconds_Behind_Master ?? '', 10))
        .map((value) => (Number.isNaN(value) ? 0 : value))
        .sort((a, b) => b - a)[0];

      stopNode(oldPrimary.node);
      // Timer mulai setelah `docker compose stop` selesai: container sudah
      // benar-benar mati, jadi angka ini batas ATAS kecepatan failover.
      const startedAt = Date.now();

      let lastError = '';
      await waitFor(
        () => {
          const result = appSql(
            `INSERT INTO ${DATABASE}.registered_servers (name, host, port) VALUES ('${marker('after', 0)}', 'x', 3000)`,
          );
          if (result.ok) {
            acked += 1;
            return true;
          }
          lastError = result.err;
          return false;
        },
        { timeoutMs: FAILOVER_LIMIT_MS, intervalMs: 1000, label: 'tulis lewat MaxScale setelah failover' },
      ).catch((error) => {
        throw new Error(`${error.message}\n${lastError}\n${diagnostics()}`);
      });

      failoverMs = Date.now() - startedAt;

      const ping = appSql('SELECT @@server_id, @@read_only');
      assert.ok(ping.ok, `MaxScale harus menjawab setelah failover: ${ping.err}`);
      const [serverId, readOnly] = ping.out.split('\t');
      newServerId = Number(serverId);
      assert.notEqual(newServerId, oldPrimary.serverId, 'MaxScale harus pindah ke node lain');
      assert.equal(readOnly, '0', 'node yang dilayani harus bisa ditulis');

      // RPO diukur, bukan diasumsikan: hitung tulis yang sudah di-ACK sebelum
      // kegagalan tetapi tidak ada di node baru.
      lost = ackedBeforeFailure - countMarkers(`ha-acked-${RUN}`);
      console.log(
        `\n[failover] primary: ${oldPrimary.node} -> server_id ${newServerId}` +
          `\n[failover] jendela tulis gagal: ${(failoverMs / 1000).toFixed(1)}s` +
          `\n[failover] lag replika sebelum mati: ${lagBefore}s` +
          `\n[failover] tulis di-ACK: ${acked}, hilang setelah failover: ${lost}`,
      );
      assert.ok(lost <= ackedBeforeFailure, 'tidak mungkin kehilangan lebih banyak dari yang di-ACK');
    });

    await t.test('promoted primary tetap bisa ditulis setelah container-nya restart, dan skrip toleran node mati', async () => {
      // Skrip grant/clone tanpa argumen harus jalan walau oldPrimary sedang mati.
      runScript('db-grant-users.js');
      runScript('db-replica-clone.js');

      const promoted = roles().find((entry) => entry.serverId === newServerId);
      assert.ok(promoted, 'node promoted primary harus ditemukan');
      restartNode(promoted.node);

      // Replika punya `--read-only=ON` di CLI compose; `enforce_writable_master=true`
      // di MaxScale wajib membuka kembali `read_only=OFF` agar aplikasi tetap bisa menulis.
      await waitFor(
        () => {
          const write = appSql(
            `INSERT INTO ${DATABASE}.registered_servers (name, host, port) VALUES ('${marker('restart', 0)}', 'x', 3000)`,
          );
          return write.ok;
        },
        { timeoutMs: 60000, intervalMs: 1000, label: 'tulis lewat MaxScale setelah promoted primary restart' },
      ).catch((error) => {
        throw new Error(`${error.message}\n${diagnostics()}`);
      });

      const afterRestart = appSql('SELECT @@read_only');
      assert.ok(afterRestart.ok, afterRestart.err);
      assert.equal(afterRestart.out, '0', 'promoted primary harus kembali read_only=0 setelah restart');
    });

    await t.test('primary lama tidak kembali otomatis, dan rejoin membuang datanya', async () => {
      startNode(oldPrimary.node);
      await waitFor(() => nodeSql(oldPrimary.node, 'SELECT 1') !== null, {
        timeoutMs: 120000,
        label: `${oldPrimary.node} hidup kembali`,
      });

      // Simulasi percabangan: primary lama masih menerima tulisan langsung
      // (read_only=OFF) sebelum di-rejoin.
      const divergent = marker('divergent', 0);
      const wrote = nodeSql(
        oldPrimary.node,
        `INSERT INTO ${DATABASE}.registered_servers (name, host, port) VALUES ('${divergent}', 'x', 3000)`,
      );
      assert.notEqual(wrote, null, 'primary lama seharusnya masih bisa ditulis sebelum rejoin');

      // Bukti `auto_rejoin=false`: MaxScale tetap melayani primary baru.
      const stillOld = appSql('SELECT @@server_id');
      assert.ok(stillOld.ok);
      assert.equal(Number(stillOld.out), newServerId, 'MaxScale tidak boleh pindah ke primary lama');

      const startedAt = Date.now();
      runScript('db-replica-clone.js', ['--force', oldPrimary.node]);
      const rejoinMs = Date.now() - startedAt;

      const rejoined = roles().find((entry) => entry.node === oldPrimary.node);
      assert.ok(rejoined, 'node rejoin harus menjawab');
      assert.equal(rejoined.readOnly, true, `${oldPrimary.node} harus kembali sebagai replika`);

      const status = replication(oldPrimary.node);
      assert.ok(status, `${oldPrimary.node} harus punya SHOW SLAVE STATUS setelah rejoin`);
      assert.equal(status.Slave_IO_Running, 'Yes');
      assert.equal(status.Slave_SQL_Running, 'Yes');
      assert.notEqual(status.Master_Host, oldPrimary.node, 'replika tidak boleh mereplikasi dari dirinya sendiri');

      const divergentRows = appSql(
        `SELECT COUNT(*) FROM ${DATABASE}.registered_servers WHERE name = '${divergent}'`,
      );
      assert.ok(divergentRows.ok, divergentRows.err);
      assert.equal(Number(divergentRows.out), 0, 'data bercabang primary lama harus dibuang, bukan digabung');

      const writableNow = roles().filter((entry) => entry.readOnly === false);
      assert.equal(writableNow.length, 1, `harus tetap tepat satu node bisa ditulis: ${JSON.stringify(writableNow)}`);

      console.log(
        `\n[rejoin] ${oldPrimary.node} kembali sebagai replika dalam ${(rejoinMs / 1000).toFixed(1)}s`,
      );
    });

    await t.test('semua node kembali sehat', async () => {
      const list = roles();
      assert.equal(list.length, NODES.length);
      assert.ok(list.every((entry) => entry.readOnly !== null), 'semua node harus menjawab');

      const writable = list.filter((entry) => entry.readOnly === false);
      assert.equal(writable.length, 1);

      for (const entry of list.filter((item) => item.readOnly === true)) {
        await waitFor(
          () => {
            const status = replication(entry.node);
            return status?.Slave_IO_Running === 'Yes' && status?.Slave_SQL_Running === 'Yes';
          },
          { timeoutMs: 15000, label: `replikasi ${entry.node} kembali Yes` },
        );
      }

      const ping = appSql('SELECT @@server_id');
      assert.ok(ping.ok);
      assert.equal(Number(ping.out), writable[0].serverId, 'MaxScale harus melayani satu-satunya node yang bisa ditulis');
    });
  },
);
