# Load balancer demo: Traefik + 5 backend + MariaDB + monitoring k6.
#
# Seluruh perintah operasional project ada di sini (sebelumnya di package.json
# "scripts"). Butuh GNU Make. Di Windows recipe sengaja dijalankan lewat cmd.exe
# supaya tidak bergantung pada shell Unix yang kebetulan ada di PATH; di
# Linux/macOS dipakai /bin/sh bawaan. Setiap recipe tetap satu perintah utuh.

ifeq ($(OS),Windows_NT)
SHELL := cmd.exe
endif

NODE ?= node
BUN  ?= bun

COMPOSE_DB      := docker compose -p lb-db -f docker-compose.db.yml
COMPOSE_TRAEFIK := docker compose -p lb-traefik -f docker-compose.traefik.yml
COMPOSE_DEMO    := docker compose -p lb-demo -f docker-compose.yml
COMPOSE_K6      := docker compose -p lb-k6 -f docker-compose.monitoring.yml

MAKEFLAGS += --no-print-directory

# stack-up/stack-down bergantung pada urutan, bukan paralelisme.
.NOTPARALLEL:

.DEFAULT_GOAL := help

.PHONY: help \
	net-up \
	db-up db-down db-reset db-ps db-logs db-grant-exporter \
	traefik-up traefik-down traefik-logs \
	docker-up docker-down docker-ps docker-logs \
	k6-up k6-run k6-watch k6-down k6-logs \
	stack stack-up stack-down clean \
	test test-backend test-docker \
	k6-install k6 k6-load k6-failover

help:
	@echo Daftar target Makefile:
	@echo   Stack:
	@echo     make stack-up          Nyalakan network, database, Traefik, backend, monitoring
	@echo     make stack-down        Matikan semuanya dengan urutan yang benar
	@echo     make stack             Sama dengan stack-up
	@echo     make clean             stack-down + hapus image lokal lb-demo - volume tetap
	@echo   Network:
	@echo     make net-up            Buat network bersama lb-net - idempotent
	@echo   Database:
	@echo     make db-up             MariaDB + Adminer, lalu segarkan user lb_exporter
	@echo     make db-down           Matikan MariaDB + Adminer - data di volume tetap
	@echo     make db-reset          Hapus volume DB, buat ulang skema + seed, grant ulang
	@echo     make db-ps             Status + health container database
	@echo     make db-logs           Log MariaDB + Adminer
	@echo     make db-grant-exporter Buat/segarkan user monitoring lb_exporter
	@echo   Traefik:
	@echo     make traefik-up        Traefik saja - project lb-traefik
	@echo     make traefik-down      Matikan Traefik
	@echo     make traefik-logs      Access log Traefik
	@echo   Backend:
	@echo     make docker-up         5 backend dengan build ulang - project lb-demo
	@echo     make docker-down       Matikan 5 backend
	@echo     make docker-ps         Status + health container backend
	@echo     make docker-logs       Log 5 backend
	@echo   Monitoring:
	@echo     make k6-up             Grafana, InfluxDB, Prometheus, exporter, Loki, Alloy
	@echo     make k6-run            Jalankan k6 sekali di container
	@echo     make k6-watch          k6 + web dashboard di http://k6.localhost
	@echo     make k6-down           Matikan stack monitoring - data di volume tetap
	@echo     make k6-logs           Log InfluxDB/Grafana/k6
	@echo   Test:
	@echo     make test              Test Docker end-to-end - butuh Docker
	@echo     make test-backend      Unit test validasi CRUD + metrik DB - tanpa Docker
	@echo     make test-docker       Sama dengan make test
	@echo   k6 lokal:
	@echo     make k6-install        Unduh binary k6 resmi ke tools/k6/ - butuh Bun
	@echo     make k6                Cek versi k6 yang terpasang
	@echo     make k6-load          100 req/detik selama 15 detik
	@echo     make k6-failover      50 req/detik selama 40 detik - untuk uji failover

# --- network bersama -------------------------------------------------------

net-up:
	$(NODE) scripts/network.js

# --- database --------------------------------------------------------------

db-up:
	$(COMPOSE_DB) up -d && $(NODE) scripts/db-grant-exporter.js

db-down:
	$(COMPOSE_DB) down

db-reset:
	$(COMPOSE_DB) down -v && $(COMPOSE_DB) up -d && $(NODE) scripts/db-grant-exporter.js

db-ps:
	$(COMPOSE_DB) ps

db-logs:
	$(COMPOSE_DB) logs --tail=80

db-grant-exporter:
	$(NODE) scripts/db-grant-exporter.js

# --- traefik ---------------------------------------------------------------

traefik-up:
	$(COMPOSE_TRAEFIK) up -d

traefik-down:
	$(COMPOSE_TRAEFIK) down

traefik-logs:
	$(COMPOSE_TRAEFIK) logs --tail=80

# --- backend ---------------------------------------------------------------

docker-up:
	$(COMPOSE_DEMO) up -d --build

docker-down:
	$(COMPOSE_DEMO) down --remove-orphans

docker-ps:
	$(COMPOSE_DEMO) ps

docker-logs:
	$(COMPOSE_DEMO) logs --tail=80

# --- monitoring ------------------------------------------------------------

k6-up:
	$(COMPOSE_K6) up -d --build influxdb grafana prometheus k6-runner mysqld-exporter loki alloy

k6-run:
	$(COMPOSE_K6) run --rm k6

k6-watch:
	$(COMPOSE_K6) run --rm --service-ports -e K6_WEB_DASHBOARD=true k6

k6-down:
	$(COMPOSE_K6) down --remove-orphans

k6-logs:
	$(COMPOSE_K6) logs --tail=80

# --- seluruh stack ---------------------------------------------------------

stack: stack-up

# Prasyarat dijalankan berurutan karena .NOTPARALLEL di atas.
stack-up: net-up db-up traefik-up docker-up k6-up

stack-down: k6-down docker-down traefik-down db-down

clean: stack-down
	$(COMPOSE_DEMO) down --rmi local

# --- test ------------------------------------------------------------------

test:
	$(NODE) --test --test-reporter=spec test/docker/lb-docker.test.js

test-docker: test

test-backend:
	$(NODE) --test --test-reporter=spec "test/backend/*.test.js"

# --- k6 lokal (binary, bukan container) ------------------------------------

k6-install:
	$(BUN) scripts/install-k6.js

k6:
	$(BUN) scripts/k6.js

k6-load:
	$(BUN) scripts/k6.js run k6/load-test.js

k6-failover:
	$(BUN) scripts/k6.js run k6/failover.js -e DURATION=40s

