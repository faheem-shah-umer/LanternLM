import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, DragEvent } from "react";

type Entry = {
  name: string;
  isDir: boolean;
  path: string; // portable-relative like "workspaces/foo.txt"
  size: number;
};

function humanSize(bytes: number) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function ext(p: string) {
  const idx = p.lastIndexOf(".");
  return idx >= 0 ? p.slice(idx + 1).toLowerCase() : "";
}

function btnStyle(disabled: boolean): CSSProperties {
  return {
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.12)",
    background: disabled ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.06)",
    color: "rgba(255,255,255,0.9)",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

const TEXT_EXT = new Set(["txt", "md", "json", "js", "ts", "tsx", "css", "html", "py", "yaml", "yml", "log"]);
const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const PDF_EXT = new Set(["pdf"]);

export default function FilesView() {
  const [cwd, setCwd] = useState(""); // portable-relative dir
  const [entries, setEntries] = useState<Entry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const [selected, setSelected] = useState<Entry | null>(null);
  const [previewText, setPreviewText] = useState<string>("");
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  const crumbs = useMemo(() => {
    const parts = cwd ? cwd.split("/").filter(Boolean) : [];
    const items: { label: string; path: string }[] = [{ label: "portable", path: "" }];
    let acc = "";
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      items.push({ label: p, path: acc });
    }
    return items;
  }, [cwd]);

  useEffect(() => {
    setErr(null);
    setSelected(null);
    setPreviewText("");
    setPreviewErr(null);

    window.files
      .list(cwd)
      .then(setEntries)
      .catch((e: any) => {
        setEntries([]);
        setErr(String(e?.message ?? e));
      });
  }, [cwd]);

  async function openEntry(e: Entry) {
    setSelected(e);
    setPreviewText("");
    setPreviewErr(null);

    if (e.isDir) {
      setCwd(e.path);
      return;
    }

    const eext = ext(e.path);

    if (TEXT_EXT.has(eext)) {
      try {
        const txt = await window.files.readText(e.path);
        setPreviewText(txt);
      } catch (ex: any) {
        setPreviewErr(String(ex?.message ?? ex));
      }
    }
  }

  async function copySelectedToExports() {
    if (!selected || selected.isDir) return;
    try {
      const rel = await window.files.copyToExports(selected.path);
      alert(`Copied to exports: ${rel}`);
    } catch (ex: any) {
      alert(String(ex?.message ?? ex));
    }
  }

  async function handleDrop(ev: DragEvent<HTMLDivElement>) {
    ev.preventDefault();
    setDragOver(false);

    const files = Array.from(ev.dataTransfer.files || []);
    if (!files.length) return;

    const sourcePaths = files.map((f: any) => f.path).filter(Boolean);
    if (!sourcePaths.length) {
      alert("Drag/drop path not available. (This works inside Electron window)");
      return;
    }

    try {
      await window.files.importToDir(cwd, sourcePaths);
      const refreshed = await window.files.list(cwd);
      setEntries(refreshed);
    } catch (e: any) {
      alert(String(e?.message ?? e));
    }
  }

  const selectedUrl = selected ? window.files.url(selected.path) : "";

  const selectedKind = selected && !selected.isDir ? (() => {
    const eext = ext(selected.path);
    if (IMG_EXT.has(eext)) return "image";
    if (PDF_EXT.has(eext)) return "pdf";
    if (TEXT_EXT.has(eext)) return "text";
    return "unknown";
  })() : null;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "420px 1fr", height: "100%", gap: 16, padding: 16 }}>
      {/* LEFT: Browser */}
      <div style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ padding: 12, borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Files</div>

          {/* Breadcrumbs */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, fontSize: 13, opacity: 0.9 }}>
            {crumbs.map((c, i) => (
              <span key={c.path}>
                <button
                  onClick={() => setCwd(c.path)}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "rgba(255,255,255,0.9)",
                    cursor: "pointer",
                    padding: 0,
                    fontSize: 13,
                    textDecoration: "underline",
                    textUnderlineOffset: 3,
                  }}
                >
                  {c.label}
                </button>
                {i < crumbs.length - 1 ? <span style={{ opacity: 0.5 }}> / </span> : null}
              </span>
            ))}
          </div>

          {err && <div style={{ color: "#ff6b6b", marginTop: 8, fontSize: 12 }}>Error: {err}</div>}
        </div>

        <div style={{ maxHeight: "calc(100% - 70px)", overflow: "auto" }}>
          {entries.map((e) => {
            const isActive = selected?.path === e.path;
            return (
              <button
                key={e.path}
                onClick={() => openEntry(e)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "10px 12px",
                  background: isActive ? "rgba(255,255,255,0.06)" : "transparent",
                  border: "none",
                  borderBottom: "1px solid rgba(255,255,255,0.04)",
                  color: "rgba(255,255,255,0.92)",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span>{e.isDir ? "📁" : "📄"}</span>
                  <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 280 }}>
                    {e.name}
                  </span>
                </span>

                {!e.isDir ? (
                  <span style={{ opacity: 0.65, fontSize: 12 }}>{humanSize(e.size)}</span>
                ) : (
                  <span style={{ opacity: 0.35, fontSize: 12 }}>folder</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* RIGHT: Preview */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        style={{
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 12,
          overflow: "hidden",
          outline: dragOver ? "2px dashed rgba(255,255,255,0.35)" : "none",
        }}
      >
        <div style={{ padding: 12, borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{ fontWeight: 700, flex: 1 }}>
            {selected ? (selected.isDir ? `Folder: ${selected.name}` : `Preview: ${selected.name}`) : "Select a file to preview"}
          </div>

          <button
            disabled={!selected || selected.isDir}
            onClick={copySelectedToExports}
            style={btnStyle(!selected || selected.isDir)}
          >
            Copy to exports
          </button>

          <button
            disabled={!selected}
            onClick={() => selected && window.files.openInExplorer(selected.path)}
            style={btnStyle(!selected)}
          >
            Open in Explorer
          </button>

          <button
            disabled={!selected}
            onClick={async () => {
              if (!selected) return;
              const next = prompt("Rename to:", selected.name);
              if (!next) return;
              await window.files.rename(selected.path, next);
              const refreshed = await window.files.list(cwd);
              setEntries(refreshed);
              setSelected(null);
            }}
            style={btnStyle(!selected)}
          >
            Rename
          </button>

          <button
            disabled={!selected}
            onClick={async () => {
              if (!selected) return;
              const ok = await window.files.delete(selected.path);
              if (!ok) return;
              const refreshed = await window.files.list(cwd);
              setEntries(refreshed);
              setSelected(null);
            }}
            style={btnStyle(!selected)}
          >
            Delete
          </button>
        </div>

        <div style={{ height: "calc(100% - 56px)", overflow: "auto", padding: 12 }}>
          {!selected && (
            <div style={{ opacity: 0.7 }}>Pick a file on the left. Images and PDFs will preview here.</div>
          )}

          {selected && selected.isDir && (
            <div style={{ opacity: 0.7 }}>Folder selected. Click into it to browse.</div>
          )}

          {selected && !selected.isDir && selectedKind === "text" && (
            <>
              {previewErr ? (
                <div style={{ color: "#ff6b6b" }}>{previewErr}</div>
              ) : (
                <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 13, lineHeight: 1.5 }}>
                  {previewText || "Loading..."}
                </pre>
              )}
            </>
          )}

          {selected && !selected.isDir && selectedKind === "image" && (
            <img src={selectedUrl} style={{ maxWidth: "100%", borderRadius: 12 }} />
          )}

          {selected && !selected.isDir && selectedKind === "pdf" && (
            <iframe
              title="pdf-preview"
              src={selectedUrl}
              style={{ width: "100%", height: "80vh", border: "none", borderRadius: 12 }}
            />
          )}

          {selected && !selected.isDir && selectedKind === "unknown" && (
            <div style={{ opacity: 0.7 }}>
              No preview for this file type yet.
              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.6 }}>
                Path: {selected.path}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
