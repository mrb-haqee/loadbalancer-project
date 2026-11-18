-- Dijalankan MariaDB SEKALI, saat volume lb-db-data masih kosong.
-- Perubahan di file ini tidak berlaku pada volume yang sudah berisi data:
-- gunakan `make db-reset` untuk membuang volume lalu menjalankannya lagi.

CREATE TABLE IF NOT EXISTS registered_servers (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(64) NOT NULL,
  host VARCHAR(255) NOT NULL,
  port SMALLINT UNSIGNED NOT NULL,
  weight TINYINT UNSIGNED NOT NULL DEFAULT 1,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  note VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_registered_servers_name (name),
  CONSTRAINT chk_registered_servers_port CHECK (port BETWEEN 1 AND 65535),
  CONSTRAINT chk_registered_servers_weight CHECK (weight BETWEEN 1 AND 100)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed: lima backend yang memang ada di docker-compose.yml.
-- Katalog ini hanya data demo; rotasi Traefik tetap ditentukan label container.
INSERT IGNORE INTO registered_servers (name, host, port, weight, enabled, note) VALUES
  ('server-1', 'server-1', 3000, 1, 1, 'Backend pertama di docker-compose.yml'),
  ('server-2', 'server-2', 3000, 1, 1, 'Backend kedua di docker-compose.yml'),
  ('server-3', 'server-3', 3000, 1, 1, 'Backend ketiga di docker-compose.yml'),
  ('server-4', 'server-4', 3000, 1, 1, 'Backend keempat di docker-compose.yml'),
  ('server-5', 'server-5', 3000, 1, 1, 'Backend kelima di docker-compose.yml');
