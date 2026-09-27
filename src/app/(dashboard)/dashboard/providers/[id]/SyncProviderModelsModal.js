"use client";

import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { Button, Modal } from "@/shared/components";

function normalizeModel(item) {
  if (!item) return null;
  if (typeof item === "string") return { id: item, name: item };
  const id = item.id || item.modelId || item.model || item.name;
  if (!id) return null;
  return {
    id,
    name: item.name || item.modelName || item.displayName || id,
    description: item.description || "",
    maxInputTokens: item.max_context_window || item.context_window || item.maxInputTokens || item.contextLength || item.contextWindow || item.context_length || item.top_provider?.context_length || 0,
  };
}

function defaultAlias(modelId, passthroughModels) {
  return passthroughModels ? modelId.split("/").pop() : modelId;
}

function ContextBadge({ tokens }) {
  if (!tokens || tokens <= 0) return null;
  const k = Math.round(tokens / 1000);
  const isLarge = k >= 1000;
  const isMedium = k >= 200;

  let colorClasses = "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20";
  if (isLarge) {
    colorClasses = "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30 font-semibold shadow-sm";
  } else if (isMedium) {
    colorClasses = "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20";
  }

  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-mono leading-none ${colorClasses}`}>
      <span className="material-symbols-outlined text-[10px]">data_array</span>
      {isLarge ? `${(k / 1000).toFixed(1).replace(/\.0$/, "")}M` : `${k}k`} ctx
    </span>
  );
}

ContextBadge.propTypes = {
  tokens: PropTypes.number,
};

export default function SyncProviderModelsModal({
  isOpen,
  connections,
  existingModelIds,
  providerDisplayAlias,
  passthroughModels,
  onAddModels,
  onClose,
  providerId = "",
}) {
  const activeConnections = useMemo(
    () => connections.filter((conn) => conn.isActive !== false),
    [connections]
  );
  const [connectionId, setConnectionId] = useState("");
  const [models, setModels] = useState([]);
  const [selected, setSelected] = useState({});
  const [query, setQuery] = useState("");
  const [filterTab, setFilterTab] = useState("all");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    const initialId = activeConnections[0]?.id || (activeConnections.length === 0 ? providerId : "");
    setConnectionId(initialId);
    setModels([]);
    setSelected({});
    setQuery("");
    setFilterTab("all");
    setError("");
    setWarning("");
  }, [activeConnections, isOpen, providerId]);

  const fetchModels = async (id = connectionId) => {
    const targetId = id || (activeConnections.length === 0 ? providerId : "");
    if (!targetId || loading) return;
    setLoading(true);
    setError("");
    setWarning("");
    try {
      const res = await fetch(`/api/providers/${targetId}/models`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
        return;
      }
      const nextModels = (data.models || []).map(normalizeModel).filter(Boolean);
      setModels(nextModels);
      setSelected({});
      setWarning(data.warning || "");
      if (nextModels.length === 0 && !data.warning) setWarning("Upstream returned an empty model list.");
    } catch (err) {
      setError(err.message || "Failed to sync models");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const target = connectionId || (activeConnections.length === 0 ? providerId : "");
    if (isOpen && target) {
      fetchModels(target);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, connectionId, activeConnections.length, providerId]);

  const existingSet = useMemo(() => new Set(existingModelIds), [existingModelIds]);

  const availableCount = useMemo(
    () => models.filter((m) => !existingSet.has(m.id)).length,
    [models, existingSet]
  );
  const addedCount = useMemo(
    () => models.filter((m) => existingSet.has(m.id)).length,
    [models, existingSet]
  );

  const filteredModels = useMemo(() => {
    const term = query.trim().toLowerCase();
    return models.filter((model) => {
      const isAdded = existingSet.has(model.id);
      if (filterTab === "available" && isAdded) return false;
      if (filterTab === "added" && !isAdded) return false;

      if (!term) return true;
      return [model.id, model.name, model.description].some((value) =>
        String(value || "").toLowerCase().includes(term)
      );
    });
  }, [models, query, filterTab, existingSet]);

  const selectedModels = useMemo(
    () => models.filter((model) => selected[model.id] && !existingSet.has(model.id)),
    [existingSet, models, selected]
  );

  const toggleModel = (modelId) => {
    if (existingSet.has(modelId)) return;
    setSelected((prev) => ({ ...prev, [modelId]: !prev[modelId] }));
  };

  const selectAllVisible = () => {
    const next = { ...selected };
    filteredModels.forEach((model) => {
      if (!existingSet.has(model.id)) next[model.id] = true;
    });
    setSelected(next);
  };

  const clearSelection = () => setSelected({});

  const handleAdd = async () => {
    if (selectedModels.length === 0 || saving) return;
    setSaving(true);
    setError("");
    try {
      await onAddModels(selectedModels.map((model) => ({
        id: model.id,
        alias: defaultAlias(model.id, passthroughModels),
        ...(model.maxInputTokens ? { contextLength: model.maxInputTokens } : {}),
      })));
      onClose();
    } catch (err) {
      setError(err.message || "Failed to add selected models");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Sync Upstream Models" size="full">
      <div className="flex max-h-[75vh] flex-col gap-4">
        {/* Header / Connection Selector & Summary */}
        <div className="rounded-xl border border-border/60 bg-sidebar/50 p-3.5 backdrop-blur-sm">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
                <span className="material-symbols-outlined text-[15px] text-primary">hub</span>
                Select Connection to Fetch Live Models
              </label>
              <div className="relative">
                <select
                  value={connectionId}
                  onChange={(event) => setConnectionId(event.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-text-main shadow-sm transition-colors hover:border-primary/50 focus:border-primary focus:outline-none"
                >
                  {activeConnections.map((conn) => (
                    <option key={conn.id} value={conn.id}>
                      {conn.name || conn.email || conn.id} ({conn.provider})
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                icon="sync"
                loading={loading}
                onClick={() => fetchModels()}
                disabled={!connectionId || loading}
                className="w-full sm:w-auto shadow-sm"
              >
                {loading ? "Syncing Catalog..." : "Refresh Catalog"}
              </Button>
            </div>
          </div>
        </div>

        {/* Search Bar & Filter Tabs */}
        <div className="flex flex-col gap-2.5">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
            <div className="relative flex items-center">
              <span className="material-symbols-outlined absolute left-3 text-[18px] text-text-muted">search</span>
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search model ID, display name..."
                className="w-full rounded-lg border border-border bg-background pl-9 pr-8 py-2 text-sm text-text-main transition-colors focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
              />
              {query && (
                <button
                  onClick={() => setQuery("")}
                  className="absolute right-2.5 rounded-full p-0.5 text-text-muted hover:bg-sidebar hover:text-text-main"
                >
                  <span className="material-symbols-outlined text-[16px]">cancel</span>
                </button>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                icon="done_all"
                onClick={selectAllVisible}
                disabled={filteredModels.filter((m) => !existingSet.has(m.id)).length === 0}
                className="text-xs"
              >
                Select Visible ({filteredModels.filter((m) => !existingSet.has(m.id)).length})
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon="close"
                onClick={clearSelection}
                disabled={selectedModels.length === 0}
                className="text-xs text-text-muted"
              >
                Clear
              </Button>
            </div>
          </div>

          {/* Quick Filter Tabs */}
          <div className="flex items-center justify-between border-b border-border/50 pb-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setFilterTab("all")}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-all ${
                  filterTab === "all"
                    ? "bg-primary/10 text-primary"
                    : "text-text-muted hover:bg-sidebar hover:text-text-main"
                }`}
              >
                All ({models.length})
              </button>
              <button
                type="button"
                onClick={() => setFilterTab("available")}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-all ${
                  filterTab === "available"
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "text-text-muted hover:bg-sidebar hover:text-text-main"
                }`}
              >
                Available to add ({availableCount})
              </button>
              <button
                type="button"
                onClick={() => setFilterTab("added")}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-all ${
                  filterTab === "added"
                    ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                    : "text-text-muted hover:bg-sidebar hover:text-text-main"
                }`}
              >
                Already added ({addedCount})
              </button>
            </div>
            {selectedModels.length > 0 && (
              <span className="animate-pulse text-xs font-medium text-primary">
                {selectedModels.length} selected
              </span>
            )}
          </div>
        </div>

        {/* Alerts */}
        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-400 shadow-sm">
            <span className="material-symbols-outlined text-[18px] shrink-0 mt-0.5">error</span>
            <span className="break-words font-mono">{error}</span>
          </div>
        )}
        {warning && !error && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300 shadow-sm">
            <span className="material-symbols-outlined text-[18px] shrink-0 mt-0.5">warning</span>
            <span className="break-words">{warning}</span>
          </div>
        )}

        {/* Models Scrollable List */}
        <div className="min-h-[240px] flex-1 overflow-y-auto rounded-xl border border-border/80 bg-background shadow-inner">
          {loading ? (
            <div className="flex h-60 flex-col items-center justify-center gap-3 text-sm text-text-muted">
              <div className="relative flex h-10 w-10 items-center justify-center">
                <span className="material-symbols-outlined animate-spin text-[32px] text-primary">progress_activity</span>
              </div>
              <p className="font-medium text-text-main">Fetching upstream models catalog...</p>
              <p className="text-xs text-text-muted">Communicating with provider API & verifying credentials</p>
            </div>
          ) : filteredModels.length === 0 ? (
            <div className="flex h-60 flex-col items-center justify-center gap-2 text-sm text-text-muted">
              <span className="material-symbols-outlined text-[36px] text-text-muted/40">search_off</span>
              <p className="font-medium text-text-main">No models match your query</p>
              <p className="text-xs text-text-muted">Try adjusting your search terms or filter tab</p>
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {filteredModels.map((model) => {
                const exists = existingSet.has(model.id);
                const checked = !!selected[model.id] && !exists;
                return (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => toggleModel(model.id)}
                    disabled={exists}
                    className={`group grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-3 text-left transition-all ${
                      exists
                        ? "cursor-not-allowed bg-sidebar/40 opacity-60"
                        : checked
                        ? "bg-primary/5 hover:bg-primary/10"
                        : "hover:bg-sidebar/80"
                    }`}
                  >
                    {/* Checkbox indicator */}
                    <div
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-all ${
                        exists
                          ? "border-border bg-sidebar text-text-muted"
                          : checked
                          ? "border-primary bg-primary text-white shadow-sm scale-105"
                          : "border-border/80 group-hover:border-primary/50 text-transparent"
                      }`}
                    >
                      <span className="material-symbols-outlined text-[15px] font-bold">check</span>
                    </div>

                    {/* Model Details */}
                    <div className="min-w-0 flex flex-col gap-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="truncate text-sm font-semibold font-mono text-text-main group-hover:text-primary transition-colors">
                          {model.id}
                        </span>
                        <ContextBadge tokens={model.maxInputTokens} />
                      </div>
                      {model.name && model.name !== model.id && (
                        <span className="truncate text-xs text-text-muted">
                          {model.name}
                        </span>
                      )}
                      {model.description && (
                        <span className="line-clamp-1 text-[11px] text-text-muted/70">
                          {model.description}
                        </span>
                      )}
                    </div>

                    {/* Alias Tag / Status Badge */}
                    <div className="shrink-0">
                      {exists ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-sidebar border border-border/80 px-2 py-0.5 text-[11px] font-medium text-text-muted">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
                          Added
                        </span>
                      ) : (
                        <span className="rounded-md border border-border/70 bg-sidebar/70 px-2 py-1 font-mono text-[11px] text-text-muted group-hover:border-primary/40 group-hover:text-primary transition-colors">
                          {providerDisplayAlias}/{model.id}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex flex-col-reverse gap-3 border-t border-border/60 pt-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <span className="font-medium text-text-main">{models.length}</span> total upstream ·{" "}
            <span className="font-semibold text-primary">{selectedModels.length}</span> selected ·{" "}
            <span className="font-medium text-emerald-600 dark:text-emerald-400">{availableCount}</span> available
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              size="sm"
              icon="add"
              onClick={handleAdd}
              loading={saving}
              disabled={selectedModels.length === 0 || saving}
              className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-md transition-all disabled:opacity-50"
            >
              {saving ? "Adding..." : `Add ${selectedModels.length > 0 ? selectedModels.length : ""} Selected`}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

SyncProviderModelsModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  connections: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string,
      name: PropTypes.string,
      email: PropTypes.string,
      isActive: PropTypes.bool,
    })
  ).isRequired,
  existingModelIds: PropTypes.arrayOf(PropTypes.string).isRequired,
  providerDisplayAlias: PropTypes.string.isRequired,
  passthroughModels: PropTypes.bool,
  onAddModels: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
  providerId: PropTypes.string,
};
