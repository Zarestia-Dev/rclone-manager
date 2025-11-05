# Multi-stage Dockerfile for RClone Manager Headless Server (TESTING)
# Stage 1: Build Angular frontend
FROM node:20-alpine AS frontend-builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source files
COPY . .

# Build Angular application
RUN npm run build

# Stage 2: Build Rust backend
FROM debian:bookworm-slim AS backend-builder

# Install Rust nightly and build dependencies
RUN apt-get update && apt-get install -y \
    curl \
    build-essential \
    pkg-config \
    libssl-dev \
    libdbus-1-dev \
    libsoup-3.0-dev \
    libjavascriptcoregtk-4.1-dev \
    libwebkit2gtk-4.1-dev \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Install Rust nightly
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain nightly
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /app

# Copy Cargo files
COPY src-tauri/Cargo.toml src-tauri/Cargo.lock ./src-tauri/

# Copy source code
COPY src-tauri/src ./src-tauri/src
COPY src-tauri/icons ./src-tauri/icons
COPY src-tauri/build.rs ./src-tauri/build.rs
COPY src-tauri/tauri.conf.json ./src-tauri/tauri.conf.json
COPY src-tauri/capabilities ./src-tauri/capabilities

# Copy built frontend from previous stage
COPY --from=frontend-builder /app/dist ./dist

# Build the headless binary with optimizations
WORKDIR /app/src-tauri
RUN cargo build --release --bin rclone-manager-headless --features web-server

# Stage 3: Runtime - slim Debian image
FROM debian:bookworm-slim

# Install runtime dependencies including GTK libraries and Xvfb for virtual display
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        unzip \
        fuse3 \
        libgtk-3-0 \
        libwebkit2gtk-4.1-0 \
        libayatana-appindicator3-1 \
        xvfb \
        dbus-x11 \
    && rm -rf /var/lib/apt/lists/*

# Install rclone
RUN curl -O https://downloads.rclone.org/rclone-current-linux-amd64.zip && \
    unzip rclone-current-linux-amd64.zip && \
    cd rclone-*-linux-amd64 && \
    cp rclone /usr/bin/ && \
    chown root:root /usr/bin/rclone && \
    chmod 755 /usr/bin/rclone && \
    cd .. && \
    rm -rf rclone-*-linux-amd64 rclone-current-linux-amd64.zip

# Create non-root user
RUN useradd -m -u 1000 rclone-manager && \
    mkdir -p /home/rclone-manager/.config/rclone-manager && \
    chown -R rclone-manager:rclone-manager /home/rclone-manager

# Copy the built binary
COPY --from=backend-builder /app/src-tauri/target/release/rclone-manager-headless /usr/local/bin/

# Copy the frontend dist files to match expected path
COPY --from=frontend-builder /app/dist/rclone-manager/browser /usr/share/rclone-manager/dist/rclone-manager/browser

# Set working directory where the app will look for static files
WORKDIR /usr/share/rclone-manager

# Switch to non-root user
USER rclone-manager

# Expose the default port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/api/health || exit 1

# Set environment variables
ENV RUST_LOG=info
ENV RCLONE_CONFIG=/home/rclone-manager/.config/rclone/rclone.conf
ENV DISPLAY=:99

# Create startup script that runs Xvfb and the application
USER root
RUN echo '#!/bin/bash\n\
set -e\n\
# Start Xvfb in background\n\
Xvfb :99 -screen 0 1024x768x24 -nolisten tcp &\n\
XVFB_PID=$!\n\
# Wait for X to start\n\
sleep 2\n\
# Start dbus\n\
export $(dbus-launch)\n\
# Run the application as rclone-manager user\n\
exec su rclone-manager -c "/usr/local/bin/rclone-manager-headless $*"\n\
' > /usr/local/bin/entrypoint.sh && \
    chmod +x /usr/local/bin/entrypoint.sh

# Run the headless server with Xvfb wrapper
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["--host", "0.0.0.0", "--port", "8080"]
