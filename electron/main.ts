import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import Database from "better-sqlite3";
import http from "http";


let llamaProc: ChildProcessWithoutNullStreams | null = null;
let mainWindow: BrowserWindow | null = null;

function getPortableRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "portable");
  }
  return path.join(process.cwd(), "portable");
}

function resolveWorkspacePath(relPath: string) {
  const workspaceRoot = path.resolve(getPortableRoot(), "workspaces");
  const safeRel = String(relPath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (safeRel.includes("..")) throw new Error("Invalid path");
  const target = path.resolve(workspaceRoot, safeRel);
  const rel = path.relative(workspaceRoot, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Invalid path");
  return { workspaceRoot, safeRel, target };
}

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function uniqueDestPath(destDir: string, filename: string) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(destDir, filename);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(destDir, `${base} (${i})${ext}`);
    i++;
  }
  return candidate;
}

const ALLOWED_ROOTS = ["workspaces", "exports"];

function resolvePortablePath(rel: string) {
  const portable = getPortableRoot();

  const cleaned = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  const [root, ...rest] = cleaned.split("/");

  if (!root || !ALLOWED_ROOTS.includes(root)) {
    throw new Error("Path not allowed");
  }

  const abs = path.resolve(portable, root, ...rest);

  const allowedBase = path.resolve(portable, root) + path.sep;
  if (!abs.startsWith(allowedBase)) throw new Error("Path escape blocked");

  return abs;
}

async function statSafe(abs: string) {
  const s = await fsp.stat(abs);
  return {
    isDir: s.isDirectory(),
    size: s.size,
    mtimeMs: s.mtimeMs,
  };
}

