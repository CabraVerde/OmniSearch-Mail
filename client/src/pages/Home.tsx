import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Search, Mail, Building2, Calendar, FileText, Download, Settings2,
  Paperclip, CheckSquare, Image as ImageIcon, ChevronDown, ChevronRight,
  Plus, Trash2, Upload, Loader2, Eye, KeyRound, CheckCircle2, AlertCircle,
  FileBarChart, Archive, LogOut, ShieldCheck
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { api } from "@/lib/api";

// ── Google Identity Services type declaration ───────────────────────────────
// GIS is loaded via a <script> tag in index.html. We declare minimal types.
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: { client_id: string; callback: (resp: { credential: string }) => void }) => void;
          renderButton: (parent: HTMLElement, options: object) => void;
          prompt: () => void;
        };
      };
    };
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function isGenericFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  const nameOnly = lower.replace(/\.[^.]+$/, '');
  const genericPatterns = [
    /^inline_?\d*$/,
    /^attachment_?\d*$/,
    /^noname$/,
    /^att\d+$/,
    /^unnamed/,
    /^image\d*$/,
    /^file_?\d*$/,
  ];
  return genericPatterns.some(p => p.test(nameOnly));
}

function sanitizeForFilename(str: string): string {
  return str
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 80);
}

function getCleanAttachmentName(original: string, subject?: string): string {
  if (isGenericFilename(original) && subject) {
    const ext = original.includes('.') ? '.' + original.split('.').pop() : '';
    return sanitizeForFilename(subject) + ext;
  }
  return original;
}

function generateSmartFilename(dateStr: string, entityName: string | null, original: string, subject?: string) {
  try {
    const d = new Date(dateStr);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const entity = sanitizeForFilename(entityName || "Unknown");

    const namePart = getCleanAttachmentName(original, subject);

    return `${date}_${entity}_${namePart}`;
  } catch {
    return original;
  }
}

interface ComponentSelection {
  selected: boolean;
  attachmentIds: string[];
}

