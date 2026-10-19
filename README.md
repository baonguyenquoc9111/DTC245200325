# DTC245200325

## Blog with Docker, MySQL, Nginx, Prometheus, Grafana, and Loki

This project is a Node.js blog application backed by MySQL and deployed through Docker Compose. It includes an Nginx reverse proxy, Prometheus metrics collection, Grafana dashboards, and Loki log aggregation.

## Stack

- Node.js + Express app
- MySQL 8.4
- phpMyAdmin
- Nginx reverse proxy
- Prometheus
- Grafana
- Loki + Promtail

## Local access

- Web app: http://localhost:3001
- Nginx: http://localhost:8081
- phpMyAdmin: http://localhost:8080
- Prometheus: http://localhost:9090
- Grafana: http://localhost:3002
- Loki health: http://localhost:3100/ready
- Loki logs: open Grafana at http://localhost:3002 and select Explore > Loki

## Default credentials

- Blog admin username: value of `ADMIN_USERNAME` in `.env` if set, otherwise `admin`
- Blog admin password: value of `ADMIN_PASSWORD` in `.env`
- Grafana username: `admin`
- Grafana password: value of `GF_SECURITY_ADMIN_PASSWORD` in `.env`

## Project structure

- `index.js` — Express application and API
- `index.html` — frontend HTML shell
- `compose.yaml` — Docker Compose services
- `Dockerfile` — app container build
- `nginx/default.conf` — Nginx reverse proxy and headers
- `prometheus/prometheus.yml` — Prometheus scrape config
- `grafana/provisioning/datasources/datasource.yml` — Grafana datasource config
- `loki/loki-config.yaml` — Loki configuration
- `promtail/promtail-config.yaml` — log shipping config

## Run the project

```bash
docker compose up -d --build
```

To stop it:

```bash
docker compose down
```

## Monitoring and logs

### Prometheus

Open http://localhost:9090 and try queries such as:

```promql
up
rate(http_requests_total[5m])
```

### Grafana

Open http://localhost:3002 and log in with:

- user: `admin`
- password: `admin`

Prometheus and Loki datasources are provisioned automatically. The `My Blog - Operations Overview` dashboard is also provisioned and includes application availability, MySQL connectivity, container count, HTTP request rate and latency, container CPU/memory, and recent logs.

### Loki / LogQL

Try queries like:

```logql
{job="docker"} |= "ERROR"
{job="docker"} |~ "GET|POST"
```

## Hardening notes

- Nginx adds security headers such as `X-Frame-Options`, `X-Content-Type-Options`, and `Referrer-Policy`.
- Only required ports are exposed.
- Secrets are kept in `.env` and should not be committed to GitHub.

## GitHub / repository

The source code is hosted at [DTC245200325](https://github.com/baonguyenquoc9111/DTC245200325).

```bash
git clone https://github.com/baonguyenquoc9111/DTC245200325.git
cd DTC245200325
docker compose up -d --build
```

## Notes

- The app is designed for local Docker development and monitoring demonstration.
- The `.env` file contains sensitive environment values and should remain local.
