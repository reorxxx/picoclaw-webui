# 🦞 PicoClaw WebUI

A premium, multi-agent web interface for **PicoClaw** — your personal AI assistant. Designed for speed, portability, and visual excellence.

## ✨ Features

- **Multi-Agent Workspace**: Manage multiple AI agents, each with its own independent workspace:
  - `IDENTITY.md`, `SOUL.md`, `USER.md`, `AGENT.md`, etc.
  - Automatic injection of workspace memory into the system prompt.
- **PicoClaw Agent Integration**:
  - **Hybrid Mode**: Toggle between direct LLM API and `picoclaw agent` subprocess.
  - **Tool & Skill Support**: Full support for PicoClaw tools and skills in subprocess mode.
  - **Real-time Tool Logs**: View tool execution logs directly in the chat interface.
- **Session Management**:
  - **Independent Sessions**: Multiple conversations per agent.
  - **Per-Session Model Override**: Specify a different model for each session.
  - **Token Estimation**: Real-time context window token count display.
- **Personalization**:
  - **Agent Avatars**: Set unique avatars (image or emoji) for each agent.
  - **Display Names**: Friendly display names used throughout the interface.
  - **Premium UI**: Glassmorphism design with smooth animations, dark mode, and optimized layout.
- **Deployment Ready**:
  - Robust path resolution for Linux/Raspberry Pi (handles missing `HOME` env).
  - Built-in diagnostic logging for quick troubleshooting.

## 🚀 Getting Started

### Prerequisites

- [PicoClaw](https://github.com/picoclaw/picoclaw) installed or source code available.
- Node.js (v18+)

### Installation

1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```

2. Start the services:
   ```bash
   # Quick start script (starts both frontend and backend in background)
   chmod +x start.sh
   ./start.sh
   
   # Or manual start:
   # Terminal 1: Frontend (Dev)
   npm run dev
   # Terminal 2: Backend
   node server.js
   ```

3. Open [http://localhost:3000](http://localhost:3000) in your browser.

## ⚙️ Running Modes

The WebUI supports two modes for interacting with the PicoClaw core:

1. **Binary Mode (Default)**: Uses the installed `picoclaw` binary.
2. **Source Mode**: Runs PicoClaw directly from source code using `go run`.
   - Set environment variable: `PICOCLAW_SOURCE=true`
   - Expects `picoclaw_src` directory to be at the same level as `picoclaw-webui`.

## 📂 Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PICOCLAW_CONFIG` | Path to `config.json` | `~/.picoclaw/config.json` |
| `PICOCLAW_SOURCE` | Set to `true` to run from source | `false` |
| `PORT` | Backend API port | `3001` |

## 🛠 Project Structure

- `server.js`: Node/Express backend handling PicoClaw config, sessions, and subprocess routing.
- `src/App.tsx`: Main React application with a responsive, modern sidebar and chat UI.
- `webui.json`: Stored inside each agent's workspace to persist UI-specific metadata like avatars.

## 🤝 Native PicoClaw Compatibility

The WebUI reads and writes directly to standard PicoClaw file structures (`~/.picoclaw/config.json` and session JSON files), ensuring your data remains portable and compatible with the CLI.

## 🌐 Deployment (Nginx)

For production deployment (especially on Raspberry Pi), it is recommended to build the frontend and serve it via Nginx:

1. **Build the frontend**:
   ```bash
   npm run build
   ```
   This creates a `dist` folder.

2. **Nginx Configuration**:

```nginx
server {
    listen 80;
    server_name your-ip-or-domain;

    # Frontend (Served from the 'dist' directory)
    location / {
        root /path/to/picoclaw-webui/dist;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    # Backend API Proxy
    location /api/ {
        proxy_pass http://localhost:3001/api/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # Static Avatars Proxy
    location /avatars/ {
        proxy_pass http://localhost:3001/avatars/;
    }
}
```

## 📜 License

MIT
