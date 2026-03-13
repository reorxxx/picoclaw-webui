import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Path & Home Helpers (Fixed for Raspberry Pi / deployment environments) ---
function getHomeDir() {
  return os.homedir() || process.env.HOME || '/home/pi'; // last fallback for common raspbian setup
}

const HOME = getHomeDir();
const PICOCLAW_CONFIG_PATH = process.env.PICOCLAW_CONFIG || path.join(HOME, '.picoclaw', 'config.json');
const CRON_FILE = path.join(HOME, '.picoclaw', 'web_cron.json');
const CRON_LOG = path.join(HOME, '.picoclaw', 'web_cron.log');

console.log('--- PicoClaw WebUI Backend Initializing ---');
console.log(`[INIT] Resolved HOME: ${HOME}`);
console.log(`[INIT] CONFIG PATH: ${PICOCLAW_CONFIG_PATH}`);
console.log(`[INIT] CRON FILE: ${CRON_FILE}`);
console.log('-------------------------------------------');

// --- Web Cron Service ---

function logCron(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(CRON_LOG, line);
  console.log(line.trim());
}

function readCronTasks() {
  try {
    if (fs.existsSync(CRON_FILE)) {
      return JSON.parse(fs.readFileSync(CRON_FILE, 'utf8'));
    }
  } catch (e) { console.error('Error reading cron file:', e); }
  return [];
}

function saveCronTasks(tasks) {
  try {
    fs.writeFileSync(CRON_FILE, JSON.stringify(tasks, null, 2));
  } catch (e) { console.error('Error saving cron file:', e); }
}

const runningCronTasks = new Set();

// Background scheduler
setInterval(() => {
  const now = Date.now();
  let tasks = readCronTasks();

  for (const task of tasks) {
    if (task.enabled && task.nextRun <= now && !runningCronTasks.has(task.id)) {
      runningCronTasks.add(task.id);
      logCron(`Executing task: ${task.name} (${task.message}) for agent ${task.agentKey}`);

      (async () => {
        try {
          await executeScheduledTask(task);
        } finally {
          let freshTasks = readCronTasks();
          let freshTask = freshTasks.find(t => t.id === task.id);
          if (freshTask) {
            freshTask.lastFinishedAt = Date.now();
            if (freshTask.every) {
              freshTask.nextRun = Date.now() + freshTask.every;
              logCron(`Task ${freshTask.name} rescheduled for ${new Date(freshTask.nextRun).toLocaleTimeString()}`);
            } else {
              freshTask.enabled = false;
              logCron(`Task ${freshTask.name} completed (one-time)`);
            }
            saveCronTasks(freshTasks);
          }
          runningCronTasks.delete(task.id);
        }
      })();
    }
  }
}, 15000); // Check every 15 seconds

async function executeScheduledTask(task) {
  try {
    const cmd = getPicoclawCommand();
    const agentKey = task.agentKey || 'default';
    const workspace = await getAgentWorkspace(agentKey);
    const config = await readConfig();

    const virtualHome = path.join(os.tmpdir(), `picoclaw-cron-${Date.now()}`);
    const virtualDotPico = path.join(virtualHome, '.picoclaw');
    fs.mkdirSync(virtualDotPico, { recursive: true });

    // Build virtual config pointing to target workspace as default
    const virtualConfig = {
      ...config,
      agents: {
        ...config.agents,
        defaults: {
          ...(config.agents?.defaults || {}),
          ...config.agents[agentKey],
          workspace: workspace
        }
      }
    };
    fs.writeFileSync(path.join(virtualDotPico, 'config.json'), JSON.stringify(virtualConfig, null, 2));

    const args = ['agent', '-m', task.message];
    if (task.sessionKey) args.push('--session', task.sessionKey);
    if (task.model) args.push('--model', task.model);

    const spawnArgs = [...cmd.args, ...args];
    logCron(`[V3] Running: ${cmd.bin} ${spawnArgs.join(' ')}`);

    const procKey = `${agentKey}:${task.sessionKey}`;

    return new Promise((resolve) => {
      const logStream = fs.createWriteStream(CRON_LOG, { flags: 'a' });
      const proc = spawn(cmd.bin, spawnArgs, {
        cwd: cmd.cwd,
        env: { ...getSpawnEnv(), HOME: virtualHome, PICOCLAW_HOME: virtualHome },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      if (task.sessionKey) {
        activeChatProcesses.set(procKey, {
          userMessage: task.message,
          stdout: '',
          logs: [],
          submissionTime: new Date().toISOString(),
          proc: proc
        });
      }

      proc.stdout.on('data', d => {
        logStream.write(d);
        if (task.sessionKey && activeChatProcesses.has(procKey)) {
          activeChatProcesses.get(procKey).stdout += d.toString();
        }
      });

      proc.stderr.on('data', d => {
        logStream.write(d);
        if (task.sessionKey && activeChatProcesses.has(procKey)) {
          const lines = d.toString().split('\n').map(l => l.trim()).filter(Boolean);
          const logs = activeChatProcesses.get(procKey).logs;
          lines.forEach(l => logs.push(l));
        }
      });

      proc.on('close', (code) => {
        logCron(`Task ${task.name} process exited with code ${code}`);
        try { fs.rmSync(virtualHome, { recursive: true, force: true }); } catch (e) { }
        if (task.sessionKey) activeChatProcesses.delete(procKey);
        resolve();
      });
    });
  } catch (e) {
    logCron(`Execution error for task ${task.name}: ${e.message}`);
  }
}

function getPicoclawCommand() {
  const isSource = process.env.PICOCLAW_SOURCE === 'true';
  const srcDir = path.resolve(__dirname, '..', 'picoclaw_src');

  if (isSource && fs.existsSync(srcDir)) {
    return {
      bin: 'go',
      args: ['run', 'cmd/picoclaw/main.go'],
      cwd: srcDir
    };
  }

  const commonPaths = ['/usr/local/bin/picoclaw', '/opt/homebrew/bin/picoclaw'];
  for (const p of commonPaths) {
    if (fs.existsSync(p)) return { bin: p, args: [], cwd: process.cwd() };
  }
  return { bin: 'picoclaw', args: [], cwd: process.cwd() };
}

function getSpawnEnv() {
  const extraPaths = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/local/go/bin',
    '/usr/local/opt/go/bin',
    path.join(os.homedir(), 'go', 'bin')
  ].join(':');

  return {
    ...process.env,
    PATH: (process.env.PATH || '') + (process.env.PATH ? ':' : '') + extraPaths
  };
}

// Static avatars
const AVATARS_DIR = path.join(__dirname, 'public', 'avatars');
if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });
app.use('/avatars', express.static(AVATARS_DIR));