function ensureDirs(root: string) {
  const dirs = [
    root,
    path.join(root, "models"),
    path.join(root, "workspaces", "default", "files"),
    path.join(root, "exports"),
    path.join(root, "bin"),
  ];
  for (const d of dirs) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function openDb(root: string) {
  const dbPath = path.join(root, "workspaces", "default", "chats.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      role TEXT,
      content TEXT,
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
  `);
  return db;
}

function listModels(root: string) {
  const modelsDir = path.join(root, "models");
  if (!fs.existsSync(modelsDir)) return [];
  return fs.readdirSync(modelsDir)
    .filter(f => f.toLowerCase().endsWith(".gguf"))
    .map(f => ({ filename: f, size: fs.statSync(path.join(modelsDir, f)).size }));
}

function killLlama() {
  if (!llamaProc) return;
  try { llamaProc.kill(); } catch {}
  llamaProc = null;
}

function startLlama(exePath: string, modelPath: string, port = 4891) {
  killLlama();

  if (!fs.existsSync(exePath)) throw new Error(`Missing llama-server.exe at ${exePath}`);
  if (!fs.existsSync(modelPath)) throw new Error(`Missing model at ${modelPath}`);

  const args = [
    "-m", modelPath,
    "--host", "127.0.0.1",
    "--port", String(port),
    "-c", "4096"
  ];

  const cwd = path.dirname(path.dirname(exePath));
  llamaProc = spawn(exePath, args, { cwd });
  llamaProc.stdout.on("data", (d) => console.log("[llama]", d.toString()));
  llamaProc.stderr.on("data", (d) => console.error("[llama]", d.toString()));
  llamaProc.on("exit", () => { llamaProc = null; });
  return { port };
}

function httpGet(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => resolve(res.statusCode ?? 0));
    req.on("error", reject);
    req.end();
  });
}

async function waitForServerReady(url: string, timeoutMs = 120000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const code = await httpGet(url);
      if (code >= 200 && code < 300) return true;

      if (code === 503) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
    } catch {
      // connection refused while process is booting
    }

    await new Promise(r => setTimeout(r, 500));
  }

  return false;
}

async function createWindow() {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "LanternLM",
    icon: devUrl
      ? path.join(process.cwd(), "public", "lanternlm-icon.png")
      : path.join(__dirname, "../dist/lanternlm-icon.png"),
    backgroundColor: "#0b0b0b",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: Boolean(devUrl),
    },
  });

  mainWindow.webContents.on("before-input-event", (event, input) => {
    const isDevTools =
      (input.control && input.shift && input.key.toLowerCase() === "i") ||
      input.key === "F12";

    if (isDevTools) event.preventDefault();
  });

  if (devUrl) {
    await mainWindow.loadURL(devUrl);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(() => {
  const root = getPortableRoot();
  ensureDirs(root);
  protocol.registerFileProtocol("docket", (request, callback) => {
    try {
      const url = new URL(request.url);
      const rel = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      const { target } = resolveWorkspacePath(rel);
      callback({ path: target });
    } catch {
      callback({ error: -6 });
    }
  });
  createWindow();
});

app.on("window-all-closed", () => {
  killLlama();
  app.quit();
});

// IPC
ipcMain.handle("app:quit", async () => {
  app.quit();
  return true;
});
ipcMain.handle("portable:getRoot", () => getPortableRoot());
ipcMain.handle("models:list", () => listModels(getPortableRoot()));
ipcMain.handle("files:list", async (_e, relPath = "") => {
  const { target, safeRel } = resolveWorkspacePath(relPath);
  const entries = fs.readdirSync(target, { withFileTypes: true });

  return entries
    .map((e) => {
      const abs = path.join(target, e.name);
      const isDir = e.isDirectory();
      const size = !isDir ? fs.statSync(abs).size : 0;

      return {
        name: e.name,
        isDir,
        path: path.join(safeRel, e.name).replace(/\\/g, "/"),
        size,
      };
    })
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
});
ipcMain.handle("llama:start", async (_evt, modelFile: string | { modelFilename: string }) => {
  const portable = getPortableRoot();
  const exe = path.join(portable, "bin", "llama-server.exe");
  const modelName = typeof modelFile === "string" ? modelFile : modelFile.modelFilename;
  const modelPath = path.join(portable, "models", modelName);

  startLlama(exe, modelPath);

  const ok = await waitForServerReady("http://127.0.0.1:4891/v1/models", 120000);
  return { ok };
});

ipcMain.handle("llama:health", async () => {
  try {
    const code = await httpGet("http://127.0.0.1:4891/v1/models");
    return code >= 200 && code < 300;
  } catch {
    return false;
  }
});

ipcMain.handle("files:listDir", async (_e, relDir: string) => {
  const absDir = resolvePortablePath(relDir);
  const entries = await fsp.readdir(absDir, { withFileTypes: true });

  const out = [];
  for (const ent of entries) {
    const abs = path.join(absDir, ent.name);
    const st = await statSafe(abs);
    out.push({
      name: ent.name,
      rel: path.posix.join(relDir.replace(/\\/g, "/"), ent.name),
      ...st,
    });
  }

  out.sort((a: any, b: any) => (Number(b.isDir) - Number(a.isDir)) || a.name.localeCompare(b.name));
  return out;
});

ipcMain.handle("files:readText", async (_e, relFile: string) => {
  const { target } = resolveWorkspacePath(relFile);
  const stat = fs.statSync(target);
  const MAX = 2 * 1024 * 1024;
  if (stat.size > MAX) throw new Error("File too large to preview as text (2MB limit).");
  return fs.readFileSync(target, "utf-8");
});

ipcMain.handle("files:writeText", async (_e, relFile: string, content: string) => {
  const abs = resolvePortablePath(relFile);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, "utf8");
  return true;
});

ipcMain.handle("files:delete", async (_e, relPath: string) => {
  const { target } = resolveWorkspacePath(relPath);

  const res = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Cancel", "Delete"],
    defaultId: 0,
    cancelId: 0,
    title: "Delete file",
    message: `Delete this item?\n\n${target}`,
  });

  if (res.response !== 1) return false;

  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    fs.rmSync(target, { recursive: true, force: true });
  } else {
    fs.rmSync(target, { force: true });
  }
  return true;
});

ipcMain.handle("files:openInExplorer", async (_e, relPath: string) => {
  const { target } = resolveWorkspacePath(relPath);
  shell.showItemInFolder(target);
  return true;
});

ipcMain.handle("files:rename", async (_e, relPath: string, newName: string) => {
  const { target } = resolveWorkspacePath(relPath);

  const trimmed = String(newName || "").trim();
  if (!trimmed) throw new Error("New name is empty");
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) throw new Error("Invalid name");

  const dest = path.join(path.dirname(target), trimmed);
  const root = getPortableRoot();
  const rel = path.relative(root, dest);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Invalid rename target");

  fs.renameSync(target, dest);
  return true;
});

ipcMain.handle("files:importToDir", async (_e, destDirRel: string, sourcePaths: string[]) => {
  const { target: destDir } = resolveWorkspacePath(destDirRel || "");
  ensureDir(destDir);

  const copied: string[] = [];

  for (const src of sourcePaths || []) {
    const base = path.basename(src);
    const dest = uniqueDestPath(destDir, base);

    const st = fs.statSync(src);
    if (st.isDirectory()) continue;

    fs.copyFileSync(src, dest);
    const rel = path.relative(getPortableRoot(), dest).replace(/\\/g, "/");
    copied.push(rel);
  }

  return copied;
});

ipcMain.handle("files:mkdir", async (_e, relDir: string) => {
  const abs = resolvePortablePath(relDir);
  await fsp.mkdir(abs, { recursive: true });
  return true;
});

ipcMain.handle("files:reveal", async (_e, relPath: string) => {
  const abs = resolvePortablePath(relPath);
  await shell.showItemInFolder(abs);
  return true;
});

ipcMain.handle("files:copyToExports", async (_e, relPath: string) => {
  const { target } = resolveWorkspacePath(relPath);

  const exportsDir = path.join(getPortableRoot(), "exports");
  ensureDir(exportsDir);

  const filename = path.basename(target);
  const dest = uniqueDestPath(exportsDir, filename);

  fs.copyFileSync(target, dest);

  const rel = path.relative(getPortableRoot(), dest).replace(/\\/g, "/");
  return rel;
});

ipcMain.handle("llama:chatStream", async (_evt, payload: {
  model?: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
  max_tokens?: number;
}) => {
  const url = "http://127.0.0.1:4891/v1/chat/completions";

  return await new Promise<{ ok: boolean; text?: string; error?: string }>((resolve) => {
    const request = net.request({
      method: "POST",
      url,
      headers: { "Content-Type": "application/json" },
    });

    let full = "";

    request.on("response", (res) => {
      res.on("data", (chunk) => {
        const s = chunk.toString("utf8");
        for (const line of s.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;

          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") {
            resolve({ ok: true, text: full });
            return;
          }

          try {
            const json = JSON.parse(data);
            const delta = json?.choices?.[0]?.delta?.content ?? "";
            if (delta) full += delta;

            mainWindow?.webContents.send("llama:token", delta);
          } catch {
            // ignore partial JSON
          }
        }
      });

      res.on("end", () => resolve({ ok: true, text: full }));
    });

    request.on("error", (err) => resolve({ ok: false, error: String(err?.message ?? err) }));

    const body = JSON.stringify({
      model: payload.model ?? "local",
      stream: true,
      temperature: payload.temperature ?? 0.7,
      max_tokens: payload.max_tokens ?? 512,
      messages: payload.messages,
    });

    request.write(body);
    request.end();
  });
});

ipcMain.handle("db:init", () => { const db = openDb(getPortableRoot()); db.close(); return true; });
ipcMain.handle("db:listConversations", () => {
  const db = openDb(getPortableRoot());
  const rows = db.prepare(`SELECT * FROM conversations ORDER BY created_at DESC`).all();
  db.close();
  return rows;
});
ipcMain.handle("db:createConversation", (_e, { id, title }: { id: string; title: string }) => {
  const db = openDb(getPortableRoot());
  db.prepare(`INSERT INTO conversations(id, title, created_at) VALUES(?,?,?)`).run(id, title, Date.now());
  db.close();
  return true;
});
ipcMain.handle("db:getMessages", (_e, { conversationId }: { conversationId: string }) => {
  const db = openDb(getPortableRoot());
  const rows = db.prepare(`SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at ASC`).all(conversationId);
  db.close();
  return rows;
});
ipcMain.handle("db:addMessage", (_e, { id, conversationId, role, content }: any) => {
  const db = openDb(getPortableRoot());
  db.prepare(`INSERT INTO messages(id, conversation_id, role, content, created_at) VALUES(?,?,?,?,?)`)
    .run(id, conversationId, role, content, Date.now());
  db.close();
  return true;
});
ipcMain.handle("db:updateMessage", (_e, { id, conversationId, content }: { id: string; conversationId: string; content: string }) => {
  const db = openDb(getPortableRoot());
  db.prepare(`UPDATE messages SET content=? WHERE id=? AND conversation_id=?`)
    .run(content, id, conversationId);
  db.close();
  return true;
});
ipcMain.handle("db:updateConversationTitle", (_e, { id, title }: { id: string; title: string }) => {
  const db = openDb(getPortableRoot());
  db.prepare(`UPDATE conversations SET title=? WHERE id=?`).run(title, id);
  db.close();
  return true;
});
ipcMain.handle("db:deleteConversation", (_e, { id }: { id: string }) => {
  const db = openDb(getPortableRoot());
  db.prepare(`DELETE FROM messages WHERE conversation_id=?`).run(id);
  db.prepare(`DELETE FROM conversations WHERE id=?`).run(id);
  db.close();
  return true;
});
ipcMain.handle("db:clearAll", () => {
  const root = getPortableRoot();
  const dbPath = path.join(root, "workspaces", "default", "chats.db");

  try {
    const db = openDb(root);
    db.close();
  } catch {}

  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }

  return true;
});
