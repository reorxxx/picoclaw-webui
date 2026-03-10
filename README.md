# 🦞 PicoClaw WebUI

A premium, multi-agent web interface for **PicoClaw** — your personal AI assistant.

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
  - **Cleanup**: Delete sessions with a simple click.
- **Personalization**:
  - **Agent Avatars**: Set unique avatars (image or emoji) for each agent, stored in their workspace.
  - **User Identity**: Global user avatar configuration.
  - **Premium UI**: Glassmorphism design with smooth animations and dark mode.

## 🚀 Getting Started

### Prerequisites

- [PicoClaw](https://github.com/picoclaw/picoclaw) installed and configured.
- Node.js (v18+)

### Installation

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the development server:
   ```bash
   # Terminal 1: Frontend
   npm run dev

   # Terminal 2: Backend
   node server.js
   ```

3. Open [http://localhost:3000](http://localhost:3000) in your browser.

## 🛠 Project Structure

- `server.js`: Node/Express backend handling PicoClaw config, sessions, and subprocess routing.
- `src/App.tsx`: Main React application with a responsive, modern sidebar and chat UI.
- `webui.json`: Stored inside each agent's workspace to persist UI-specific metadata like avatars.

## 🤝 Native PicoClaw Compatibility

The WebUI reads and writes directly to standard PicoClaw file structures (`~/.picoclaw/config.json` and session JSON files), ensuring your data remains portable and compatible with the CLI.
