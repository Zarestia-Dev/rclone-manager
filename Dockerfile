# Multi-stage Dockerfile for RClone Manager Headless Server
# Stage 1: Build Angular frontend
FROM node:alpine AS frontend-builder

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Build Rust backend
FROM debian:bookworm-slim AS backend-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl build-essential pkg-config libssl-dev libdbus-1-dev \
    libsoup-3.0-dev libjavascriptcoregtk-4.1-dev libwebkit2gtk-4.1-dev \
    && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain nightly
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /app
COPY src-tauri/Cargo.toml src-tauri/Cargo.lock ./src-tauri/
COPY src-tauri/src ./src-tauri/src
COPY src-tauri/icons ./src-tauri/icons
COPY src-tauri/build.rs ./src-tauri/build.rs
# Copy headless configuration and capabilities
COPY src-tauri/tauri.conf.headless.json ./src-tauri/tauri.conf.json
# We don't need the capabilities for the headless build
# COPY src-tauri/capabilities ./src-tauri/capabilities
COPY --from=frontend-builder /app/dist ./dist

# Create empty directory for headless build
RUN mkdir -p /app/src-tauri/empty

WORKDIR /app/src-tauri
RUN cargo build --release --bin rclone-manager-headless --features web-server

# Stage 3: Runtime
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip fuse3 libgtk-3-0 libwebkit2gtk-4.1-0 \
    libayatana-appindicator3-1 xvfb dbus-x11 openssl \
    && rm -rf /var/lib/apt/lists/*

# Install rclone (multi-arch support)
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "arm64" ]; then RCLONE_ARCH="arm64"; else RCLONE_ARCH="amd64"; fi && \
    curl -O https://downloads.rclone.org/rclone-current-linux-${RCLONE_ARCH}.zip && \
    unzip -q rclone-current-linux-${RCLONE_ARCH}.zip && \
    cp rclone-*-linux-${RCLONE_ARCH}/rclone /usr/bin/ && \
    chmod 755 /usr/bin/rclone && \
    rm -rf rclone-*

# Create non-root user
RUN useradd -m -u 1000 rclone-manager && \
    mkdir -p /home/rclone-manager/.config/rclone-manager && \
    mkdir -p /app && \
    chown -R rclone-manager:rclone-manager /home/rclone-manager /app

WORKDIR /app

# Copy built binaries and frontend
COPY --from=backend-builder /app/src-tauri/target/release/rclone-manager-headless /usr/local/bin/
COPY --from=frontend-builder /app/dist/rclone-manager/browser ./dist/rclone-manager/browser

# Create directory for optional TLS certificates (mount your own certs here)
RUN mkdir -p /app/certs && \
    chown rclone-manager:rclone-manager /app/certs

# Create entrypoint script with environment variable support
RUN echo '#!/bin/bash\n\
set -e\n\
\n\
# Setup virtual display\n\
mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix\n\
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true\n\
Xvfb :99 -screen 0 1024x768x24 -nolisten tcp &\n\
XVFB_PID=$!\n\
sleep 2\n\
if ! ps -p $XVFB_PID > /dev/null; then echo "Failed to start Xvfb"; exit 1; fi\n\
export $(dbus-launch)\n\
trap "kill $XVFB_PID 2>/dev/null || true" EXIT\n\
\n\
# Build command line arguments from environment variables\n\
ARGS=()\n\
\n\
# Add host if set\n\
if [ -n "$RCLONE_MANAGER_HOST" ]; then\n\
    ARGS+=("--host" "$RCLONE_MANAGER_HOST")\n\
fi\n\
\n\
# Add port if set\n\
if [ -n "$RCLONE_MANAGER_PORT" ]; then\n\
    ARGS+=("--port" "$RCLONE_MANAGER_PORT")\n\
fi\n\
\n\
# Add authentication if set\n\
if [ -n "$RCLONE_MANAGER_USER" ]; then\n\
    ARGS+=("--user" "$RCLONE_MANAGER_USER")\n\
fi\n\
if [ -n "$RCLONE_MANAGER_PASS" ]; then\n\
    ARGS+=("--pass" "$RCLONE_MANAGER_PASS")\n\
fi\n\
\n\
# Add TLS if certificates are provided\n\
if [ -n "$RCLONE_MANAGER_TLS_CERT" ]; then\n\
    ARGS+=("--tls-cert" "$RCLONE_MANAGER_TLS_CERT")\n\
fi\n\
if [ -n "$RCLONE_MANAGER_TLS_KEY" ]; then\n\
    ARGS+=("--tls-key" "$RCLONE_MANAGER_TLS_KEY")\n\
fi\n\
\n\
# Execute with environment args first, then command line args\n\
exec /usr/local/bin/rclone-manager-headless "${ARGS[@]}" "$@"\n\
' > /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh

USER rclone-manager

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f https://localhost:8080/api/health || exit 1

ENV DISPLAY=:99 \
    RCLONE_CONFIG=/home/rclone-manager/.config/rclone/rclone.conf

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD []

