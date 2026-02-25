async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || res.statusText);
  }
  return res.json();
}

export const api = {
  // ── Auth ──────────────────────────────────────────────────────────────────
  getMe: () => apiFetch("/api/auth/me"),
  signInWithGoogle: (credential: string) =>
    apiFetch("/api/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential }),
    }),
  logout: () => apiFetch("/api/auth/logout", { method: "POST" }),

  // ── Accounts ──────────────────────────────────────────────────────────────
  getAccounts: () => apiFetch("/api/accounts"),
  getAuthUrl: (accountIndex: number) => apiFetch(`/api/auth/authorize/${accountIndex}`),
  exchangeCode: (code: string, accountIndex: number) =>
    apiFetch("/api/auth/exchange-code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, accountIndex }) }),
  getAuthStatus: () => apiFetch("/api/auth/status"),

  // ── Entities ──────────────────────────────────────────────────────────────
  getEntities: () => apiFetch("/api/entities"),
  createEntity: (data: { name: string; patterns?: string[] }) =>
    apiFetch("/api/entities", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }),
  deleteEntity: (id: string) =>
    apiFetch(`/api/entities/${id}`, { method: "DELETE" }),

  importEntities: async (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/entities/import", { method: "POST", body: formData });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error || res.statusText);
    }
    return res.json();
  },

  uploadCredentials: async (file: File, accountIndex: number) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("accountIndex", String(accountIndex));
    const res = await fetch("/api/credentials/upload", { method: "POST", body: formData });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error || res.statusText);
    }
    return res.json();
  },

  previewQuery: (data: any) =>
    apiFetch("/api/query/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }),

  runQuery: (data: any) =>
    apiFetch("/api/query/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }),

  downloadAttachment: (accountIndex: number, messageId: string, attachmentId: string, filename: string) =>
    `/api/attachments/${accountIndex}/${messageId}/${attachmentId}?filename=${encodeURIComponent(filename)}`,
};