export default function Home() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const credFileInputRef = useRef<HTMLInputElement>(null);
  const googleButtonRef = useRef<HTMLDivElement>(null);

  // ── Session ────────────────────────────────────────────────────────────────
  // Fetch the current session user on load. A 401 means not logged in.
  const {
    data: sessionUser,
    isLoading: sessionLoading,
    refetch: refetchSession,
  } = useQuery({
    queryKey: ["/api/auth/me"],
    queryFn: api.getMe,
    retry: false,
    // Don't throw on 401 — we handle it as "not logged in"
  });

  // ── Google Sign-In initialization ──────────────────────────────────────────
  // Initialize GIS when the login screen is visible.
  useEffect(() => {
    if (sessionUser || sessionLoading) return; // Already logged in or loading
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string;
    if (!clientId || !window.google?.accounts?.id) return;

    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: async (response) => {
        try {
          const user = await api.signInWithGoogle(response.credential);
          await refetchSession();
          toast({ title: `Welcome, ${user.name}` });
        } catch (err: any) {
          toast({ title: "Sign-in failed", description: err.message, variant: "destructive" });
        }
      },
    });

    if (googleButtonRef.current) {
      window.google.accounts.id.renderButton(googleButtonRef.current, {
        theme: "outline",
        size: "large",
        text: "signin_with",
        width: 280,
      });
    }
  }, [sessionUser, sessionLoading]);

  const handleLogout = async () => {
    try {
      await api.logout();
      qc.clear();
      await refetchSession();
    } catch {
      // Ignore errors — the session will expire anyway
    }
  };

  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [selectedEntities, setSelectedEntities] = useState<string[]>([]);
  const [searchTerms, setSearchTerms] = useState("");
  const [daysBack, setDaysBack] = useState("30");
  const [maxMessages, setMaxMessages] = useState("50");
  const [includeInline, setIncludeInline] = useState(true);
  const [previewQuery, setPreviewQuery] = useState<string | null>(null);

  const [searchResults, setSearchResults] = useState<any[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isBundling, setIsBundling] = useState(false);
  const [expandedMessages, setExpandedMessages] = useState<Record<string, boolean>>({});

  const [selections, setSelections] = useState<Record<string, ComponentSelection>>({});

  const [addEntityOpen, setAddEntityOpen] = useState(false);
  const [newEntityName, setNewEntityName] = useState("");
  const [newEntityPatterns, setNewEntityPatterns] = useState("");

  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [authAccountIndex, setAuthAccountIndex] = useState<number>(0);
  const [authCode, setAuthCode] = useState("");
  const [isExchanging, setIsExchanging] = useState(false);
  const [isUploadingCred, setIsUploadingCred] = useState(false);
  const [queryExpanded, setQueryExpanded] = useState(false);

  const handleCredUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setIsUploadingCred(true);
    try {
      const nextIndex = (accounts as any[]).length + 1;
      await api.uploadCredentials(file, nextIndex);
      await qc.invalidateQueries({ queryKey: ["/api/accounts"] });
      toast({ title: `Account ${nextIndex} credentials loaded` });
    } catch (err: any) {
      toast({ title: "Failed to load credentials", description: err.message, variant: "destructive" });
    } finally {
      setIsUploadingCred(false);
    }
  };

  const { data: accounts = [], isLoading: accountsLoading } = useQuery({
    queryKey: ["/api/accounts"],
    queryFn: api.getAccounts,
  });
  const { data: entitiesData = [] } = useQuery({ queryKey: ["/api/entities"], queryFn: api.getEntities });

  const createEntityMut = useMutation({
    mutationFn: api.createEntity,
    onSuccess: (ent) => {
      qc.invalidateQueries({ queryKey: ["/api/entities"] });
      setSelectedEntities(prev => [...prev, ent.id]);
      setAddEntityOpen(false);
      setNewEntityName("");
      setNewEntityPatterns("");
      toast({ title: "Entity added" });
    },
  });

  const deleteEntityMut = useMutation({
    mutationFn: api.deleteEntity,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/entities"] }),
  });

  const importMut = useMutation({
    mutationFn: (file: File) => api.importEntities(file),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["/api/entities"] });
      toast({ title: `Imported ${data.imported} entities` });
    },
    onError: (err: any) => toast({ title: "Import failed", description: err.message, variant: "destructive" }),
  });

  const toggleAccount = (id: string) => {
    setSelectedAccounts(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const toggleEntity = (id: string) => {
    setSelectedEntities(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const handleAuthorize = async (accountIndex: number) => {
    try {
      const { url } = await api.getAuthUrl(accountIndex);
      window.open(url, '_blank', 'width=600,height=700');
      setAuthAccountIndex(accountIndex);
      setAuthCode("");
      setAuthDialogOpen(true);
    } catch (err: any) {
      toast({ title: "Auth failed", description: err.message, variant: "destructive" });
    }
  };

  const extractCode = (input: string): string => {
    const trimmed = input.trim();
    if (trimmed.includes('code=')) {
      try {
        const url = new URL(trimmed);
        return url.searchParams.get('code') || trimmed;
      } catch {
        const match = trimmed.match(/[?&]code=([^&]+)/);
        if (match) return decodeURIComponent(match[1]);
      }
    }
    return trimmed;
  };

  const handleExchangeCode = async () => {
    if (!authCode.trim()) return;
    setIsExchanging(true);
    const code = extractCode(authCode);
    try {
      await api.exchangeCode(code, authAccountIndex);
      qc.invalidateQueries({ queryKey: ["/api/accounts"] });
      toast({ title: `Account ${authAccountIndex} authorized successfully!` });
      setAuthDialogOpen(false);
      setAuthCode("");
    } catch (err: any) {
      toast({ title: "Authorization failed", description: err.message, variant: "destructive" });
    } finally {
      setIsExchanging(false);
    }
  };

  const handlePreview = async () => {
    try {
      const res = await api.previewQuery({
        accountIds: selectedAccounts,
        entityIds: selectedEntities,
        searchTerms,
        daysBack: parseInt(daysBack) || 30,
        maxMessages: parseInt(maxMessages) || 50,
        includeInline,
      });
      setPreviewQuery(res.query);
    } catch (err: any) {
      toast({ title: "Preview failed", description: err.message, variant: "destructive" });
    }
  };

  const handleSearch = async () => {
    setIsSearching(true);
    setSearchResults(null);
    setSelections({});
    try {
      const res = await api.runQuery({
        accountIds: selectedAccounts,
        entityIds: selectedEntities,
        searchTerms,
        daysBack: parseInt(daysBack) || 30,
        maxMessages: parseInt(maxMessages) || 50,
        includeInline,
      });

      setSearchResults(res.results);
      setPreviewQuery(res.query);

      const newSelections: Record<string, ComponentSelection> = {};
      const expanded: Record<string, boolean> = {};
      for (const r of res.results) {
        newSelections[r.id] = {
          selected: true,
          attachmentIds: r.attachments.map((a: any) => a.id),
        };
        expanded[r.id] = true;
      }
      setSelections(newSelections);
      setExpandedMessages(expanded);

      toast({ title: `Found ${res.total} messages` });
    } catch (err: any) {
      toast({ title: "Search failed", description: err.message, variant: "destructive" });
    } finally {
      setIsSearching(false);
    }
  };

  const getSelection = (msgId: string): ComponentSelection => {
    return selections[msgId] || { selected: false, attachmentIds: [] };
  };

  const updateSelection = (msgId: string, update: Partial<ComponentSelection>) => {
    setSelections(prev => ({
      ...prev,
      [msgId]: { ...getSelection(msgId), ...update },
    }));
  };

  const toggleMessageAll = (result: any) => {
    const sel = getSelection(result.id);
    const allAttIds = result.attachments.map((a: any) => a.id);
    const isFullySelected = sel.selected && sel.attachmentIds.length === allAttIds.length;

    if (isFullySelected) {
      updateSelection(result.id, { selected: false, attachmentIds: [] });
    } else {
      updateSelection(result.id, { selected: true, attachmentIds: allAttIds });
    }
  };

  const toggleAttachment = (msgId: string, attId: string) => {
    const sel = getSelection(msgId);
    const newAttIds = sel.attachmentIds.includes(attId)
      ? sel.attachmentIds.filter(id => id !== attId)
      : [...sel.attachmentIds, attId];
    updateSelection(msgId, { attachmentIds: newAttIds });
  };

  const toggleExpand = (resultId: string) => {
    setExpandedMessages(prev => ({ ...prev, [resultId]: !prev[resultId] }));
  };

  const getSelectedCount = () => {
    if (!searchResults) return { messages: 0, attachments: 0 };
    let messages = 0;
    let attachments = 0;
    for (const r of searchResults) {
      const sel = getSelection(r.id);
      if (sel.selected) {
        messages++;
        attachments += sel.attachmentIds.length;
      }
    }
    return { messages, attachments };
  };

  const handleBundleDownload = async () => {
    if (!searchResults) return;
    setIsBundling(true);

    try {
      const items = searchResults
        .filter(r => {
          const sel = getSelection(r.id);
          return sel.selected;
        })
        .map(r => {
          const sel = getSelection(r.id);
          return {
            messageId: r.id,
            accountIndex: r.accountIndex,
            subject: r.subject || '',
            from: r.from || '',
            to: r.to || '',
            cc: r.cc || '',
            date: r.date || '',
            bodyText: r.bodyText || '',
            bodyHtml: r.bodyHtml || '',
            entityName: r.matchedEntityName,
            attachments: r.attachments
              .filter((a: any) => sel.attachmentIds.includes(a.id))
              .map((a: any) => ({
                id: a.id,
                filename: a.filename,
                mimeType: a.mimeType || '',
                size: a.size || 0,
              })),
          };
        });

      if (items.length === 0) {
        toast({ title: "Nothing selected", variant: "destructive" });
        return;
      }

      const response = await fetch("/api/download/bundle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: "Download failed" }));
        throw new Error(err.error);
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `OmniSearch_${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      URL.revokeObjectURL(url);

      toast({ title: `Downloaded ${items.length} messages as ZIP` });
    } catch (err: any) {
      toast({ title: "Download failed", description: err.message, variant: "destructive" });
    } finally {
      setIsBundling(false);
    }
  };

  const selectAll = () => {
    if (!searchResults) return;
    const newSelections: Record<string, ComponentSelection> = {};
    for (const r of searchResults) {
      newSelections[r.id] = {
        selected: true,
        attachmentIds: r.attachments.map((a: any) => a.id),
      };
    }
    setSelections(newSelections);
  };

  const deselectAll = () => {
    if (!searchResults) return;
    const newSelections: Record<string, ComponentSelection> = {};
    for (const r of searchResults) {
      newSelections[r.id] = { selected: false, attachmentIds: [] };
    }
    setSelections(newSelections);
  };

  const authorizedAccounts = accounts.filter((a: any) => a.authorized);
  const { messages: selectedMsgCount, attachments: selectedAttCount } = getSelectedCount();
  const isAdmin = sessionUser?.isAdmin === true;

  // ── Auth gate ──────────────────────────────────────────────────────────────
  if (sessionLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!sessionUser) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-6 p-8 max-w-sm w-full">
          <div className="flex items-center gap-2 text-primary font-semibold text-2xl">
            <Search className="h-6 w-6" />
            OmniSearch Mail
          </div>
          <p className="text-sm text-muted-foreground text-center">
            Sign in with your <strong>@thegbexchange.com</strong> Google Workspace account to continue.
          </p>
          {/* GIS renders the Google button into this div */}
          <div ref={googleButtonRef} />
          <p className="text-xs text-muted-foreground text-center mt-2">
            Access is restricted to authorised @thegbexchange.com users only.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden font-sans">

      {/* SIDEBAR */}
      <div className="w-80 border-r bg-card flex flex-col shadow-sm z-10">
        <div className="p-4 border-b bg-card">
          <div className="flex items-center gap-2 text-primary font-semibold text-lg">
            <Search className="h-5 w-5" />
            OmniSearch Mail
          </div>
          <p className="text-xs text-muted-foreground mt-1">Cross-account smart queries</p>
          {/* Logged-in user info + logout */}
          <div className="flex items-center justify-between mt-2 pt-2 border-t">
            <div className="flex items-center gap-1">
              {isAdmin && <ShieldCheck className="h-3 w-3 text-primary" aria-label="Admin" />}
              <span className="text-xs text-muted-foreground truncate max-w-[160px]" title={sessionUser.email}>
                {sessionUser.email}
              </span>
            </div>
            <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" title="Sign out" onClick={handleLogout}>
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-4 space-y-6">

            {/* Accounts */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium flex items-center gap-2">
                  <Mail className="h-4 w-4 text-muted-foreground" /> Gmail Accounts
                </h3>
                <div className="flex items-center gap-1">
                  <Badge variant="secondary" className="text-xs">
                    {selectedAccounts.length}/{authorizedAccounts.length} selected
                  </Badge>
                  {/* Credential upload is admin-only — pre-provisioned accounts are set via env vars */}
                  {isAdmin && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        title="Upload credentials JSON (admin only)"
                        onClick={() => credFileInputRef.current?.click()}
                        disabled={isUploadingCred}
                      >
                        {isUploadingCred ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                      </Button>
                      <input ref={credFileInputRef} type="file" accept=".json,application/json" className="hidden" onChange={handleCredUpload} />
                    </>
                  )}
                </div>
              </div>
              <div className="space-y-2">
                {accountsLoading ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                ) : accounts.length === 0 ? (
                  <div className="text-center py-3 space-y-2">
                    <p className="text-xs text-muted-foreground">No accounts available.</p>
                    {isAdmin && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1.5"
                        onClick={() => credFileInputRef.current?.click()}
                        disabled={isUploadingCred}
                      >
                        {isUploadingCred ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                        Upload credentials JSON
                      </Button>
                    )}
                  </div>
                ) : (
                  accounts.map((acc: any) => (
                    <div key={acc.id} className="flex items-start space-x-2 bg-muted/30 p-2.5 rounded-md border border-transparent hover:border-border transition-colors">
                      {acc.authorized ? (
                        <Checkbox
                          id={`acc-${acc.id}`}
                          checked={selectedAccounts.includes(acc.id)}
                          onCheckedChange={() => toggleAccount(acc.id)}
                          data-testid={`checkbox-account-${acc.id}`}
                          className="mt-0.5"
                        />
                      ) : (
                        <AlertCircle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
                      )}
                      <div className="grid gap-1 leading-none flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <label htmlFor={`acc-${acc.id}`} className="text-sm font-medium cursor-pointer">
                            {acc.label}
                          </label>
                          {acc.authorized ? (
                            <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
                          ) : null}
                        </div>
                        <p className="text-xs text-muted-foreground truncate">{acc.email}</p>
                        {!acc.authorized && (
                          isAdmin ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs mt-1 gap-1.5"
                              onClick={() => handleAuthorize(acc.index)}
                              data-testid={`button-authorize-${acc.id}`}
                            >
                              <KeyRound className="h-3 w-3" />
                              Authorize Access
                            </Button>
                          ) : (
                            <p className="text-xs text-amber-600 mt-1">Not yet authorized – contact admin</p>
                          )
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <Separator />

            {/* Entities */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-muted-foreground" /> Entities
                </h3>
                <div className="flex items-center gap-1">
                  <Badge variant="secondary" className="text-xs">{selectedEntities.length}/{entitiesData.length}</Badge>
                  {isAdmin && (
                    <>
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => fileInputRef.current?.click()} data-testid="button-import-excel">
                        <Upload className="h-3 w-3" />
                      </Button>
                      <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={e => {
                        const file = e.target.files?.[0];
                        if (file) importMut.mutate(file);
                        e.target.value = '';
                      }} />
                    </>
                  )}
                  <Dialog open={addEntityOpen} onOpenChange={setAddEntityOpen}>
                    <DialogTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-6 w-6" data-testid="button-add-entity">
                        <Plus className="h-3 w-3" />
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Add Entity</DialogTitle>
                        <DialogDescription>Add a new entity with email patterns for matching.</DialogDescription>
                      </DialogHeader>
                      <div className="space-y-3">
                        <div>
                          <Label className="text-xs">Entity Name</Label>
                          <Input value={newEntityName} onChange={e => setNewEntityName(e.target.value)} placeholder="e.g. Acme Corp" data-testid="input-entity-name" />
                        </div>
                        <div>
                          <Label className="text-xs">Email Patterns (one per line)</Label>
                          <textarea
                            className="w-full min-h-[80px] text-sm border rounded-md p-2 bg-background resize-y"
                            value={newEntityPatterns}
                            onChange={e => setNewEntityPatterns(e.target.value)}
                            placeholder={"*@acme.com\nbilling@acme.corp"}
                            data-testid="input-entity-patterns"
                          />
                          <p className="text-[10px] text-muted-foreground mt-1">Use *@domain.com for wildcard domain matching</p>
                        </div>
                        <Button onClick={() => createEntityMut.mutate({
                          name: newEntityName,
                          patterns: newEntityPatterns.split('\n').map(s => s.trim()).filter(Boolean),
                        })} disabled={!newEntityName} data-testid="button-save-entity">
                          Save Entity
                        </Button>
                      </div>
                    </DialogContent>
                  </Dialog>
                </div>
              </div>
              {entitiesData.length > 10 && (
                <div className="flex gap-1.5">
                  <Button variant="outline" size="sm" className="h-7 text-xs flex-1" onClick={() => setSelectedEntities(entitiesData.map((e: any) => e.id))}>
                    Select All
                  </Button>
                  <Button variant="outline" size="sm" className="h-7 text-xs flex-1" onClick={() => setSelectedEntities([])}>
                    Deselect All
                  </Button>
                </div>
              )}
              <div className="space-y-1.5 max-h-[300px] overflow-y-auto pr-1">
                {entitiesData.map((ent: any) => (
                  <div key={ent.id} className="flex items-start space-x-2 bg-muted/30 p-2 rounded-md border border-transparent hover:border-border transition-colors group">
                    <Checkbox
                      id={`ent-${ent.id}`}
                      checked={selectedEntities.includes(ent.id)}
                      onCheckedChange={() => toggleEntity(ent.id)}
                      data-testid={`checkbox-entity-${ent.id}`}
                      className="mt-0.5"
                    />
                    <div className="grid gap-0.5 leading-none flex-1 min-w-0">
                      <label htmlFor={`ent-${ent.id}`} className="text-xs font-medium cursor-pointer truncate">{ent.name}</label>
                      <p className="text-[9px] text-muted-foreground truncate">
                        {ent.mappings?.length ? `${ent.mappings.length} pattern${ent.mappings.length > 1 ? 's' : ''}` : "No patterns"}
                      </p>
                    </div>
                    <Button variant="ghost" size="icon" className="h-5 w-5 opacity-0 group-hover:opacity-100 shrink-0" onClick={() => deleteEntityMut.mutate(ent.id)}>
                      <Trash2 className="h-2.5 w-2.5 text-destructive" />
                    </Button>
                  </div>
                ))}
                {entitiesData.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-2">No entities yet — add manually or import Excel</p>
                )}
              </div>
            </div>

            <Separator />

            {/* Query Parameters */}
            <div className="space-y-4">
              <h3 className="text-sm font-medium flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-muted-foreground" /> Query Parameters
              </h3>

              <div className="space-y-2">
                <Label htmlFor="searchTerms" className="text-xs">Search Terms</Label>
                <Input id="searchTerms" value={searchTerms} onChange={e => setSearchTerms(e.target.value)} placeholder="e.g. invoice OR receipt" className="h-8 text-sm" data-testid="input-search-terms" />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-2">
                  <Label htmlFor="daysBack" className="text-xs">Days Back</Label>
                  <div className="relative">
                    <Calendar className="absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
                    <Input id="daysBack" type="number" value={daysBack} onChange={e => setDaysBack(e.target.value)} className="h-8 pl-8 text-sm" data-testid="input-days-back" />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="maxMessages" className="text-xs">Max Msgs</Label>
                  <div className="relative">
                    <FileText className="absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
                    <Input id="maxMessages" type="number" value={maxMessages} onChange={e => setMaxMessages(e.target.value)} className="h-8 pl-8 text-sm" data-testid="input-max-messages" />
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <Label htmlFor="includeInline" className="text-xs">Include Inline Attachments</Label>
                <Switch id="includeInline" checked={includeInline} onCheckedChange={setIncludeInline} data-testid="switch-include-inline" />
              </div>
            </div>
          </div>
        </ScrollArea>

        <div className="p-4 border-t bg-card/50 backdrop-blur-sm space-y-2">
          <Button variant="outline" className="w-full" size="sm" onClick={handlePreview} disabled={selectedEntities.length === 0} data-testid="button-preview-query">
            <Eye className="h-4 w-4 mr-2" /> Preview Query
          </Button>
          <Button className="w-full shadow-sm" size="lg" onClick={handleSearch} disabled={isSearching || selectedAccounts.length === 0 || selectedEntities.length === 0} data-testid="button-run-search">
            {isSearching ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Searching...</> : "Run Search"}
          </Button>
        </div>
      </div>

      {/* MAIN CONTENT */}
      <div className="flex-1 flex flex-col bg-muted/10 min-h-0">
        <header className="shrink-0 border-b bg-card shadow-sm z-10">
          {/* Top bar — always visible, fixed height */}
          <div className="flex items-center justify-between px-6 py-3 gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <h1 className="text-lg font-semibold shrink-0">Search Results</h1>
              <p className="text-sm text-muted-foreground truncate">
                {searchResults
                  ? `Found ${searchResults.length} messages — ${selectedMsgCount} selected (PDF + JSON per email${selectedAttCount > 0 ? `, ${selectedAttCount} attachments` : ''})`
                  : "Configure your search on the left and hit run"}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {previewQuery && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs gap-1 text-muted-foreground"
                  onClick={() => setQueryExpanded(v => !v)}
                >
                  <ChevronDown className={`h-3 w-3 transition-transform ${queryExpanded ? 'rotate-180' : ''}`} />
                  {queryExpanded ? 'Hide query' : 'Show query'}
                </Button>
              )}
              {searchResults && searchResults.length > 0 && (
                <Button
                  disabled={selectedMsgCount === 0 || isBundling}
                  className="gap-2"
                  onClick={handleBundleDownload}
                  data-testid="button-save-bundle"
                >
                  {isBundling ? (
                    <><Loader2 className="h-4 w-4 animate-spin" /> Bundling...</>
                  ) : (
                    <><Archive className="h-4 w-4" /> Save as ZIP</>
                  )}
                </Button>
              )}
            </div>
          </div>
          {/* Collapsible resizable query box */}
          {previewQuery && queryExpanded && (
            <div className="px-6 pb-3">
              <textarea
                readOnly
                value={previewQuery}
                className="w-full text-xs font-mono bg-muted/50 rounded-md px-3 py-2 text-foreground/70 resize-y min-h-[48px] max-h-[300px] h-[80px] border border-border/50 outline-none"
              />
            </div>
          )}
        </header>

        <ScrollArea className="flex-1 min-h-0 p-6">
          <div className="max-w-4xl mx-auto space-y-4">

            {!searchResults ? (
              <div className="h-[60vh] flex flex-col items-center justify-center text-center space-y-4 animate-in fade-in zoom-in duration-500">
                <div className="h-20 w-20 rounded-full bg-primary/10 flex items-center justify-center">
                  <Search className="h-10 w-10 text-primary/50" />
                </div>
                <div>
                  <h2 className="text-xl font-medium">Ready to search</h2>
                  <p className="text-muted-foreground max-w-sm mt-1">
                    {authorizedAccounts.length === 0
                      ? "Authorize your Gmail accounts first, then select entities and run a search."
                      : "Select your accounts and entities, set your parameters, then hit run."}
                  </p>
                </div>
              </div>
            ) : searchResults.length === 0 ? (
              <div className="h-[60vh] flex flex-col items-center justify-center text-center space-y-4">
                <div className="h-20 w-20 rounded-full bg-muted flex items-center justify-center">
                  <Mail className="h-10 w-10 text-muted-foreground/50" />
                </div>
                <div>
                  <h2 className="text-xl font-medium">No results</h2>
                  <p className="text-muted-foreground max-w-sm mt-1">Try broadening your search terms or increasing the date range.</p>
                </div>
              </div>
            ) : (
              <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div className="flex items-center justify-between bg-card p-3 rounded-lg border shadow-sm">
                  <div className="flex items-center gap-2">
                    <CheckSquare className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">
                      {selectedMsgCount} of {searchResults.length} messages selected{selectedAttCount > 0 ? ` (${selectedAttCount} attachments)` : ''}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="h-8 text-xs" onClick={selectAll} data-testid="button-select-all">
                      Select All
                    </Button>
                    <Button variant="outline" size="sm" className="h-8 text-xs" onClick={deselectAll} data-testid="button-deselect-all">
                      Deselect All
                    </Button>
                  </div>
                </div>

                {searchResults.map((result: any) => {
                  const sel = getSelection(result.id);
                  const allAttIds = result.attachments.map((a: any) => a.id);
                  const isFullySelected = sel.selected && sel.attachmentIds.length === allAttIds.length;
                  const isPartiallySelected = sel.selected || sel.attachmentIds.length > 0;
                  const isExpanded = expandedMessages[result.id];
                  const account = accounts.find((a: any) => a.index === result.accountIndex);

                  return (
                    <Card key={`${result.accountIndex}-${result.id}`} className={`overflow-hidden transition-all duration-200 border ${isPartiallySelected ? 'border-primary/50 shadow-md ring-1 ring-primary/10' : 'border-border'}`}>
                      <div className={`p-4 flex items-start gap-4 ${isPartiallySelected ? 'bg-primary/[0.02]' : 'bg-card'}`}>
                        <div className="pt-1">
                          <Checkbox
                            checked={isFullySelected ? true : isPartiallySelected ? "indeterminate" : false}
                            onCheckedChange={() => toggleMessageAll(result)}
                            data-testid={`checkbox-result-${result.id}`}
                          />
                        </div>

                        <div className="flex-1 min-w-0 cursor-pointer" onClick={() => toggleExpand(result.id)}>
                          <div className="flex items-center justify-between gap-4 mb-1">
                            <h3 className="font-semibold text-base truncate pr-4">{result.subject || "(no subject)"}</h3>
                            <span className="text-xs text-muted-foreground whitespace-nowrap">
                              {result.date ? new Date(result.date).toLocaleDateString() : ""}
                            </span>
                          </div>

                          <div className="flex items-center gap-2 mb-2 flex-wrap">
                            {account && (
                              <Badge variant="outline" className="text-[10px] h-5 bg-background">
                                {account.label}
                              </Badge>
                            )}
                            <Badge variant="outline" className="text-[10px] h-5 bg-background truncate max-w-[180px]">
                              {result.from}
                            </Badge>
                            {result.matchedEntityName && (
                              <Badge variant="secondary" className="text-[10px] h-5 bg-blue-50 text-blue-700 hover:bg-blue-100 border-blue-200">
                                {result.matchedEntityName}
                              </Badge>
                            )}
                            <Badge variant="outline" className="text-[10px] h-5">
                              <Paperclip className="h-2.5 w-2.5 mr-0.5" /> {result.attachments.length}
                            </Badge>
                          </div>

                          <p className="text-sm text-muted-foreground line-clamp-1">{result.snippet}</p>
                        </div>

                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground mt-1" onClick={() => toggleExpand(result.id)}>
                          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </Button>
                      </div>

                      {isExpanded && (
                        <div className="bg-muted/30 border-t p-4 pl-12 space-y-4">

                          {/* SAVE FORMAT INFO */}
                          {sel.selected && (
                            <div className="flex items-center gap-2 p-2.5 rounded-md bg-green-50/50 border border-green-200 text-xs">
                              <FileBarChart className="h-3.5 w-3.5 text-green-600 shrink-0" />
                              <span className="text-green-800">
                                Saves as combined PDF (metadata + body + attachment previews) and JSON record
                              </span>
                            </div>
                          )}

                          {/* EMAIL DETAILS */}
                          <div className="p-3 rounded-md border bg-card">
                            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                              <div><span className="text-muted-foreground font-medium">From:</span> <span className="truncate">{result.from}</span></div>
                              <div><span className="text-muted-foreground font-medium">Date:</span> {result.date ? new Date(result.date).toLocaleDateString() : ''}</div>
                              {result.to && <div className="col-span-2"><span className="text-muted-foreground font-medium">To:</span> <span className="truncate">{result.to}</span></div>}
                              {result.cc && <div className="col-span-2"><span className="text-muted-foreground font-medium">CC:</span> <span className="truncate">{result.cc}</span></div>}
                            </div>
                            {(result.bodyText || result.snippet) && (
                              <div className="mt-2 text-xs text-muted-foreground bg-muted/50 p-2 rounded max-h-20 overflow-hidden">
                                {(result.bodyText || result.snippet || '').substring(0, 200)}
                                {(result.bodyText || result.snippet || '').length > 200 ? '...' : ''}
                              </div>
                            )}
                          </div>

                          {/* ATTACHMENTS */}
                          {result.attachments.length > 0 && (
                            <div>
                              <h4 className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wider flex items-center gap-1.5">
                                <Paperclip className="h-3.5 w-3.5" /> Attachments ({result.attachments.length})
                              </h4>

                              <div className="grid gap-2 sm:grid-cols-2">
                                {result.attachments.map((att: any) => {
                                  const isAttSelected = sel.attachmentIds.includes(att.id);
                                  const cleanName = getCleanAttachmentName(att.filename, result.subject);
                                  const smartName = generateSmartFilename(result.date, result.matchedEntityName, att.filename, result.subject);
                                  const isImage = /^image\/(png|jpe?g|gif|bmp|webp)$/i.test(att.mimeType || '');
                                  const isPdf = /^application\/pdf$/i.test(att.mimeType || '');
                                  const hasPreview = isImage || isPdf;

                                  return (
                                    <div key={att.id} className={`flex items-start gap-3 p-3 rounded-md border transition-colors ${isAttSelected ? 'bg-primary/5 border-primary/30' : 'bg-card border-border hover:border-muted-foreground/30'}`}>
                                      <Checkbox className="mt-1" checked={isAttSelected} onCheckedChange={() => toggleAttachment(result.id, att.id)} data-testid={`checkbox-attachment-${att.id}`} />
                                      <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-1.5">
                                          {att.isInline ? <ImageIcon className="h-3.5 w-3.5 text-orange-500" /> : <FileText className="h-3.5 w-3.5 text-blue-500" />}
                                          <p className="text-sm font-medium truncate" title={att.filename}>{cleanName}</p>
                                        </div>

                                        <div className="mt-1.5 flex items-center gap-2">
                                          <Badge variant="outline" className="text-[9px] px-1.5 h-4 text-muted-foreground">{formatBytes(att.size)}</Badge>
                                          {hasPreview && <Badge variant="outline" className="text-[9px] px-1.5 h-4 bg-green-50 text-green-700 border-green-200">Preview in PDF</Badge>}
                                          {cleanName !== att.filename && <Badge variant="outline" className="text-[9px] px-1.5 h-4 bg-amber-50 text-amber-700 border-amber-200">Renamed</Badge>}
                                        </div>
                                      </div>

                                      <a href={api.downloadAttachment(att.accountIndex, att.messageId, att.id, smartName)} download={smartName} className="mt-1">
                                        <Button variant="ghost" size="icon" className="h-7 w-7">
                                          <Download className="h-3.5 w-3.5" />
                                        </Button>
                                      </a>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      <Dialog open={authDialogOpen} onOpenChange={setAuthDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Authorize Account {authAccountIndex}</DialogTitle>
            <DialogDescription>
              A Google sign-in page should have opened in a new tab. Sign in with the Gmail account you want to connect.
              After granting access, the page will redirect to a URL that may not load — that's normal.
              Copy the <strong>code</strong> parameter from the URL bar and paste it below.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="bg-muted/50 rounded-md p-3 text-xs text-muted-foreground space-y-1.5">
              <p className="font-medium text-foreground">How to complete authorization:</p>
              <p>After signing in and granting access, the page will redirect to a URL starting with <code>http://localhost/...</code> that won't load — that's normal.</p>
              <p className="font-medium text-foreground mt-1">Just copy the entire URL from the address bar and paste it below.</p>
            </div>
            <div>
              <Label className="text-xs">Paste the full URL from the address bar</Label>
              <Input
                value={authCode}
                onChange={e => setAuthCode(e.target.value)}
                placeholder="http://localhost/?state=1&code=4/0A..."
                data-testid="input-auth-code"
                className="font-mono text-sm"
              />
            </div>
            <Button
              onClick={handleExchangeCode}
              disabled={!authCode.trim() || isExchanging}
              className="w-full"
              data-testid="button-submit-auth-code"
            >
              {isExchanging ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Authorizing...</> : "Complete Authorization"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
