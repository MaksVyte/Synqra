# Deployment Guide: Synqra Server

## Overview

The Synqra Server is a high-performance Rust backend providing:
- **Authoritative Yjs CRDT synchronization** for live multi-user editing, cursors, and Excalidraw whiteboards.
- **Server Password Protection**: Only authorized users with the server password can connect.
- **Admin Room Management**: Restrict room creation to server admins with an admin password. Typo room creation by regular clients is prevented.
- **Persistent Data Storage**: All document states and binary files are stored in `/data`.

---

## 🔑 Environment Variables & Security

| Variable | Default | Description |
| :--- | :--- | :--- |
| `SERVER_PASSWORD` | `changethispassword` | Required password for clients to connect and sync notes. |
| `ADMIN_PASSWORD` | `adminchangethispassword` | Required password to create and delete rooms via plugin admin controls or REST API. |
| `PORT` | `5612` | Port the server listens on inside the container. |
| `HOST` | `0.0.0.0` | Bind address. |
| `DATA_DIR` | `/data` | Path to persistent storage volume. |

> [!IMPORTANT]
> Always change `SERVER_PASSWORD` and `ADMIN_PASSWORD` in your production deployment stack!

---

## 🚀 Deployment Methods

### Option 1: Portainer Stack (Recommended for Self-Hosters)

1. Open **Portainer** → Select your environment (e.g. `local` / `docker`).
2. Go to **Stacks** → Click **+ Add stack**.
3. Name your stack: `synqra`.
4. Select **Web editor** and paste the following compose configuration:

```yaml
services:
  synqra-server:
    image: synqra-server:latest
    # Or if building from local files:
    # build:
    #   context: .
    #   dockerfile: Dockerfile
    container_name: synqra-server
    restart: unless-stopped
    ports:
      - "5612:5612"
    environment:
      HOST: 0.0.0.0
      PORT: "5612"
      DATA_DIR: /data
      SERVER_PASSWORD: "your_secure_server_password_here"
      ADMIN_PASSWORD: "your_secure_admin_password_here"
    volumes:
      - synqra-data:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://127.0.0.1:5612/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

volumes:
  synqra-data:
```

5. Under **Environment variables**, you can also set or override `SERVER_PASSWORD` and `ADMIN_PASSWORD`.
6. Click **Deploy the stack**.

---

### Option 2: Building & Starting with Docker Compose (CLI)

If you are deploying on a Linux machine / VPS / Proxmox LXC:

1. Upload the `server/` directory to `/opt/synqra-server` (e.g. via Git or SFTP).
2. SSH into your machine:

```bash
cd /opt/synqra-server

# Build the Rust binary in Docker and launch the container:
docker compose up -d --build

# Verify container is healthy:
docker ps
curl http://127.0.0.1:5612/health
```

---

### Option 3: Publishing a Pre-Built Image (For Public Users)

To make it effortless for anyone in the public to run your server without needing a Rust toolchain:

#### 1. Build and push to Docker Hub
```bash
# Log in to Docker Hub
docker login

# Build image with your Docker Hub username
docker build -t yourusername/synqra-server:latest ./server

# Push image to Docker Hub
docker push yourusername/synqra-server:latest
```

#### 2. Users can then deploy with 1-click
Anyone can deploy your server simply using this `docker-compose.yml`:
```yaml
services:
  synqra-server:
    image: yourusername/synqra-server:latest
    container_name: synqra-server
    restart: unless-stopped
    ports:
      - "5612:5612"
    environment:
      SERVER_PASSWORD: "changethispassword"
      ADMIN_PASSWORD: "adminchangethispassword"
    volumes:
      - synqra-data:/data
```

---

## 🛠️ Reverse Proxy & SSL (Nginx Proxy Manager / Caddy / Cloudflare)

When connecting over HTTPS/WSS from outside your local network or mobile phones, route traffic through a reverse proxy:

### Nginx Proxy Manager configuration:
- **Domain Names**: `collab.yourdomain.com`
- **Scheme**: `http`
- **Forward Hostname / IP**: `<your-server-internal-ip>`
- **Forward Port**: `5612`
- **Websockets Support**: **Enabled** (Required!)
- **Block Common Exploits**: Enabled
- **SSL**: Request Let's Encrypt Certificate, enable `Force SSL` and `HTTP/2 Support`.

---

## 📱 Connecting from the Obsidian Plugin

1. Open Obsidian **Settings** → **Community Plugins** → **Synqra - Live Collaboration**.
2. **Server URL**: `ws://<your-ip>:5612` (or `wss://collab.yourdomain.com`).
3. **Server Password**: Enter the `SERVER_PASSWORD` configured on the host.
4. **Room ID**: Enter an existing room ID (e.g. `vault-a`).

### Admin Controls:
1. Scroll down to **Server Admin Controls** in the plugin settings.
2. Enter your `ADMIN_PASSWORD` and click **Unlock Admin Panel**.
3. You can now:
   - **Create New Rooms**: Enter a Room ID (e.g. `team-vault`) and click **Create Room**.
   - **View Live Rooms**: See active peer counts and document counts.
   - **Switch / Join Rooms**: Switch your active vault to any room.
   - **Delete Rooms**: Permanently delete unused rooms and erase their data from the server.