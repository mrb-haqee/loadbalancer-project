-- Dijalankan MariaDB di cluster SEKALI, saat PVC masih kosong.
-- Kredensial demo, sama dengan default .env.example. Untuk latihan saja.
CREATE DATABASE IF NOT EXISTS lb_demo;

CREATE USER IF NOT EXISTS 'lb_app'@'%' IDENTIFIED BY 'lb_app_password';
GRANT ALL PRIVILEGES ON lb_demo.* TO 'lb_app'@'%';
-- MaxScale memperingatkan autentikasi bila user service tidak bisa melihat
-- daftar database (klien login dengan nama database).
GRANT SHOW DATABASES ON *.* TO 'lb_app'@'%';
-- MaxScale membaca metadata akun dari mysql.* saat menyusun cache autentikasi.
GRANT SELECT ON mysql.* TO 'lb_app'@'%';

CREATE USER IF NOT EXISTS 'lb_monitor'@'%' IDENTIFIED BY 'lb_monitor_password';
GRANT REPLICATION CLIENT, PROCESS, RELOAD, SUPER, SLAVE MONITOR ON *.* TO 'lb_monitor'@'%';
GRANT REPLICA MONITOR, READ_ONLY ADMIN, CONNECTION ADMIN ON *.* TO 'lb_monitor'@'%';
GRANT SELECT ON mysql.* TO 'lb_monitor'@'%';

CREATE USER IF NOT EXISTS 'lb_exporter'@'%' IDENTIFIED BY 'lb_exporter_password';
GRANT PROCESS, REPLICATION CLIENT, SLAVE MONITOR ON *.* TO 'lb_exporter'@'%';

FLUSH PRIVILEGES;
