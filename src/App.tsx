import { useEffect, useMemo, useRef, useState } from "react";
import FilesView from "./FilesView";
import "./App.css";

type Role = "system" | "user" | "assistant";

type ChatMessage = {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
};

type Chat = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
};

type ModelFile = { filename: string; size: number };

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export default function App() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState("");
  const activeChat = chats.find(c => c.id === activeChatId) ?? null;
  const [input, setInput] = useState("");
  const [view, setView] = useState<"chat" | "files">("chat");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Models
  const [models, setModels] = useState<ModelFile[]>([]);
  const [activeModel, setActiveModel] = useState<string>("");
  const [modelReady, setModelReady] = useState(false);
  const [loadingModel, setLoadingModel] = useState(false);

  useEffect(() => {
    (async () => {
      const m = await window.api.models.list();
      setModels(m);
      if (m?.[0]?.filename) setActiveModel(m[0].filename);
    })();
  }, []);

  function scrollToBottom() {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }

  useEffect(() => {
    scrollToBottom();
  }, [activeChat?.messages]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        await window.api.db.init();
        const conversations = await window.api.db.listConversations();
        if (cancelled) return;

        if (!conversations?.length) {
          const id = crypto.randomUUID();
          const now = Date.now();
          const newChat: Chat = {
            id,
            title: "New Chat",
            createdAt: now,
            updatedAt: now,
            messages: [],
          };
          await window.api.db.createConversation(id, newChat.title);
          if (cancelled) return;
          setChats([newChat]);
          setActiveChatId(id);
          return;
        }

        const loaded: Chat[] = [];
        for (const c of conversations) {
          const msgs = await window.api.db.getMessages(c.id);
          const messages: ChatMessage[] = (msgs || []).map((m: any) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            createdAt: m.created_at,
          }));
          const lastTime = messages.length ? messages[messages.length - 1].createdAt : c.created_at;
          loaded.push({
            id: c.id,
            title: c.title || "New Chat",
            createdAt: c.created_at,
            updatedAt: lastTime,
            messages,
          });
        }

        if (cancelled) return;
        setChats(loaded);
        setActiveChatId(loaded[0]?.id ?? "");
      } catch (e) {
        console.error("Failed to load chats:", e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  async function createChat() {
    const id = crypto.randomUUID();
    const newChat: Chat = {
      id,
      title: "New Chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    setChats(prev => [newChat, ...prev]);
    setActiveChatId(id);
    setView("chat");
    setSettingsOpen(false);
    try {
      await window.api.db.createConversation(id, newChat.title);
    } catch (e) {
      console.error("Failed to create conversation:", e);
    }
  }

  async function loadModel() {
    if (!activeModel) return;
    setLoadingModel(true);
    setModelReady(false);

    await window.api.llama.start(activeModel);

    // poll /health
    for (let i = 0; i < 40; i++) {
      const ok = await window.api.llama.health();
      if (ok) {
        setModelReady(true);
        break;
      }
      await sleep(250);
    }

    setLoadingModel(false);
  }

  function makeTitleFromPrompt(prompt: string) {
    const cleaned = prompt.replace(/\s+/g, " ").trim();
    const words = cleaned.split(" ").slice(0, 8).join(" ");
    const title = words.length ? words : "New Chat";
    return title.length > 42 ? title.slice(0, 42) + "..." : title;
  }

  function renameChat(id: string, title: string) {
    const t = title.trim() || "New Chat";
    setChats((prev) => prev.map((c) => (c.id === id ? { ...c, title: t, updatedAt: Date.now() } : c)));
    window.api.db.updateConversationTitle(id, t).catch((e: any) => {
      console.error("Failed to rename conversation:", e);
    });
  }

  function startRename(id: string, current: string) {
    setEditingChatId(id);
    setEditingTitle(current);
  }

  function commitRename() {
    if (!editingChatId) return;
    renameChat(editingChatId, editingTitle);
    setEditingChatId(null);
  }

  function cancelRename() {
    setEditingChatId(null);
    setEditingTitle("");
  }

  function deleteChat(id: string) {
    const next = chats.filter((c) => c.id !== id);
    let nextActiveId = activeChatId;
    let createdChat: Chat | null = null;

    if (activeChatId === id) {
      if (next.length) {
        nextActiveId = next[0].id;
      } else {
        const newId = crypto.randomUUID();
        createdChat = {
          id: newId,
          title: "New Chat",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [],
        };
        next.push(createdChat);
        nextActiveId = newId;
      }
    }

    setChats(next);
    setActiveChatId(nextActiveId);

    window.api.db.deleteConversation(id).catch((e: any) => {
      console.error("Failed to delete conversation:", e);
    });
    if (createdChat) {
      window.api.db.createConversation(createdChat.id, createdChat.title).catch((e: any) => {
        console.error("Failed to create replacement conversation:", e);
      });
    }
  }

  function stopGenerating() {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsGenerating(false);
  }

  async function onSend() {
    const text = input.trim();
    if (!text) return;
    if (!activeChat) return;
    setInput("");

    const chatId = activeChatId;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      createdAt: Date.now(),
    };

    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      createdAt: Date.now(),
    };

    const isFirstUserMessage = activeChat.messages.length === 0 && activeChat.title === "New Chat";
    const newTitle = isFirstUserMessage ? makeTitleFromPrompt(text) : activeChat.title;

    setChats((prev) =>
      prev.map((c) => {
        if (c.id !== activeChatId) return c;

        return {
          ...c,
          title: newTitle,
          updatedAt: Date.now(),
          messages: [...c.messages, userMsg, assistantMsg],
        };
      })
    );
    if (isFirstUserMessage && newTitle !== "New Chat") {
      window.api.db.updateConversationTitle(activeChatId, newTitle).catch((e: any) => {
        console.error("Failed to update conversation title:", e);
      });
    }
    window.api.db.addMessage(userMsg.id, chatId, userMsg.role, userMsg.content).catch((e: any) => {
      console.error("Failed to save user message:", e);
    });
    window.api.db.addMessage(assistantMsg.id, chatId, assistantMsg.role, assistantMsg.content).catch((e: any) => {
      console.error("Failed to save assistant placeholder:", e);
    });

    if (!modelReady) {
      await loadModel();
    }

    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setIsGenerating(true);

    const history = activeChat.messages
      .filter(m => !(m.role === "assistant" && m.content === ""));

    const payloadMessages = [
      { role: "system", content: "You are a helpful assistant." },
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: "user", content: text },
    ];

    try {
      const res = await fetch("http://127.0.0.1:4891/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: activeModel || "local",
          stream: true,
          temperature: 0.7,
          max_tokens: 512,
          repeat_penalty: 1.1,
          messages: payloadMessages,
        }),
        signal: abortRef.current.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`Llama server error (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let fullText = "";

      let streamDone = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const lines = part.split("\n");
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;

            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              streamDone = true;
              break;
            }

            try {
              const json = JSON.parse(data);
              const delta = json?.choices?.[0]?.delta?.content ?? "";
              if (!delta) continue;

              if (fullText && delta.startsWith(fullText)) {
                fullText = delta;
              } else {
                fullText += delta;
              }

              setChats(prev =>
                prev.map(c => {
                  if (c.id !== chatId) return c;
                  if (c.messages.length === 0) return c;

                  const copy = [...c.messages];
                  const last = copy[copy.length - 1];
                  if (last.role !== "assistant") return c;

                  copy[copy.length - 1] = { ...last, content: fullText };
                  return { ...c, messages: copy, updatedAt: Date.now() };
                })
              );
            } catch {
              // ignore partial JSON
            }
          }
          if (streamDone) break;
        }
        if (streamDone) break;
      }
      if (fullText) {
        window.api.db.updateMessage(assistantMsg.id, chatId, fullText).catch((e: any) => {
          console.error("Failed to update assistant message:", e);
        });
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        alert(String(e?.message ?? e));
      }
    } finally {
      stopGenerating();
    }
  }

  const statusText = useMemo(() => {
    if (loadingModel) return "loading";
    return modelReady ? "ready" : "not loaded";
  }, [loadingModel, modelReady]);

  const statusState = useMemo(() => {
    if (loadingModel) return "loading";
    return modelReady ? "ready" : "error";
  }, [loadingModel, modelReady]);

  async function clearAllChats() {
    const ok = confirm("Clear ALL chat history? This cannot be undone.");
    if (!ok) return;

    try {
      await window.api.db.clearAll();
      await window.api.db.init();

      const id = crypto.randomUUID();
      const now = Date.now();
      const newChat: Chat = {
        id,
        title: "New Chat",
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      await window.api.db.createConversation(id, newChat.title);
      setChats([newChat]);
      setActiveChatId(id);
      setView("chat");
    } catch (e) {
      console.error("Failed to clear chats:", e);
      alert("Failed to clear chat history.");
    }
  }

  return (
    <div className="appShell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand">
            <img src="./lanternlm-icon.png" alt="" />
            <span>LanternLM<sup>™</sup></span>
          </div>
          <button className="new-chat" onClick={createChat}>+ New Chat</button>
        </div>

        <div className="sidebar-section">
          <div className="section-title">CHATS</div>
          {chats.map((c) => (
          <div
              key={c.id}
              onClick={() => {
                setActiveChatId(c.id);
                setView("chat");
                setSettingsOpen(false);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 12px",
                borderRadius: 10,
                cursor: "pointer",
                background: c.id === activeChatId ? "rgba(255,255,255,0.06)" : "transparent",
              }}
            >
              {editingChatId === c.id ? (
                <input
                  className="renameInput"
                  value={editingTitle}
                  onChange={(e) => setEditingTitle(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitRename();
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      cancelRename();
                    }
                  }}
                  onBlur={() => commitRename()}
                  autoFocus
                />
              ) : (
                <div
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    startRename(c.id, c.title);
                  }}
                  title="Double-click to rename"
                >
                  {c.title}
                </div>
              )}

              <button
                type="button"
                className="iconBtn"
                onClick={(e) => {
                  e.stopPropagation();
                  startRename(c.id, c.title);
                }}
                title="Rename chat"
              >
                📝
              </button>

              <button
                type="button"
                className="iconBtn"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete "${c.title}"?`)) deleteChat(c.id);
                }}
                title="Delete chat"
              >
                🗑️
              </button>
            </div>
          ))}
        </div>

        <div className="sidebar-bottom">
          <div className="ownership">© 2026 Faheem</div>
          <button
            className={`sidebar-btn ${view === "files" ? "active" : ""}`}
            onClick={() => {
              setView("files");
              setSettingsOpen(false);
            }}
          >
            Files
          </button>
          <div className="dropdown">
            <button
              className={`sidebar-btn ${settingsOpen ? "active" : ""}`}
              onClick={() => setSettingsOpen((v) => !v)}
            >
              Settings
            </button>
            {settingsOpen ? (
              <div className="dropdown-menu">
                <button
                  className="dropdown-item"
                  onClick={() => {
                    setSettingsOpen(false);
                    window.app.quit();
                  }}
                >
                  Exit LanternLM
                </button>
                <button
                  className="dropdown-item danger"
                  onClick={() => {
                    setSettingsOpen(false);
                    clearAllChats();
                  }}
                >
                  Clear All Chat History
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </aside>

      <main className="mainPane">
        {view === "files" ? (
          <FilesView />
        ) : (
          <>
            <div className="chatPane">
              <div className="chatScroll" ref={scrollRef}>
                <div className="chatBottomSpacer" />
                {activeChat?.messages.map(m => (
                  <div key={m.id} className={`bubble ${m.role}`}>{m.content}</div>
                ))}
                <div ref={bottomRef} />
              </div>
            </div>

            <div className="composer">
              <div className="composerRow">
                <textarea
                  className="pillInput"
                  placeholder="Ask anything"
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key !== "Enter" || e.shiftKey) return;
                    e.preventDefault();
                    if (isGenerating) stopGenerating();
                    else onSend();
                  }}
                />
                <button className="sendBtn" onClick={isGenerating ? stopGenerating : onSend}>
                  {isGenerating ? "Stop" : "Send"}
                </button>
              </div>

              <div className="composerMeta">
                <select className="modelSelect" value={activeModel} onChange={(e) => setActiveModel(e.target.value)}>
                  {models.length === 0 ? <option>No models found</option> : null}
                  {models.map(m => (
                    <option key={m.filename} value={m.filename}>{m.filename}</option>
                  ))}
                </select>
                <button className="sendBtn" onClick={loadModel} disabled={!activeModel || loadingModel}>
                  {loadingModel ? "Loading..." : (modelReady ? "Reload" : "Load")}
                </button>
                <span className={`statusDot ${statusState}`} />
                <span className="statusText">{statusText}</span>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

