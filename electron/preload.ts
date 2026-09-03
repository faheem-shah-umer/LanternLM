import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  portable: { getRoot: () => ipcRenderer.invoke("portable:getRoot") },
  models: { list: () => ipcRenderer.invoke("models:list") },
  llama: {
    start: (modelFilename: string) => ipcRenderer.invoke("llama:start", { modelFilename }),
    health: () => ipcRenderer.invoke("llama:health"),
    chatStream: (payload: any) => ipcRenderer.invoke("llama:chatStream", payload),
    onToken: (cb: (token: string) => void) => ipcRenderer.on("llama:token", (_e, t) => cb(t)),
  },
  db: {
    init: () => ipcRenderer.invoke("db:init"),
    listConversations: () => ipcRenderer.invoke("db:listConversations"),
    createConversation: (id: string, title: string) => ipcRenderer.invoke("db:createConversation", { id, title }),
    getMessages: (conversationId: string) => ipcRenderer.invoke("db:getMessages", { conversationId }),
    addMessage: (id: string, conversationId: string, role: string, content: string) =>
      ipcRenderer.invoke("db:addMessage", { id, conversationId, role, content }),
    updateMessage: (id: string, conversationId: string, content: string) =>
      ipcRenderer.invoke("db:updateMessage", { id, conversationId, content }),
    updateConversationTitle: (id: string, title: string) =>
      ipcRenderer.invoke("db:updateConversationTitle", { id, title }),
    deleteConversation: (id: string) =>
      ipcRenderer.invoke("db:deleteConversation", { id }),
    clearAll: () =>
      ipcRenderer.invoke("db:clearAll"),
  }
});

contextBridge.exposeInMainWorld("app", {
  quit: () => ipcRenderer.invoke("app:quit"),
});

contextBridge.exposeInMainWorld("files", {
  list: (p?: string) => ipcRenderer.invoke("files:list", p),
  readText: (p: string) => ipcRenderer.invoke("files:readText", p),
  copyToExports: (p: string) => ipcRenderer.invoke("files:copyToExports", p),
  url: (p: string) => `docket:///${encodeURIComponent(p).replace(/%2F/g, "/")}`,
  openInExplorer: (p: string) => ipcRenderer.invoke("files:openInExplorer", p),
  rename: (p: string, name: string) => ipcRenderer.invoke("files:rename", p, name),
  delete: (p: string) => ipcRenderer.invoke("files:delete", p),
  importToDir: (dir: string, sourcePaths: string[]) => ipcRenderer.invoke("files:importToDir", dir, sourcePaths),
});
