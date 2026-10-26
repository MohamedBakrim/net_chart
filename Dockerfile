# syntax=docker/dockerfile:1
# Bakrim (streambert) web app - multi-stage build.
# Build context MUST be the app source directory:
#   docker build -f net_chart/Dockerfile -t <repo>/bakrim:<tag> C:\Users\idk\Desktop\homenet\streambert

# ---------- build stage ----------
# Debian-based (not alpine): esbuild/rollup ship glibc binaries that do not run on musl.
FROM node:20-slim AS build
WORKDIR /app

# The web build does not need the Electron binary (~100MB download)
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

# Install dependencies first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci

# Copy sources and build the static site
COPY . .
RUN npm run build:web

# ---------- runtime stage ----------
# nginxinc/nginx-unprivileged runs as uid 101 and listens on 8080,
# which matches the chart's securityContext (runAsUser: 101, non-root).
FROM nginxinc/nginx-unprivileged:1.27-alpine

# NOTE: when deploying with the net_chart Helm chart, /etc/nginx/conf.d/default.conf
# is supplied by the chart's ConfigMap (mounted as a subPath volume), which also
# provides the /healthz probe endpoint. For a plain `docker run`, mount it manually:
#   -v ./net_chart/nginx.conf:/etc/nginx/conf.d/default.conf:ro
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

USER 101:101