// Multer for avatars
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, AVATARS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `${req.params.type}_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });
// Global user avatar upload (not per-agent)
app.post('/api/avatar/:type', upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ success: true, url: `/avatars/${req.file.filename}` });
});

// Per-agent avatar upload — saves into agent workspace/avatars/ and updates webui.json
app.post('/api/agents/:agentKey/avatar', async (req, res) => {
  try {
    const workspace = await getAgentWorkspace(req.params.agentKey);
    const agentAvatarsDir = path.join(workspace, 'avatars');
    fs.mkdirSync(agentAvatarsDir, { recursive: true });

    const agentStorage = multer.diskStorage({
      destination: (req, file, cb) => cb(null, agentAvatarsDir),
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.png';
        cb(null, `avatar_${Date.now()}${ext}`);
      }
    });
    const agentUpload = multer({ storage: agentStorage, limits: { fileSize: 5 * 1024 * 1024 } });

    agentUpload.single('avatar')(req, res, (err) => {
      if (err || !req.file) return res.status(400).json({ error: 'Upload failed' });
      // Store as a static file served from the agent workspace
      const filename = req.file.filename;
      const relUrl = `/api/agents/${req.params.agentKey}/avatars/${filename}`;
      // Save the URL into webui.json
      const meta = readAgentMeta(workspace);
      meta.avatar = relUrl;
      saveAgentMeta(workspace, meta);
      res.json({ success: true, url: relUrl });
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Cron API ---
app.get('/api/cron', (req, res) => {
  res.json(readCronTasks());
});

app.get('/api/cron/logs', (req, res) => {
  try {
    if (fs.existsSync(CRON_LOG)) {
      const logs = fs.readFileSync(CRON_LOG, 'utf8');
      res.send(logs);
    } else {
      res.send('No logs found.');
    }
  } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/cron', (req, res) => {
  const { name, message, every, at, agentKey, sessionKey, model } = req.body;
  if (!message) return res.status(400).json({ error: 'Message is required' });

  const tasks = readCronTasks();
  const newTask = {
    id: Date.now().toString(),
    name: name || 'Scheduled Task',
    message,
    agentKey,
    sessionKey,
    model,
    enabled: true,
    every: every ? parseInt(every) * 1000 : null,
    nextRun: at ? parseInt(at) : (every ? Date.now() + parseInt(every) * 1000 : Date.now())
  };

  tasks.push(newTask);
  saveCronTasks(tasks);
  res.json(newTask);
});

app.delete('/api/cron/:id', (req, res) => {
  let tasks = readCronTasks();
  const initialLen = tasks.length;
  tasks = tasks.filter(t => t.id !== req.params.id);
  if (tasks.length === initialLen) return res.status(404).json({ error: 'Task not found' });
  saveCronTasks(tasks);
  res.json({ success: true });
});

// Serve per-agent avatar files
app.get('/api/agents/:agentKey/avatars/:filename', async (req, res) => {
  try {
    const workspace = await getAgentWorkspace(req.params.agentKey);
    const fpath = path.resolve(workspace, 'avatars', req.params.filename);
    if (!fs.existsSync(fpath)) return res.status(404).send('Not found');

    // Use stream instead of res.sendFile for better non-ASCII path handling
    const ext = path.extname(fpath).toLowerCase();
    const contentType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    res.setHeader('Content-Type', contentType);
    fs.createReadStream(fpath).pipe(res);
  } catch (e) { res.status(404).send('Not found'); }
});

// ─── Config ─────────────────────────────────────────────────────────────────

// PICOCLAW_CONFIG_PATH is now defined globally above using getHomeDir()

// --- Meta Sidecar Helpers (for timestamps) ---
function getMetaPath(sessionFilePath) {
  return sessionFilePath.replace(/\.jsonl?$/, '.meta.json');
}

function readSessionMeta(sessionFilePath) {
  const mpath = getMetaPath(sessionFilePath);
  try {
    if (fs.existsSync(mpath)) return JSON.parse(fs.readFileSync(mpath, 'utf-8'));
  } catch (e) { }
  return { timestamps: [] };
}

function saveSessionMeta(sessionFilePath, meta) {
  const mpath = getMetaPath(sessionFilePath);
  fs.writeFileSync(mpath, JSON.stringify(meta, null, 2));
}

async function readConfig() {
  const content = await fs.promises.readFile(PICOCLAW_CONFIG_PATH, 'utf-8');
  const config = JSON.parse(content);
  // Alias model_list to models for WebUI compatibility and normalize objects
  if (config.model_list && !config.models) {
    config.models = config.model_list.map(m => {
      if (!m.id || !m.provider) {
        // Attempt to parse provider/id from model_name (e.g. "nvidia/glm4.7")
        const name = m.model_name || m.model || "";
        const parts = name.split('/');
        const provider = parts[0] || 'default';
        const id = parts.slice(1).join('/') || parts[0];
        return {
          ...m,
          provider: m.provider || provider,
          id: m.id || id,
          displayName: m.displayName || m.model_name || m.model || id
        };
      }
      return m;
    });
  }
  return config;
}

app.get('/api/config', async (req, res) => {
  try { res.json(await readConfig()); }
  catch (e) { res.status(500).json({ error: 'Failed to read config' }); }
});

app.post('/api/config', async (req, res) => {
  try {
    const config = req.body;
    // Map models back to model_list for Go backend compatibility
    if (config.models) {
      config.model_list = config.models;
    }
    await fs.promises.writeFile(PICOCLAW_CONFIG_PATH, JSON.stringify(config, null, 2));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to write config' }); }
});

// ─── Agent helpers ───────────────────────────────────────────────────────────

// ─── Agent helpers ───────────────────────────────────────────────────────────

function normalizeAgents(config) {
  if (!config?.agents) return {};
  let map = {};

  // If it has a 'list' property, it's the new format
  if (Array.isArray(config.agents.list)) {
    config.agents.list.forEach(agent => {
      if (agent.id) map[agent.id] = agent;
    });

    // New format (picoclaw_src) might not explicitly define 'main' in the list
    // but the Go backend creates it implicitly from defaults.
    if (!map['main']) {
      map['main'] = {
        id: 'main',
        name: '默认 Agent',
        workspace: config.agents.defaults?.workspace || '~/.picoclaw/workspace',
        model: config.agents.defaults?.model || '',
        model_name: config.agents.defaults?.model_name || ''
      };
    }
  } else {
    // Legacy map format
    map = { ...config.agents };
    delete map.defaults;
  }
  return map;
}

function resolveWorkspace(workspacePath) {
  const ws = workspacePath || '~/.picoclaw/workspace';
  if (ws.startsWith('~')) {
    return path.resolve(HOME, ws.slice(1).replace(/^[/\\]+/, ''));
  }
  return path.resolve(ws);
}

async function getAgentWorkspace(agentKey) {
  const config = await readConfig();
  const agents = normalizeAgents(config);
  const agentCfg = agents[agentKey];
  // Fallback to main if specific agent key is lost or not found
  if (!agentCfg && agentKey !== 'main') {
    const mainCfg = agents['main'];
    if (mainCfg) return resolveWorkspace(mainCfg.workspace);
  }
  if (!agentCfg) throw new Error(`Agent '${agentKey}' not found in config`);
  return resolveWorkspace(agentCfg.workspace);
}

// ─── Session helpers ─────────────────────────────────────────────────────────

function getSessionsDir(workspace) {
  return path.join(workspace, 'sessions');
}

function readJsonl(filePath) {
  try {
    const metaPath = getMetaPath(filePath);
    let skip = 0;
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        skip = meta.skip || meta.Skip || 0;
      } catch (e) { }
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n')
      .filter(line => line.trim());

    // Support logical truncation (Skip) from Go core
    const activeLines = skip > 0 ? lines.slice(skip) : lines;

    return activeLines.map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        console.error(`[JSONL] Failed to parse line in ${filePath}:`, e.message);
        return null;
      }
    })
      .filter(msg => msg !== null);
  } catch (e) {
    console.error(`[JSONL] Error reading ${filePath}:`, e.message);
    return [];
  }
}

// Read workspace identity/memory files for system prompt
function buildSystemPrompt(workspace) {
  const contextFiles = ['IDENTITY.md', 'SOUL.md', 'AGENT.md', 'USER.md', 'TOOLS.md'];
  const parts = [];
  for (const fname of contextFiles) {
    const fpath = path.join(workspace, fname);
    if (fs.existsSync(fpath)) {
      try {
        const content = fs.readFileSync(fpath, 'utf-8').trim();
        if (content) parts.push(`## ${fname}\n${content}`);
      } catch (e) { }
    }
  }
  // Also include MEMORY.md from memory folder if present
  const memPath = path.join(workspace, 'memory', 'MEMORY.md');
  if (fs.existsSync(memPath)) {
    try {
      const content = fs.readFileSync(memPath, 'utf-8').trim();
      if (content) parts.push(`## Long-term Memory\n${content}`);
    } catch (e) { }
  }
  return parts.join('\n\n---\n\n');
}

