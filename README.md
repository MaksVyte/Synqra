# ⚡ Synqra Server

> High-performance real-time collaboration & sync server for the **Synqra** Obsidian plugin.

---

## ✨ Features

- **Live Concurrent Editing**: Real-time multi-cursor collaboration powered by high-performance Rust Yjs CRDTs.
- **Excalidraw Whiteboard Sync**: Smooth, low-latency drawing synchronization on `.excalidraw` and `.excalidraw.md` canvases at 30+ FPS.
- **Server Password Protection**: Only users with your server password can connect to sync notes and files.
- **Admin Room Controls**: Server admins can create, view, and delete isolated collaboration rooms directly from the Obsidian plugin settings. Typo room creation by regular users is strictly prevented.
- **Conflict-Free Vault Sync**: Authoritative server architecture ensures zero text collisions or desynchronization.
- **Self-Hosted & Private**: 100% control over your data. Runs on any VPS, Proxmox LXC, Raspberry Pi, or local server.

---

## 🚀 Server Deployment (Portainer)

Deploy your Synqra server in under a minute directly through Portainer:

1. Open **Portainer** → Select your environment → Navigate to **Stacks**.
2. Click **+ Add stack**.
3. Name your stack: `synqra`.
4. Select **Repository** as the build method.
5. Enter the repository details:
   - **Repository URL**: `https://github.com/MaksVyte/Synqra` (or your repository URL)
   - **Repository reference**: `refs/heads/main`
   - **Compose path**: `docker-compose.yml`
6. Under **Environment variables**, click **+ add environment variable** to set your passwords:
   - `SERVER_PASSWORD` = `your_chosen_server_password` *(password you give to users/collaborators)*
   - `ADMIN_PASSWORD` = `your_chosen_admin_password` *(password for room creation & management)*
7. Click **Deploy the stack**. 

Portainer will clone the repository, build the Rust container, and launch the server with persistent storage on port `5612`.

---

## ⚙️ Environment Variables Reference

| Variable | Default | Description |
| :--- | :--- | :--- |
| `SERVER_PASSWORD` | `changethispassword` | Password required by clients to connect and sync notes. |
| `ADMIN_PASSWORD` | `adminchangethispassword` | Password required to unlock the Admin Panel and create/delete rooms. |
| `PORT` | `5612` | Port the server listens on inside the container. |
| `HOST` | `0.0.0.0` | Bind address. |
| `DATA_DIR` | `/data` | Path to persistent storage volume. |

---

## 📱 Obsidian Plugin Setup

1. Install the **Synqra** plugin in Obsidian (from Community Plugins or your plugin manager).
2. Open Obsidian **Settings** → **Synqra - Live Collaboration**.
3. Enter your **Server URL**: `ws://<your-server-ip>:5612` (or `wss://collab.yourdomain.com`).
4. Enter the **Server Password** provided by the server host.
5. Enter the **Room ID** (e.g. `vault-a`).
6. Set your **Display Name** and **Cursor Color**.

### 🛠️ Admin Room Controls:
1. In the plugin settings, scroll down to **Server Admin Controls**.
2. Enter your `ADMIN_PASSWORD` and click **Unlock Admin Panel**.
3. You can now create new collaboration rooms, view active rooms and online peers, or delete unused rooms.

---

## 📄 License
MIT License
