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
COPY src-tauri/tauri.conf.json ./src-tauri/tauri.conf.json
COPY src-tauri/capabilities ./src-tauri/capabilities
COPY --from=frontend-builder /app/dist ./dist

WORKDIR /app/src-tauri
RUN cargo build --release --bin rclone-manager-headless --features web-server

# Stage 3: Runtime
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip fuse3 libgtk-3-0 libwebkit2gtk-4.1-0 \
    libayatana-appindicator3-1 xvfb dbus-x11 openssl \
    && rm -rf /var/lib/apt/lists/*

# Install rclone
RUN curl -O https://downloads.rclone.org/rclone-current-linux-amd64.zip && \
    unzip -q rclone-current-linux-amd64.zip && \
    cp rclone-*-linux-amd64/rclone /usr/bin/ && \
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

# Generate TLS certificate
RUN openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout ./cert.pem -out ./cert.pem \
    -subj "/C=TR/ST=Denial/L=Springfield/O=Dis/CN=localhost" && \
    chmod 644 ./cert.pem && \
    chown rclone-manager:rclone-manager ./cert.pem

# Create entrypoint script
RUN echo '#!/bin/bash\n\
set -e\n\
mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix\n\
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true\n\
Xvfb :99 -screen 0 1024x768x24 -nolisten tcp &\n\
XVFB_PID=$!\n\
sleep 2\n\
if ! ps -p $XVFB_PID > /dev/null; then echo "Failed to start Xvfb"; exit 1; fi\n\
export $(dbus-launch)\n\
trap "kill $XVFB_PID 2>/dev/null || true" EXIT\n\
exec /usr/local/bin/rclone-manager-headless "$@"\n\
' > /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh

USER rclone-manager

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f https://localhost:8080/api/health || exit 1

ENV DISPLAY=:99 \
    RCLONE_CONFIG=/home/rclone-manager/.config/rclone/rclone.conf

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["--host", "0.0.0.0", "--port", "8080", "--tls-cert", "cert.pem", "--tls-key", "cert.pem"]