// Agent webui metadata helpers (stored in {workspace}/webui.json)
function readAgentMeta(workspace) {
  const fpath = path.join(workspace, 'webui.json');
  try {
    if (fs.existsSync(fpath)) return JSON.parse(fs.readFileSync(fpath, 'utf-8'));
  } catch (e) { }
  return { avatar: '🤖', displayName: '', color: null };
}

function saveAgentMeta(workspace, meta) {
  fs.writeFileSync(path.join(workspace, 'webui.json'), JSON.stringify(meta, null, 2));
}

// ─── Agents API ─────────────────────────────────────────────────────────────

// List all agents
app.get('/api/agents', async (req, res) => {
  try {
    const config = await readConfig();
    const agentsMap = normalizeAgents(config);
    const agents = Object.entries(agentsMap).map(([key, cfg]) => {
      const workspace = resolveWorkspace(cfg.workspace);
      let sessionCount = 0;
      let lastActive = '';
      const sessionsDir = getSessionsDir(workspace);
      try {
        const files = fs.readdirSync(sessionsDir).filter(f => {
          return (f.endsWith('.json') || f.endsWith('.jsonl')) && f !== 'heartbeat.json' && f !== 'heartbeat.jsonl' && !f.endsWith('.migrated') && !f.endsWith('.meta.json');
        });
        sessionCount = files.length;

        // Find the most recent updated timestamp across all sessions for this agent
        for (const f of files) {
          try {
            const fpath = path.join(sessionsDir, f);
            if (f.endsWith('.json')) {
              const data = JSON.parse(fs.readFileSync(fpath, 'utf-8'));
              if (data.updated && data.updated > lastActive) {
                lastActive = data.updated;
              }
            } else if (f.endsWith('.jsonl')) {
              const mpath = getMetaPath(fpath);
              if (fs.existsSync(mpath)) {
                const m = JSON.parse(fs.readFileSync(mpath, 'utf-8'));
                const up = m.updated_at || m.UpdatedAt || '';
                if (up && up > lastActive) lastActive = up;
              }
            }
          } catch (e) { }
        }
      } catch (e) { }

      // Read webui meta
      const meta = readAgentMeta(workspace);
      const hasIdentity = fs.existsSync(path.join(workspace, 'IDENTITY.md'));

      return {
        key,
        workspace: cfg.workspace,
        model: cfg.model_name || (typeof cfg.model === 'string' ? cfg.model : cfg.model?.primary) || '',
        temperature: cfg.temperature,
        max_tokens: cfg.max_tokens,
        sessionCount,
        lastActive,
        hasIdentity,
        avatar: meta.avatar || '🤖',
        displayName: meta.displayName || cfg.name || key,
        color: meta.color || null
      };
    });

    // Sort agents by lastActive (descending)
    agents.sort((a, b) => {
      // If neither has active sessions, preserve config order or sort by name
      if (!a.lastActive && !b.lastActive) return a.key.localeCompare(b.key);
      if (!a.lastActive) return 1;
      if (!b.lastActive) return -1;
      return b.lastActive.localeCompare(a.lastActive);
    });

    res.json(agents);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get agent identity files
app.get('/api/agents/:agentKey/identity', async (req, res) => {
  try {
    const workspace = await getAgentWorkspace(req.params.agentKey);
    const files = ['IDENTITY.md', 'USER.md', 'SOUL.md', 'AGENT.md', 'TOOLS.md', path.join('memory', 'MEMORY.md')];
    const data = {};
    for (const f of files) {
      const fpath = path.join(workspace, f);
      // use the base name as key, except for MEMORY.md
      const key = f.includes('MEMORY.md') ? 'MEMORY.md' : f;
      data[key] = fs.existsSync(fpath) ? fs.readFileSync(fpath, 'utf-8') : '';
    }
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update agent identity file
app.post('/api/agents/:agentKey/identity', async (req, res) => {
  try {
    const { filename, content } = req.body;
    if (!filename || content === undefined) return res.status(400).json({ error: 'filename and content required' });

    // basic security check to prevent directory traversal
    if (filename.includes('..') || filename.startsWith('/')) {
      return res.status(400).json({ error: 'invalid filename' });
    }

    const workspace = await getAgentWorkspace(req.params.agentKey);
    const validFiles = ['IDENTITY.md', 'USER.md', 'SOUL.md', 'AGENT.md', 'TOOLS.md', 'MEMORY.md'];

    if (!validFiles.includes(filename)) {
      return res.status(400).json({ error: 'file not allowed' });
    }

    // MEMORY.md is in a subfolder
    const targetPath = filename === 'MEMORY.md'
      ? path.join(workspace, 'memory', filename)
      : path.join(workspace, filename);

    // Ensure directory exists (specifically for memory/)
    if (filename === 'MEMORY.md') {
      fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
    }

    fs.writeFileSync(targetPath, content, 'utf-8');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create a new agent in config
app.post('/api/agents', async (req, res) => {
  const { key, workspace, model } = req.body;
  if (!key || !workspace) return res.status(400).json({ error: 'key and workspace required' });
  try {
    const config = await readConfig();
    if (!config.agents) config.agents = {};
    if (config.agents[key]) return res.status(409).json({ error: `Agent '${key}' already exists` });
    const resolvedWs = resolveWorkspace(workspace);

    // Create full workspace directory structure (matching PicoClaw conventions)
    fs.mkdirSync(path.join(resolvedWs, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(resolvedWs, 'memory'), { recursive: true });
    fs.mkdirSync(path.join(resolvedWs, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(resolvedWs, 'state'), { recursive: true });

    // Scaffold standard workspace files (only if they don't already exist)
    const writeIfMissing = (fname, content) => {
      const fpath = path.join(resolvedWs, fname);
      if (!fs.existsSync(fpath)) fs.writeFileSync(fpath, content);
    };

    writeIfMissing('IDENTITY.md', `# Identity

## Name
${key}

## Description
A PicoClaw AI agent — lightweight, personal, capable.

## Version
0.1.0

## Purpose
- Provide intelligent AI assistance with a consistent personality
- Remember user preferences, history, and context across sessions
- Learn and evolve through ongoing interactions

## Capabilities
- Natural language conversation
- Task planning and execution
- Memory management across sessions
`);

    writeIfMissing('SOUL.md', `# SOUL.md - Who You Are

You are **${key}**, a helpful AI assistant.

## Core Truths

**Be genuinely helpful, not performatively helpful.** Skip the filler phrases — just help. Actions speak louder than words.

**Have opinions.** You're allowed to disagree, prefer things, and find things amusing or boring. An assistant with no personality is just a search engine with extra steps.

**Be resourceful before asking.** Try to figure it out. Read the file. Check the context. Then ask if you're genuinely stuck.

**Earn trust through competence.** Be careful with external actions. Be bold with internal ones (reading, reasoning, organizing).

## Vibe

Be the assistant you'd actually want to talk to. Concise when needed, thorough when it matters. Not a corporate drone. Not a sycophant. Just... good.

## Continuity

Each session, you wake up fresh. These files _are_ your memory. Read them. Update them. They're how you persist.

_This file is yours to evolve. As you learn who you are, update it._
`);

    writeIfMissing('USER.md', `# USER.md - About Your Human

_Learn about the person you're helping. Update this as you go._

- **What to call them:** _(not set yet)_
- **Timezone:** _(not set yet)_
- **Language:** _(not set yet)_
- **Notes:** _(update as you learn more)_

## Context

_(Fill in as you learn about the user's projects and preferences.)_

---

The more you know, the better you can help. But you're learning about a person, not building a dossier. Respect the difference.
`);

    writeIfMissing('AGENT.md', `# Agent Instructions

You are ${key}, a helpful AI assistant powered by PicoClaw.

## Guidelines

- Always explain what you're doing before taking actions
- Ask for clarification when a request is ambiguous
- Remember important information in your memory files
- Be proactive and genuinely helpful
- Learn from user feedback and update your memory files accordingly

## Memory

Update your memory files (USER.md, SOUL.md) when you learn something important about the user or yourself.
`);

    writeIfMissing('TOOLS.md', `# Tools

## Available Tools

_(This file will be populated by PicoClaw with available tools based on your configuration.)_

## Custom Tool Notes

_(Add notes about specific tool usage or restrictions here.)_
`);

    writeIfMissing('HEARTBEAT.md', `# Heartbeat

_Last active: ${new Date().toISOString()}_

_(This file is updated by PicoClaw to track agent activity.)_
`);

    writeIfMissing(path.join('memory', 'MEMORY.md'), `# Long-term Memory

_This file stores important facts that should persist across all sessions._

## Key Facts

_(Agent will add important information here as it learns.)_

## User Preferences

_(Track user preferences and working style here.)_
`);

    // Initialise webui.json with agent-specific defaults
    saveAgentMeta(resolvedWs, { avatar: '🤖', displayName: key, color: null });

    // Write agent config
    const isNewFormat = Array.isArray(config.agents?.list);
    const newAgentCfg = {
      workspace,
      restrict_to_workspace: true,
      model: model || config?.agents?.defaults?.model || '',
      max_tokens: 8196,
      temperature: 0.1,
      max_tool_iterations: 20,
      stream: true
    };

    if (isNewFormat) {
      newAgentCfg.id = key;
      newAgentCfg.name = key;
      config.agents.list.push(newAgentCfg);
    } else {
      config.agents[key] = newAgentCfg;
    }
    fs.writeFileSync(PICOCLAW_CONFIG_PATH, JSON.stringify(config, null, 2));
    res.json({ success: true, key });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get agent context (system prompt preview)
app.get('/api/agents/:agentKey/context', async (req, res) => {
  try {
    const workspace = await getAgentWorkspace(req.params.agentKey);
    const systemPrompt = buildSystemPrompt(workspace);
    res.json({ systemPrompt, workspace });
  } catch (e) { res.status(404).json({ error: e.message }); }
});

// Get agent webui meta (avatar, displayName, color, ...)
app.get('/api/agents/:agentKey/meta', async (req, res) => {
  try {
    const workspace = await getAgentWorkspace(req.params.agentKey);
    res.json(readAgentMeta(workspace));
  } catch (e) { res.status(404).json({ error: e.message }); }
});

// Update agent webui meta (and config fields)
app.patch('/api/agents/:agentKey/meta', async (req, res) => {
  try {
    const agentKey = req.params.agentKey;
    const workspace = await getAgentWorkspace(agentKey);

    // 1. Update webui.json
    const existingMeta = readAgentMeta(workspace);
    const updatedMeta = { ...existingMeta, ...req.body };
    saveAgentMeta(workspace, updatedMeta);

    // 2. Update config.json (model, temperature, max_tokens)
    const config = await readConfig();
    const isNewFormat = Array.isArray(config.agents?.list);

    if (isNewFormat) {
      const agent = config.agents.list.find(a => a.id === agentKey);
      if (agent) {
        if (req.body.model !== undefined) agent.model = req.body.model;
        if (req.body.temperature !== undefined) agent.temperature = parseFloat(req.body.temperature);
        if (req.body.max_tokens !== undefined) agent.max_tokens = parseInt(req.body.max_tokens);
      }
    } else if (config.agents && config.agents[agentKey]) {
      if (req.body.model !== undefined) config.agents[agentKey].model = req.body.model;
      if (req.body.temperature !== undefined) config.agents[agentKey].temperature = parseFloat(req.body.temperature);
      if (req.body.max_tokens !== undefined) config.agents[agentKey].max_tokens = parseInt(req.body.max_tokens);
    }
    fs.writeFileSync(PICOCLAW_CONFIG_PATH, JSON.stringify(config, null, 2));

    res.json({ success: true, meta: updatedMeta });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Sessions API ─────────────────────────────────────────────────────────────

// List sessions for an agent (supports JSON and JSONL)
app.get('/api/agents/:agentKey/sessions', async (req, res) => {
  try {
    const workspace = await getAgentWorkspace(req.params.agentKey);
    const dir = getSessionsDir(workspace);
    if (!fs.existsSync(dir)) return res.json([]);

    const sessions = [];
    const agentKey = req.params.agentKey;
    const files = fs.readdirSync(dir).filter(f => {
      if (f === 'heartbeat.json' || f === 'heartbeat.jsonl' || f.endsWith('.migrated')) return false;
      if (!f.endsWith('.json') && !f.endsWith('.jsonl')) return false;
      if (f.endsWith('.meta.json')) return false;

      // Strict filtering: sessions in this folder MUST belong to this agent's prefix
      if (agentKey === 'main') {
        // 'main' agent sees 'agent_main_' OR legacy files (no 'agent_' prefix)
        return f.startsWith('agent_main_') || !f.startsWith('agent_');
      } else {
        // named agents ONLY see their own prefix
        return f.startsWith(`agent_${agentKey}_`);
      }
    });
    for (const f of files) {
      if (f === 'heartbeat.json' || f === 'heartbeat.jsonl' || f.endsWith('.migrated')) continue;
      if (!f.endsWith('.json') && !f.endsWith('.jsonl')) continue;
      if (f.endsWith('.meta.json')) continue;

      const fpath = path.join(dir, f);
      try {
        let key, summary = '', model = '', messageCount = 0, updated = null, created = null;

        if (f.endsWith('.jsonl')) {
          const metaPath = fpath.replace('.jsonl', '.meta.json');
          key = f.replace('.jsonl', '');
          if (fs.existsSync(metaPath)) {
            const m = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            key = m.key || key;
            summary = m.summary || '';
            messageCount = m.count || 0;
            updated = m.updated_at || m.UpdatedAt || null;
            created = m.created_at || m.CreatedAt || null;
          }
        } else {
          const data = JSON.parse(fs.readFileSync(fpath, 'utf-8'));
          key = data.key || f.replace('.json', '');
          summary = data.summary || '';
          model = data.model || data.webui_model || '';
          messageCount = data.messages?.length || 0;
          updated = data.updated || null;
          created = data.created || null;
        }

        sessions.push({
          key,
          title: summary || key,
          model,
          messageCount,
          updated,
          created,
          hasSummary: !!summary,
          is_active: activeChatProcesses.has(`${req.params.agentKey}:${key}`)
        });
      } catch (e) { }
    }
    // Sort by updated time (desc)
    sessions.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
    res.json(sessions);
  } catch (e) {
    console.error('[Sessions Error]', e);
    res.status(500).json({ error: e.message });
  }
});



// Helper to find session file by key (supports .json and .jsonl)
function findSessionFile(dir, sessionKey) {
  if (!fs.existsSync(dir)) return null;

  // OPTIMIZATION: Try direct file match first
  const sanitizedKey = sessionKey.replace(/[\\/:*?"<>|]/g, '_').replace(/:/g, '_');

  const jsonlPath = path.join(dir, sanitizedKey + '.jsonl');
  if (fs.existsSync(jsonlPath)) return jsonlPath;

  const jsonPath = path.join(dir, sanitizedKey + '.json');
  if (fs.existsSync(jsonPath)) return jsonPath;

  const files = fs.readdirSync(dir);

  // 1. Precise match via readdir
  for (const f of files) {
    if (f.endsWith('.meta.json') || f.endsWith('.migrated')) continue;
    const baseName = f.replace(/\.jsonl?$/, '');
    if (baseName === sanitizedKey) return path.join(dir, f);
  }

  // 2. Resilience: Handle expanded keys (e.g. 'agent:queen:main' vs 'agent:queen:main:main' from official UI)
  for (const f of files) {
    if (f.endsWith('.meta.json') || f.endsWith('.migrated')) continue;

    // If the file starts with our sanitizedKey, it might be the expanded version
    const baseName = f.replace(/\.jsonl?$/, '');
    if (baseName.startsWith(sanitizedKey + '_')) {
      return path.join(dir, f);
    }
  }

  // 3. Deep check inside meta files
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const metaPath = path.join(dir, f.replace('.jsonl', '.meta.json'));
    if (fs.existsSync(metaPath)) {
      try {
        const m = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        // Match exact or startWith (for expanded official keys)
        if (m.key === sessionKey || (m.key && m.key.startsWith(sessionKey + ':'))) return path.join(dir, f);
      } catch (e) { }
    }
  }

  return null;
}

// Get a single session
app.get('/api/agents/:agentKey/sessions/:sessionKey', async (req, res) => {
  try {
    const workspace = await getAgentWorkspace(req.params.agentKey);
    const dir = getSessionsDir(workspace);
    const sessionKey = req.params.sessionKey;

    const fpath = findSessionFile(dir, sessionKey);
    if (fpath) {
      try {
        let data;
        if (fpath.endsWith('.jsonl')) {
          const messages = readJsonl(fpath);
          const metaPath = fpath.replace('.jsonl', '.meta.json');
          let meta = { key: sessionKey, summary: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
          if (fs.existsSync(metaPath)) {
            try {
              const m = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
              meta = { ...meta, ...m };
            } catch (e) { }
          }
          data = {
            key: meta.key || sessionKey,
            summary: meta.summary || '',
            messages: messages,
            created: meta.created_at || meta.CreatedAt || new Date().toISOString(),
            updated: meta.updated_at || meta.UpdatedAt || new Date().toISOString(),
            model: meta.model || ''
          };
        } else {
          data = JSON.parse(fs.readFileSync(fpath, 'utf-8'));
        }

        data.webui_model = data.model || data.webui_model || '';
        const procKey = `${req.params.agentKey}:${sessionKey}`;
        data.is_active = activeChatProcesses.has(procKey);

        if (data.is_active) {
          const procData = activeChatProcesses.get(procKey);
          data.messages = data.messages || [];
          if (procData.userMessage) {
            const lastMsg = data.messages[data.messages.length - 1];
            if (!lastMsg || lastMsg.role !== 'user' || lastMsg.content !== procData.userMessage) {
              data.messages.push({
                role: 'user',
                content: procData.userMessage,
                timestamp: procData.submissionTime || new Date().toISOString()
              });
            }
          }
          if (procData.stdout || procData.logs.length > 0) {
            data.messages.push({
              role: 'assistant',
              content: procData.stdout,
              logs: procData.logs,
              timestamp: new Date().toISOString()
            });
          }
        }

        // Add fallback timestamps if missing, merging from sidecar if available
        if (data.messages) {
          const meta = readSessionMeta(fpath);
          data.messages = data.messages.map((msg, idx) => ({
            ...msg,
            timestamp: msg.timestamp || meta.timestamps[idx] || data.updated || data.created || new Date().toISOString()
          }));
        }
        return res.json(data);
      } catch (e) { }
    }
    // Return empty session
    res.json({ key: sessionKey, messages: [], summary: '', created: new Date().toISOString(), updated: new Date().toISOString() });
  } catch (e) {
    console.error('[Sessions Error]', e);
    res.status(500).json({ error: e.message });
  }
});

// Create a new session for an agent (with optional per-session model)
app.post('/api/agents/:agentKey/sessions', async (req, res) => {
  try {
    const workspace = await getAgentWorkspace(req.params.agentKey);
    const dir = getSessionsDir(workspace);
    fs.mkdirSync(dir, { recursive: true });
    const { key, model } = req.body;
    if (!key) return res.status(400).json({ error: 'key required' });
    const safeName = key.replace(/[^a-zA-Z0-9_\-]/g, '_');
    const filePath = path.join(dir, `${safeName}.json`);
    const session = {
      key,
      webui_model: model || '',   // store per-session model override
      messages: [],
      summary: '',
      created: new Date().toISOString(),
      updated: new Date().toISOString()
    };
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
    res.json({ success: true, key });
  } catch (e) {
    console.error('[Sessions Error]', e);
    res.status(500).json({ error: e.message });
  }
});

// Update session model
app.patch('/api/agents/:agentKey/sessions/:sessionKey/model', async (req, res) => {
  try {
    const workspace = await getAgentWorkspace(req.params.agentKey);
    const dir = getSessionsDir(workspace);
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (!f.endsWith('.json') || f === 'heartbeat.json') continue;
      const fpath = path.join(dir, f);
      try {
        const data = JSON.parse(fs.readFileSync(fpath, 'utf-8'));
        const fileKey = data.key || f.replace('.json', '');
        if (fileKey === req.params.sessionKey) {
          data.webui_model = req.body.model || '';
          // if we change it manually, clear the actual model so the override takes effect next time
          if (data.model) delete data.model;
          data.updated = new Date().toISOString();
          fs.writeFileSync(fpath, JSON.stringify(data, null, 2));
          return res.json({ success: true });
        }
      } catch (e) { }
    }
    res.status(404).json({ error: 'Session not found' });
  } catch (e) {
    console.error('[Sessions Error]', e);
    res.status(500).json({ error: e.message });
  }
});

// Delete a session
app.delete('/api/agents/:agentKey/sessions/:sessionKey', async (req, res) => {
  try {
    const workspace = await getAgentWorkspace(req.params.agentKey);
    const dir = getSessionsDir(workspace);
    const sessionKey = req.params.sessionKey;

    const fpath = findSessionFile(dir, sessionKey);
    if (fpath) {
      const mpath = getMetaPath(fpath);
      fs.unlinkSync(fpath);
      if (fs.existsSync(mpath)) fs.unlinkSync(mpath);
      console.log(`[Sessions] Deleted session file: ${fpath} and meta: ${mpath}`);
      return res.json({ success: true });
    }

    res.status(404).json({ error: 'Session not found' });
  } catch (e) {
    console.error('[Sessions Error]', e);
    res.status(500).json({ error: e.message });
  }
});

// Append message to session
app.post('/api/agents/:agentKey/sessions/:sessionKey/message', async (req, res) => {
  try {
    const workspace = await getAgentWorkspace(req.params.agentKey);
    const dir = getSessionsDir(workspace);
    const { role, content } = req.body;
    if (!role || content === undefined) return res.status(400).json({ error: 'role and content required' });

    const fileKey = req.params.sessionKey;
    fs.mkdirSync(dir, { recursive: true });
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    let filePath = null;
    for (const f of files) {
      if (!f.endsWith('.json') || f === 'heartbeat.json') continue;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        const dKey = d.key || f.replace('.json', '');
        if (dKey === fileKey) { filePath = path.join(dir, f); break; }
      } catch (e) { }
    }
    if (!filePath) {
      filePath = path.join(dir, `${fileKey.replace(/[^a-zA-Z0-9_\-]/g, '_')}.json`);
    }

    let session = { key: fileKey, messages: [], summary: '', created: new Date().toISOString(), updated: new Date().toISOString() };
    if (fs.existsSync(filePath)) {
      try { session = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch (e) { }
    }
    session.messages = session.messages || [];
    const timestamp = new Date().toISOString();
    session.messages.push({ role, content, timestamp });
    session.updated = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2));

    // Also persist to sidecar
    const meta = readSessionMeta(filePath);
    meta.timestamps[session.messages.length - 1] = timestamp;
    saveSessionMeta(filePath, meta);

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Gateway ─────────────────────────────────────────────────────────────────

let gatewayProcess = null;
const MAX_GATEWAY_LOGS = 1000;
let gatewayLogs = [];

app.get('/api/gateway/status', (req, res) => {
  if (gatewayProcess?.exitCode !== null) gatewayProcess = null;
  res.json({ running: gatewayProcess !== null });
});

app.get('/api/gateway/logs', (req, res) => {
  res.json({ logs: gatewayLogs });
});

app.post('/api/gateway/start', (req, res) => {
  if (gatewayProcess?.exitCode === null) return res.json({ success: true, message: 'Already running' });
  gatewayLogs = []; // Reset logs on start
  const cmd = getPicoclawCommand();
  const spawnArgs = [...cmd.args, 'gateway'];
  gatewayProcess = spawn(cmd.bin, spawnArgs, {
    cwd: cmd.cwd,
    detached: false,
    env: getSpawnEnv()
  });

  const handleLogData = (data) => {
    const lines = data.toString().split('\n').filter(l => l.trim());
    gatewayLogs = [...gatewayLogs, ...lines].slice(-MAX_GATEWAY_LOGS);
  };

  let errorLog = '';
  gatewayProcess.stdout.on('data', handleLogData);
  gatewayProcess.stderr.on('data', d => {
    handleLogData(d);
    errorLog += d.toString();
  });

  gatewayProcess.on('exit', () => { gatewayProcess = null; });
  setTimeout(() => {
    if (!gatewayProcess) res.json({ success: false, error: 'Crashed.\n' + errorLog });
    else res.json({ success: true });
  }, 1000);
});

app.post('/api/gateway/stop', (req, res) => {
  if (gatewayProcess) { gatewayProcess.kill('SIGTERM'); gatewayProcess = null; }
  else spawn('killall', ['picoclaw'], { env: getSpawnEnv() });
  res.json({ success: true });
});

// ─── Streaming Chat ──────────────────────────────────────────────────────────

const activeChatProcesses = new Map();

app.post('/api/chat/stop', (req, res) => {
  const { agentKey, sessionKey } = req.body;
  if (!sessionKey) return res.status(400).json({ error: 'sessionKey required' });
  const procKey = agentKey && sessionKey ? `${agentKey}:${sessionKey}` : sessionKey;
  const procData = activeChatProcesses.get(procKey);
  if (procData) {
    console.log(`[Chat] Force stopping process for session ${procKey} (PID=${procData.process.pid})`);
    try { procData.process.kill('SIGTERM'); } catch (e) { }
    activeChatProcesses.delete(procKey);
    res.json({ success: true, stopped: true });
  } else {
    res.json({ success: true, stopped: false });
  }
});

app.post('/api/chat/stream', async (req, res) => {
  const { agentKey, sessionKey, messages, model, apiKey, apiBase, maxTokens, temperature, top_p, top_k, presence_penalty, repetition_penalty, enable_thinking, usePicoclaw } = req.body;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const userMessage = messages[messages.length - 1]?.content || '';
  console.log(`[Chat] agent=${agentKey} session=${sessionKey} model=${model} picoclaw=${usePicoclaw !== false}`);

  // ── Mode A: Route through picoclaw agent (tools + skills enabled) ────────
  if (usePicoclaw !== false) {
    try {
      // Prefix-based routing override: if sessionKey specifies an agent, use that agent's config & workspace.
      let effectiveAgentKey = agentKey;
      if (sessionKey && sessionKey.startsWith('agent:')) {
        const parts = sessionKey.split(':');
        if (parts.length >= 2) effectiveAgentKey = parts[1];
      }

      const config = await readConfig();
      const agentsMap = normalizeAgents(config);
      const agentCfg = agentsMap[effectiveAgentKey] || {};
      const absoluteWorkspace = resolveWorkspace(agentCfg.workspace);
      const effectiveModel = model || agentCfg.model || '';

      // Create a virtual config directory for this specific call to force the CLI to use the correct workspace
      const virtualHome = path.join(os.tmpdir(), `picoclaw_call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
      const virtualDotPico = path.join(virtualHome, '.picoclaw');
      fs.mkdirSync(virtualDotPico, { recursive: true });

      // Build a config where the chosen agent's workspace is the GLOBAL DEFAULT for the CLI's point of view
      // We MUST resolve the workspace to an ABSOLUTE path here, because the spawned process will have a redirected HOME

      const virtualConfig = {
        ...config,
        agents: {
          ...config.agents,
          defaults: {
            ...(config.agents?.defaults || {}),
            workspace: absoluteWorkspace, // Resolve to absolute path
            temperature: temperature,
            max_tokens: maxTokens,
            top_p: top_p,
            top_k: top_k,
            presence_penalty: presence_penalty,
            repetition_penalty: repetition_penalty,
            thinking_level: enable_thinking ? 'medium' : 'off',
            enable_thinking: enable_thinking
          }
        }
      };

      // Also ensure the specific agent entry in the list/map points to the absolute workspace
      // AND set it as the ONLY default agent to force Go core routing.
      if (Array.isArray(virtualConfig.agents?.list)) {
        let found = false;
        virtualConfig.agents.list = virtualConfig.agents.list.map(a => {
          const isTarget = a.id === effectiveAgentKey;
          if (isTarget) found = true;
          return {
            ...a,
            workspace: isTarget ? absoluteWorkspace : a.workspace,
            default: isTarget // Force this one as default
          };
        });
        // If the agent was implicit (not in list), add it explicitly
        if (!found) {
          virtualConfig.agents.list.push({
            id: effectiveAgentKey,
            name: effectiveAgentKey === 'main' ? '默认 Agent' : effectiveAgentKey,
            workspace: absoluteWorkspace,
            default: true
          });
        }
      } else if (virtualConfig.agents) {
        // Handle map format: first set all to non-default
        Object.keys(virtualConfig.agents).forEach(k => {
          if (k !== 'defaults' && typeof virtualConfig.agents[k] === 'object') {
            virtualConfig.agents[k].default = false;
          }
        });
        // Ensure the agent exists in the map (even if implicit)
        virtualConfig.agents[effectiveAgentKey] = {
          ...(virtualConfig.agents[effectiveAgentKey] || {}),
          id: effectiveAgentKey,
          workspace: absoluteWorkspace,
          default: true // Force this one as default
        };
      }

      fs.writeFileSync(path.join(virtualDotPico, 'config.json'), JSON.stringify(virtualConfig, null, 2));

      console.log(`[Chat] PicoClaw Mode: agent=${effectiveAgentKey} workspace=${absoluteWorkspace} (VirtualHome: ${virtualHome})`);

      // Build picoclaw agent args
      const args = ['agent', '-m', userMessage];
      if (sessionKey) args.push('--session', sessionKey);
      if (effectiveModel) {
        args.push('--model', effectiveModel);
      }

      // Find picoclaw command
      const cmd = getPicoclawCommand();
      const spawnArgs = [...cmd.args, ...args];
      console.log(`[Spawn] ${cmd.bin} ${spawnArgs.join(' ')} (CWD: ${cmd.cwd})`);

      // Initialize SSE stream with a comment to keep connection alive
      res.write(': picoclaw starting\n\n');
      if (res.flush) res.flush();

      // Spawn picoclaw agent with virtual home to ensure identity isolation
      const agentProcess = spawn(cmd.bin, spawnArgs, {
        cwd: cmd.cwd,
        env: { ...getSpawnEnv(), HOME: virtualHome, PICOCLAW_HOME: virtualHome },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      const procKey = `${agentKey}:${sessionKey}`;

      // Cleanup virtual home after process finishes
      agentProcess.on('close', () => {
        try { fs.rmSync(virtualHome, { recursive: true, force: true }); } catch (e) { }
        activeChatProcesses.delete(procKey);
      });

      if (sessionKey) {
        activeChatProcesses.set(procKey, {
          process: agentProcess,
          stdout: '',
          logs: [],
          userMessage,
          submissionTime: new Date().toISOString()
        });
      }

      console.log(`[Spawn] Process PID: ${agentProcess.pid}`);

      let fullOutput = '';
      let errOutput = '';

      agentProcess.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        fullOutput += text;
        if (sessionKey && activeChatProcesses.has(procKey)) {
          activeChatProcesses.get(procKey).stdout += text;
        }
        // console.log(`[picoclaw stdout] ${text.trim()}`); // Removed as per instruction's example
        const delta = JSON.stringify({ choices: [{ delta: { content: text } }] });
        res.write(`data: ${delta}\n\n`);
        if (res.flush) res.flush();
      });

      agentProcess.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        errOutput += text;
        if (sessionKey && activeChatProcesses.has(procKey)) {
          activeChatProcesses.get(procKey).logs.push(text);
        }
        console.log(`[picoclaw log] ${text.trim()}`); // Changed from stderr to log
        res.write(`data: ${JSON.stringify({ tool_log: text })}\n\n`);
      });

      agentProcess.on('close', async (code, signal) => {
        if (code !== 0 && code !== null) {
          console.error(`[Spawn] picoclaw closed with code ${code} signal ${signal}, stderr=${errOutput}`);
          const details = errOutput ? `. Details: ${errOutput.slice(-500)}` : "";
          res.write(`data: ${JSON.stringify({ error: `picoclaw exited with code ${code}${details}` })}\n\n`);
        } else if (signal) {
          console.error(`[Spawn] picoclaw terminated by ${signal}, stderr=${errOutput}`);
          const details = errOutput ? `. Details: ${errOutput.slice(-500)}` : "";
          res.write(`data: ${JSON.stringify({ error: `picoclaw terminated by ${signal}${details}` })}\n\n`);
        }

        // --- Persist Timestamps to Sidecar after process finishes ---
        if (sessionKey) {
          try {
            const workspace = await getAgentWorkspace(agentKey);
            const dir = getSessionsDir(workspace);
            const filePath = findSessionFile(dir, sessionKey);
            if (filePath) {
              // Wait slightly for Go core to finish writing the file
              setTimeout(() => {
                try {
                  const sessionData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                  const meta = readSessionMeta(filePath);
                  const procData = activeChatProcesses.get(procKey);

                  // Map timestamps for new messages
                  if (sessionData.messages && procData) {
                    const startIdx = sessionData.messages.length - 2; // User + Assistant
                    if (startIdx >= 0) {
                      meta.timestamps[startIdx] = procData.submissionTime;
                      meta.timestamps[startIdx + 1] = new Date().toISOString();
                      saveSessionMeta(filePath, meta);
                      console.log(`[Meta] Saved timestamps for session ${sessionKey}`);
                    }
                  }
                } catch (e) { console.error(`[Meta] Error saving: ${e.message}`); }
              }, 500);
            }
          } catch (e) { }
        }

        res.write('data: [DONE]\n\n');
        res.end();
      });

      agentProcess.on('error', (err) => {
        console.error(`[Spawn] error: ${err.message}`);
        res.write(`data: ${JSON.stringify({ error: `Failed to start picoclaw: ${err.message}` })}\n\n`);
        res.end();
      });

      req.on('close', () => {
        console.log(`[Chat] Request event: CLOSE (PID=${agentProcess.pid})`);
        try { agentProcess.kill('SIGTERM'); } catch (e) { }
      });
      return;
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      return res.end();
    }
  }

  // ── Mode B: Direct LLM API (fallback, no tools) ────────────────────────────
  const tempValue = temperature !== undefined ? parseFloat(temperature) : 0.7;
  let finalMessages = [...messages];
  if (agentKey) {
    try {
      const workspace = await getAgentWorkspace(agentKey);
      const sysPrompt = buildSystemPrompt(workspace);
      console.log(`[Chat] Direct Mode: agent=${agentKey} workspace=${workspace} promptLen=${sysPrompt.length}`);
      if (sysPrompt) finalMessages = [{ role: 'system', content: sysPrompt }, ...messages];
    } catch (e) { console.warn('Could not load agent context:', e.message); }
  }
  try {
    // For Mode B, strip the prefix if present (e.g., "ollama/llama3" becomes "llama3")
    const actualModel = model.includes('/') ? model.substring(model.indexOf('/') + 1) : model;

    // Build request body with model-level generation parameters
    const reqBody = {
      model: actualModel,
      messages: finalMessages,
      stream: true,
      max_tokens: maxTokens || 8192,
      temperature: tempValue
    };
    if (top_p !== undefined && top_p !== null) reqBody.top_p = top_p;
    if (top_k !== undefined && top_k !== null) reqBody.top_k = top_k;
    if (presence_penalty !== undefined && presence_penalty !== null) reqBody.presence_penalty = presence_penalty;
    if (repetition_penalty !== undefined && repetition_penalty !== null) reqBody.repetition_penalty = repetition_penalty;
    if (enable_thinking) {
      reqBody.chat_template_kwargs = { enable_thinking: true };
    } else {
      reqBody.chat_template_kwargs = { enable_thinking: false };
    }

    console.log(`[Chat] Sending Request to ${apiBase || 'https://api.openai.com/v1'}/chat/completions:`, JSON.stringify(reqBody, null, 2));
    const response = await fetch(`${apiBase || 'https://api.openai.com/v1'}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(reqBody)
    });
    if (!response.ok) {
      res.write(`data: ${JSON.stringify({ error: await response.text() })}\n\n`);
      return res.end();
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
      if (res.flush) res.flush();
    }
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

app.listen(3001, () => console.log('PicoClaw API backend running on port 3001'));
