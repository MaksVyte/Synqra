# ⚡ Synqra

> Real-time multi-user live collaboration, note syncing, and Excalidraw whiteboards for Obsidian via a self-hosted relay server.

---

## ✨ Features

- **Live Concurrent Editing**: Real-time multi-cursor collaboration powered by high-performance Yjs CRDTs (Rust backend).
- **Excalidraw Whiteboard Sync**: Draw simultaneously with peers on `.excalidraw` and `.excalidraw.md` canvases at 30+ FPS.
- **Server Password Protection**: Only authorized users with your host password can connect.
- **Admin Room Controls**: Server admins can create, view, and delete isolated collaboration rooms directly inside Obsidian settings. Typo room creation by regular users is strictly prevented.
- **Conflict-Free Vault Sync**: Authoritative server architecture ensures zero text collisions or desynchronization.
- **Self-Hosted & Private**: Complete control over your data. Runs on any VPS, Proxmox LXC, Raspberry Pi, or local server.

---

## 🚀 Server Deployment (Self-Hosting)

You can host your own Synqra relay server in under a minute using Docker or Portainer.

### Method 1: Portainer (1-Click via Git Repository)

1. In **Portainer**, navigate to **Stacks** → Click **+ Add stack**.
2. Name your stack: `synqra`.
3. Select **Repository** as the build method.
4. Fill in the repository details:
   - **Repository URL**: `https://github.com/YOUR_USERNAME/Synqra` (or your repository URL)
   - **Repository reference**: `refs/heads/main`
   - **Compose path**: `server/docker-compose.yml`
5. Under **Environment variables**, configure your passwords:
   - `SERVER_PASSWORD`: `your_secure_server_password` (password given to friends/collaborators)
   - `ADMIN_PASSWORD`: `your_secure_admin_password` (password used in plugin to create/delete rooms)
6. Click **Deploy the stack**. Portainer will clone the repository, build the container, and launch the server automatically.

---

### Method 2: Docker Compose CLI (Linux / Proxmox LXC / VPS)

```bash
# 1. Clone the repository
git clone https://github.com/YOUR_USERNAME/Synqra.git
cd Synqra/server

# 2. Build and launch the container in the background
docker compose up -d --build

# 3. Verify server is running and healthy
curl http://127.0.0.1:5612/health
```

---

## ⚙️ Server Configuration

| Variable | Default | Description |
| :--- | :--- | :--- |
| `SERVER_PASSWORD` | `changethispassword` | Password required by clients to connect and sync notes. |
| `ADMIN_PASSWORD` | `adminchangethispassword` | Password required to unlock the Admin Panel and create/delete rooms. |
| `PORT` | `5612` | Port the server listens on inside the container. |
| `HOST` | `0.0.0.0` | Bind address. |
| `DATA_DIR` | `/data` | Path to persistent storage volume. |

---

## 📱 Installing the Obsidian Plugin

### Method A: Using BRAT (Recommended for Beta Testing)
1. Install the **BRAT** (Beta Reviewers Auto-update Tester) plugin from Obsidian Community Plugins.
2. In Obsidian **Settings** → **BRAT** → Click **Add Beta plugin**.
3. Paste your GitHub repository URL: `https://github.com/YOUR_USERNAME/Synqra`.
4. Enable **Synqra** under Community Plugins.

### Method B: Manual Installation
1. Download the three release files: `main.js`, `manifest.json`, and `styles.css` from the repository (`client/obsidian-sample-plugin/`).
2. Inside your Obsidian vault folder, create a new folder:
   `.obsidian/plugins/synqra/`
3. Copy `main.js`, `manifest.json`, and `styles.css` into that folder.
4. In Obsidian **Settings** → **Community Plugins**, toggle on **Synqra**.

---

## 🔒 Connecting to Your Server

1. Open Obsidian **Settings** → **Synqra - Live Collaboration**.
2. Enter your **Server URL**: `ws://<your-server-ip>:5612` (or `wss://collab.yourdomain.com`).
3. Enter the **Server Password** provided by the server host.
4. Enter the **Room ID** you want to join (e.g. `vault-a`).
5. Choose your **Display Name** and **Cursor Color**.

### 🛠️ Admin Room Controls:
1. Scroll down to **Server Admin Controls** in the plugin settings.
2. Enter your `ADMIN_PASSWORD` and click **Unlock Admin Panel**.
3. You can now:
   - **View Live Rooms**: Check real-time connected users and active document counts.
   - **Create New Rooms**: Enter a Room ID (e.g. `work-vault`) to initialize a new room on the server.
   - **Switch Rooms**: Switch your active vault connection with 1-click.
   - **Delete Rooms**: Permanently remove unused rooms and clean up server storage.

---

## 📄 License
MIT License
