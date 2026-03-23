# Error Handling Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a structurally-enforced, four-layer error handling architecture so that errors are always caught, classified, and surfaced to the user — regardless of whether the AI coder remembers error handling conventions.

**Architecture:** Four defense layers (safe utility functions → middleware/wrappers → regional ErrorBoundary → global fallback), unified through an ErrorBus that routes errors to toast, status bar, or boundary fallback based on severity. All infrastructure lives in `shared/` as pure ESM JS, with TypeScript type declarations in the renderer.

**Tech Stack:** ESM JavaScript (shared/server/core), CommonJS (main process), TypeScript + React + Zustand (renderer), Fastify (server), Electron IPC

**Spec:** `docs/superpowers/specs/2026-03-24-error-handling-overhaul-design.md`

---

## File Map

### New Files

| File | Responsibility |
|------|---------------|
| `shared/errors.js` | `AppError` class + `ERROR_DEFS` registry + severity/category constants |
| `shared/error-bus.js` | `ErrorBus` class: breadcrumbs, dedup, severity-based routing, structured logging |
| `shared/retry.js` | `withRetry()` with decorrelated jitter + abort support |
| `shared/safe-fs.js` | `safeReadJSON`, `safeReadYAML`, `safeReadFile`, `safeCopyDir` (**server/core only**, imports Node `fs`) |
| `shared/safe-parse.js` | `safeParseJSON`, `safeParseResponse` (no Node APIs, usable in renderer too) |
| `server/middleware/error-handler.js` | Fastify `setErrorHandler` global middleware |
| `desktop/ipc-wrapper.cjs` | `wrapIpcHandler` non-breaking safety net for main process (CJS) |
| `desktop/src/react/errors/types.ts` | TypeScript type re-exports for renderer |
| `desktop/src/react/errors/error-bus-bridge.ts` | Connects ErrorBus to Zustand stores (toast, connection) |
| `desktop/src/react/components/RegionalErrorBoundary.tsx` | Region-scoped ErrorBoundary with `resetKeys` |
| `desktop/src/react/components/RegionalErrorBoundary.module.css` | Fallback UI styles |
| `desktop/src/react/components/StatusBar.tsx` | WebSocket connection status indicator |
| `desktop/src/react/components/StatusBar.module.css` | Status bar styles |

### Modified Files

| File | Changes |
|------|---------|
| `desktop/src/react/stores/toast-slice.ts` | Add `warning` type, `persistent`, `action`, `dedupeKey` fields |
| `desktop/src/react/stores/connection-slice.ts` | Add `wsState`, `wsReconnectAttempt` |
| `desktop/src/react/components/ToastContainer.tsx` | Action button, persistent mode, dedup |
| `desktop/src/react/services/websocket.ts` | ErrorBus integration, reconnect cap, `wsState` |
| `desktop/src/react/utils/ui-helpers.ts` | `showError` uses ErrorBus, remove emoji prefix |
| `desktop/src/react/settings/Toast.tsx` | Rewrite to use same toast-slice pattern as main window |
| `desktop/src/react/App.tsx` | Regional ErrorBoundaries, global handlers → ErrorBus, StatusBar |
| `desktop/src/react/components/ErrorBoundary.tsx` | Keep as root fallback, delegate to RegionalErrorBoundary |
| `server/index.js` | Register error-handler middleware |
| `core/llm-client.js` | Slow response detection, `withRetry` wrapper, AppError |
| `core/first-run.js` | Replace `copyDirSync` with `safeCopyDir`, safe file ops |
| `core/provider-registry.js` | `safeReadYAML` |
| `core/bridge-session-manager.js` | `safeReadJSON` |
| `core/sync-favorites.js` | `safeReadYAML` |
| `core/agent.js` | `safeReadFile` |
| `core/agent-manager.js` | `safeReadJSON` / `safeReadYAML` |
| `lib/tools/web-search.js` | `safeParseResponse` |
| `server/cli.js` | Safe JSON parse for WS messages |
| `server/routes/fs.js` | `safeReadFile` |
| `server/routes/skills.js` | `safeCopyDir` |
| `server/routes/chat.js` | `wrapWsHandler` |
| `lib/memory/compile.js` | `safeReadFile` |
| `lib/bridge/bridge-manager.js` | ErrorBus report |
| `desktop/main.cjs` | `wrapIpcHandler`, `safeReadJSON`, global handlers → ErrorBus |
| `desktop/src/locales/en.json` | New error i18n keys |
| `desktop/src/locales/zh.json` | New error i18n keys (Chinese) |

---

## Phase 1: Foundation Infrastructure

### Task 1: AppError class + ERROR_DEFS

**Files:**
- Create: `shared/errors.js`
- Create: `desktop/src/react/errors/types.ts`

- [ ] **Step 1: Create `shared/errors.js`**

Write the complete AppError class and ERROR_DEFS registry. This is pure ESM JavaScript (no TypeScript, no Node-specific APIs). The file exports:
- `ErrorSeverity` object (frozen): `{ CRITICAL: 'critical', DEGRADED: 'degraded', COSMETIC: 'cosmetic' }`
- `ErrorCategory` object (frozen): `{ NETWORK: 'network', LLM: 'llm', FILESYSTEM: 'filesystem', IPC: 'ipc', RENDER: 'render', BRIDGE: 'bridge', CONFIG: 'config', AUTH: 'auth', UNKNOWN: 'unknown' }`
- `ERROR_DEFS` — the full registry from the spec (all 19 codes)
- `AppError` class extending `Error`:
  - Constructor takes `(code, opts?)` where opts = `{ cause, context, message, traceId }`
  - Looks up `ERROR_DEFS[code]` (falls back to `UNKNOWN`)
  - Auto-generates 8-char hex `traceId` if not provided: `Math.random().toString(16).slice(2, 10)`
  - Instance properties: `code`, `severity`, `category`, `retryable`, `userMessageKey`, `httpStatus`, `context`, `traceId`, `cause`
  - `toJSON()` returns `{ code, message, context, traceId }`
  - Static `fromJSON(data)` creates AppError from serialized data, preserving `traceId`
  - Static `wrap(err, fallbackCode = 'UNKNOWN')`: if already AppError return as-is; otherwise wrap raw Error

```javascript
// shared/errors.js
export const ErrorSeverity = Object.freeze({
  CRITICAL: 'critical',
  DEGRADED: 'degraded',
  COSMETIC: 'cosmetic',
});

export const ErrorCategory = Object.freeze({
  NETWORK: 'network', LLM: 'llm', FILESYSTEM: 'filesystem',
  IPC: 'ipc', RENDER: 'render', BRIDGE: 'bridge',
  CONFIG: 'config', AUTH: 'auth', UNKNOWN: 'unknown',
});

export const ERROR_DEFS = Object.freeze({
  LLM_TIMEOUT:         { severity: 'degraded', category: 'llm',        i18nKey: 'error.llmTimeout',        retryable: true,  httpStatus: 504 },
  LLM_RATE_LIMITED:    { severity: 'degraded', category: 'llm',        i18nKey: 'error.llmRateLimited',    retryable: true,  httpStatus: 429 },
  LLM_EMPTY_RESPONSE:  { severity: 'degraded', category: 'llm',        i18nKey: 'error.llmEmptyResponse',  retryable: true,  httpStatus: 502 },
  LLM_AUTH_FAILED:     { severity: 'degraded', category: 'llm',        i18nKey: 'error.llmAuthFailed',     retryable: false, httpStatus: 401 },
  LLM_SLOW_RESPONSE:   { severity: 'cosmetic', category: 'llm',        i18nKey: 'error.llmSlowResponse',   retryable: false },
  FS_PERMISSION:       { severity: 'critical', category: 'filesystem', i18nKey: 'error.fsPermission',      retryable: false, httpStatus: 500 },
  FS_NOT_FOUND:        { severity: 'degraded', category: 'filesystem', i18nKey: 'error.fsNotFound',        retryable: false, httpStatus: 404 },
  FS_COPY_FAILED:      { severity: 'critical', category: 'filesystem', i18nKey: 'error.fsCopyFailed',      retryable: true,  httpStatus: 500 },
  WS_DISCONNECTED:     { severity: 'degraded', category: 'network',    i18nKey: 'error.wsDisconnected',    retryable: true },
  FETCH_TIMEOUT:       { severity: 'degraded', category: 'network',    i18nKey: 'error.fetchTimeout',      retryable: true,  httpStatus: 504 },
  FETCH_SERVER_ERROR:  { severity: 'degraded', category: 'network',    i18nKey: 'error.fetchServerError',  retryable: true,  httpStatus: 502 },
  IPC_FAILED:          { severity: 'degraded', category: 'ipc',        i18nKey: 'error.ipcFailed',         retryable: false },
  RENDER_CRASH:        { severity: 'critical', category: 'render',     i18nKey: 'error.renderCrash',       retryable: false },
  CONFIG_PARSE:        { severity: 'critical', category: 'config',     i18nKey: 'error.configParse',       retryable: false, httpStatus: 500 },
  BRIDGE_SEND_FAILED:  { severity: 'degraded', category: 'bridge',     i18nKey: 'error.bridgeSendFailed',  retryable: true,  httpStatus: 502 },
  SKILL_SYNC_FAILED:   { severity: 'degraded', category: 'filesystem', i18nKey: 'error.skillSyncFailed',   retryable: true,  httpStatus: 500 },
  MEMORY_COMPILE_FAILED: { severity: 'degraded', category: 'unknown',  i18nKey: 'error.memoryCompileFailed', retryable: true },
  DB_ERROR:            { severity: 'critical', category: 'filesystem', i18nKey: 'error.dbError',           retryable: false, httpStatus: 500 },
  SERVER_AUTH_FAILED:  { severity: 'degraded', category: 'auth',       i18nKey: 'error.serverAuthFailed',  retryable: false, httpStatus: 403 },
  UNKNOWN:             { severity: 'degraded', category: 'unknown',    i18nKey: 'error.unknown',           retryable: false, httpStatus: 500 },
});

export class AppError extends Error {
  constructor(code, opts = {}) {
    const def = ERROR_DEFS[code] || ERROR_DEFS.UNKNOWN;
    super(opts.message || code);
    this.name = 'AppError';
    this.code = code;
    this.severity = def.severity;
    this.category = def.category;
    this.retryable = def.retryable;
    this.userMessageKey = def.i18nKey;
    this.httpStatus = def.httpStatus || 500;
    this.context = opts.context || {};
    this.traceId = opts.traceId || Math.random().toString(16).slice(2, 10);
    if (opts.cause) this.cause = opts.cause;
  }

  toJSON() {
    return { code: this.code, message: this.message, context: this.context, traceId: this.traceId };
  }

  static fromJSON(data) {
    return new AppError(data.code || 'UNKNOWN', {
      message: data.message,
      context: data.context,
      traceId: data.traceId,
    });
  }

  static wrap(err, fallbackCode = 'UNKNOWN') {
    if (err instanceof AppError) return err;
    const raw = err instanceof Error ? err : new Error(String(err));
    return new AppError(fallbackCode, { cause: raw, message: raw.message });
  }
}
```

- [ ] **Step 2: Create `desktop/src/react/errors/types.ts`**

TypeScript type declarations that mirror `shared/errors.js` for type-safe usage in the renderer:

```typescript
// desktop/src/react/errors/types.ts
export type ErrorSeverity = 'critical' | 'degraded' | 'cosmetic';
export type ErrorCategory = 'network' | 'llm' | 'filesystem' | 'ipc' | 'render' | 'bridge' | 'config' | 'auth' | 'unknown';
export type ErrorRoute = 'toast' | 'statusbar' | 'boundary' | 'silent';

export interface ErrorDef {
  severity: ErrorSeverity;
  category: ErrorCategory;
  i18nKey: string;
  retryable: boolean;
  httpStatus?: number;
}

export interface Breadcrumb {
  type: 'action' | 'navigation' | 'network' | 'ipc' | 'llm' | 'filesystem' | 'lifecycle';
  message: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

export interface ErrorEntry {
  error: AppError;
  timestamp: number;
  breadcrumbs: Breadcrumb[];
}

// Re-export the runtime class type (imported at runtime from shared/errors.js via Vite)
export type { AppError } from '../../../shared/errors.js';
```

- [ ] **Step 3: Verify Node imports work**

Run: `node -e "import { AppError, ERROR_DEFS } from './shared/errors.js'; const e = new AppError('LLM_TIMEOUT'); console.log(e.code, e.severity, e.traceId, JSON.stringify(e.toJSON())); const w = AppError.wrap(new Error('test')); console.log(w.code, w.cause.message);"`
Expected: `LLM_TIMEOUT degraded <8-char-hex> {"code":"LLM_TIMEOUT",...}` and `UNKNOWN test`

- [ ] **Step 4: Verify Vite can resolve `shared/` imports from renderer**

Run: `npx tsc --noEmit`
Expected: No new type errors from `desktop/src/react/errors/types.ts`

Also verify Vite resolves the path: `npm run build:renderer`
Expected: Build succeeds. If Vite blocks access to `shared/` (outside `root`), add to `vite.config.ts`:
```typescript
server: { fs: { allow: ['..'] } }
```
This must pass before building anything on top of `shared/` imports in the renderer.

- [ ] **Step 4: Commit**

```bash
git add shared/errors.js desktop/src/react/errors/types.ts
git commit -m "feat(errors): AppError class + ERROR_DEFS registry + renderer type declarations"
```

---

### Task 2: ErrorBus

**Files:**
- Create: `shared/error-bus.js`

- [ ] **Step 1: Create `shared/error-bus.js`**

The ErrorBus manages breadcrumbs (ring buffer of 50), deduplication (by code, 5s window), severity-based routing, and structured logging. It imports `AppError` from `./errors.js`.

```javascript
// shared/error-bus.js
import { AppError } from './errors.js';

export class ErrorBus {
  constructor() {
    this._listeners = [];
    this._breadcrumbs = [];
    this._maxBreadcrumbs = 50;
    this._recentFingerprints = new Map();
    this._dedupeWindowMs = 5000;
  }

  addBreadcrumb(crumb) {
    if (this._breadcrumbs.length >= this._maxBreadcrumbs) this._breadcrumbs.shift();
    this._breadcrumbs.push({ ...crumb, timestamp: Date.now() });
  }

  report(error, extra) {
    const appErr = AppError.wrap(error);
    if (extra?.context) Object.assign(appErr.context, extra.context);

    // Dedup
    const fingerprint = extra?.dedupeKey || appErr.code;
    const lastSeen = this._recentFingerprints.get(fingerprint);
    if (lastSeen && Date.now() - lastSeen < this._dedupeWindowMs) return;
    this._recentFingerprints.set(fingerprint, Date.now());

    // Periodic cleanup of stale fingerprints (prevent memory leak)
    if (this._recentFingerprints.size > 200) {
      const now = Date.now();
      for (const [k, v] of this._recentFingerprints) {
        if (now - v > this._dedupeWindowMs) this._recentFingerprints.delete(k);
      }
    }

    const route = extra?.route || this._autoRoute(appErr);
    const entry = {
      error: appErr,
      timestamp: Date.now(),
      breadcrumbs: [...this._breadcrumbs],
    };

    // Always log
    this._log(entry);

    // Notify listeners
    for (const listener of this._listeners) {
      try { listener(entry, route); } catch { /* listener errors must not crash the bus */ }
    }
  }

  subscribe(listener) {
    this._listeners.push(listener);
    return () => { this._listeners = this._listeners.filter(l => l !== listener); };
  }

  _autoRoute(err) {
    if (err.code === 'WS_DISCONNECTED') return 'statusbar';
    if (err.severity === 'critical') return 'boundary';
    return 'toast';
  }

  _log(entry) {
    const { error } = entry;
    console.error(`[ErrorBus][${error.code}][${error.traceId}] ${error.message}`, error.context);
  }
}

// Global singleton per process
export const errorBus = new ErrorBus();
```

- [ ] **Step 2: Verify**

Run: `node -e "import { errorBus } from './shared/error-bus.js'; import { AppError } from './shared/errors.js'; errorBus.subscribe((entry, route) => console.log('ROUTE:', route, entry.error.code)); errorBus.addBreadcrumb({ type: 'action', message: 'test' }); errorBus.report(new AppError('LLM_TIMEOUT', { context: { model: 'gpt-4' } })); errorBus.report(new AppError('LLM_TIMEOUT')); console.log('deduped second call');"`
Expected: First report logs and routes to `toast`. Second report is deduped (no listener call). "deduped second call" prints.

- [ ] **Step 3: Commit**

```bash
git add shared/error-bus.js
git commit -m "feat(errors): ErrorBus with breadcrumbs, dedup, severity routing"
```

---

### Task 3: withRetry utility

**Files:**
- Create: `shared/retry.js`

- [ ] **Step 1: Create `shared/retry.js`**

Decorrelated jitter retry with abort support. Pure function, no dependencies on ErrorBus (callers decide whether to report).

```javascript
// shared/retry.js
import { AppError } from './errors.js';

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

/**
 * Retry with decorrelated jitter (AWS recommended).
 * @param {() => Promise<*>} fn
 * @param {{ maxAttempts?: number, baseDelayMs?: number, maxDelayMs?: number, signal?: AbortSignal, shouldRetry?: (err: AppError) => boolean }} opts
 */
export async function withRetry(fn, opts = {}) {
  const { maxAttempts = 3, baseDelayMs = 1000, maxDelayMs = 30000, signal, shouldRetry } = opts;
  let prevDelay = baseDelayMs;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const appErr = AppError.wrap(err);
      const retry = shouldRetry ? shouldRetry(appErr) : appErr.retryable;
      if (!retry || attempt === maxAttempts - 1) throw appErr;

      if (signal?.aborted) throw appErr;

      // Decorrelated jitter: delay = min(maxDelay, random(baseDelay, prevDelay * 3))
      const delay = Math.min(maxDelayMs, randomBetween(baseDelayMs, prevDelay * 3));
      prevDelay = delay;
      await sleep(delay, signal);
    }
  }
}
```

- [ ] **Step 2: Verify**

Run: `node -e "import { withRetry } from './shared/retry.js'; let n = 0; withRetry(() => { n++; if (n < 3) { const e = new Error('fail'); e.retryable = true; throw e; } return 'ok'; }, { baseDelayMs: 50, maxDelayMs: 200 }).then(r => console.log('result:', r, 'attempts:', n));"`
Expected: `result: ok attempts: 3` (retried twice before succeeding)

- [ ] **Step 3: Commit**

```bash
git add shared/retry.js
git commit -m "feat(errors): withRetry utility with decorrelated jitter"
```

---

### Task 4: safe-fs and safe-parse utilities

**Files:**
- Create: `shared/safe-fs.js`
- Create: `shared/safe-parse.js`

- [ ] **Step 1: Create `shared/safe-fs.js`**

Safe file operation wrappers. These import `errorBus` singleton and auto-report. The ErrorBus must be initialized before first use (it always is, since it's a module-level singleton).

```javascript
// shared/safe-fs.js
import fs from 'fs';
import path from 'path';
import { AppError } from './errors.js';
import { errorBus } from './error-bus.js';

export function safeReadFile(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    const code = err.code === 'ENOENT' ? 'FS_NOT_FOUND'
      : err.code === 'EACCES' ? 'FS_PERMISSION' : 'UNKNOWN';
    errorBus.report(new AppError(code, { cause: err, context: { filePath } }));
    return fallback;
  }
}

export function safeReadJSON(filePath, fallback = null) {
  const text = safeReadFile(filePath, null);
  if (text === null) return fallback;
  try {
    return JSON.parse(text);
  } catch (err) {
    errorBus.report(new AppError('CONFIG_PARSE', { cause: err, context: { filePath } }));
    return fallback;
  }
}

export async function safeReadYAML(filePath, fallback = null) {
  const text = safeReadFile(filePath, null);
  if (text === null) return fallback;
  try {
    const YAML = await importYAML();
    return YAML.load(text);
  } catch (err) {
    errorBus.report(new AppError('CONFIG_PARSE', { cause: err, context: { filePath } }));
    return fallback;
  }
}

let _yaml;
async function importYAML() {
  if (!_yaml) _yaml = await import('js-yaml');
  return _yaml;
}

/**
 * Synchronous YAML read (for contexts where async is not possible).
 * Requires js-yaml to be pre-imported. Use safeReadYAML for async contexts.
 */
export function safeReadYAMLSync(filePath, fallback = null, yaml) {
  const text = safeReadFile(filePath, null);
  if (text === null) return fallback;
  try {
    return yaml.load(text);
  } catch (err) {
    errorBus.report(new AppError('CONFIG_PARSE', { cause: err, context: { filePath } }));
    return fallback;
  }
}

/**
 * Atomic directory copy with rollback.
 * 1. Copy src → dst.tmp_{ts}
 * 2. If dst exists, rename dst → dst.bak_{ts}
 * 3. Rename dst.tmp_{ts} → dst
 * 4. Delete dst.bak_{ts}
 * Recovery: if step 3 fails, rename dst.bak_{ts} back to dst, clean up tmp.
 */
export function safeCopyDir(src, dst) {
  const ts = Date.now();
  const tmpDst = `${dst}.tmp_${ts}`;
  const bakDst = `${dst}.bak_${ts}`;

  try {
    // Step 1: recursive copy to temp
    _copyDirRecursive(src, tmpDst);

    // Step 2: backup existing
    let hadExisting = false;
    if (fs.existsSync(dst)) {
      fs.renameSync(dst, bakDst);
      hadExisting = true;
    }

    // Step 3: promote temp to final
    try {
      fs.renameSync(tmpDst, dst);
    } catch (renameErr) {
      // Rollback: restore backup
      if (hadExisting) {
        try { fs.renameSync(bakDst, dst); } catch { /* best effort */ }
      }
      _cleanupDir(tmpDst);
      throw renameErr;
    }

    // Step 4: clean up backup
    if (hadExisting) _cleanupDir(bakDst);
  } catch (err) {
    _cleanupDir(tmpDst);
    throw new AppError('FS_COPY_FAILED', { cause: err, context: { src, dst } });
  }
}

function _copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      _copyDirRecursive(s, d);
    } else {
      if (fs.existsSync(d)) {
        try { fs.chmodSync(d, 0o644); } catch { /* Windows NTFS */ }
      }
      fs.copyFileSync(s, d);
    }
  }
}

function _cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
```

- [ ] **Step 2: Create `shared/safe-parse.js`**

```javascript
// shared/safe-parse.js
import { AppError } from './errors.js';
import { errorBus } from './error-bus.js';

export function safeParseJSON(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch (err) {
    errorBus.report(new AppError('CONFIG_PARSE', { cause: err, context: { textPreview: String(text).slice(0, 100) } }));
    return fallback;
  }
}

/**
 * Safe response parser: checks res.ok, then parses JSON.
 * Returns fallback on any failure (HTTP error or parse error).
 */
export async function safeParseResponse(res, fallback = null) {
  try {
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      errorBus.report(new AppError('FETCH_SERVER_ERROR', {
        message: `HTTP ${res.status}: ${body.slice(0, 200)}`,
        context: { status: res.status, url: res.url },
      }));
      return fallback;
    }
    return await res.json();
  } catch (err) {
    errorBus.report(new AppError('CONFIG_PARSE', { cause: err, context: { url: res?.url } }));
    return fallback;
  }
}
```

- [ ] **Step 3: Verify safe-fs**

Run: `node -e "import { safeReadJSON, safeReadFile } from './shared/safe-fs.js'; console.log('missing:', safeReadJSON('/tmp/nonexistent.json', {fallback:true})); console.log('bad json:', safeReadJSON('/dev/null', 'default'));"`
Expected: Logs `[ErrorBus][FS_NOT_FOUND]...` and returns `{fallback:true}`, then `[ErrorBus][CONFIG_PARSE]...` and returns `default`.

- [ ] **Step 4: Commit**

```bash
git add shared/safe-fs.js shared/safe-parse.js
git commit -m "feat(errors): safe-fs and safe-parse utility wrappers"
```

---

## Phase 2: Middleware and Wrappers

### Task 5: Fastify global error handler

**Files:**
- Create: `server/middleware/error-handler.js`
- Modify: `server/index.js` (add import + registration, after line 147)

- [ ] **Step 1: Create `server/middleware/error-handler.js`**

```javascript
// server/middleware/error-handler.js
import { AppError } from '../../shared/errors.js';
import { errorBus } from '../../shared/error-bus.js';

export function registerErrorHandler(app) {
  app.setErrorHandler((error, request, reply) => {
    const appErr = AppError.wrap(error);
    errorBus.report(appErr, {
      context: { method: request.method, url: request.url },
    });
    reply.status(appErr.httpStatus).send({
      error: { code: appErr.code, message: appErr.message, traceId: appErr.traceId },
    });
  });
}
```

- [ ] **Step 2: Register in `server/index.js`**

Add import at top of file:
```javascript
import { registerErrorHandler } from './middleware/error-handler.js';
```

Add registration after `await app.register(websocket);` (after line 147):
```javascript
registerErrorHandler(app);
```

- [ ] **Step 3: Verify**

Start server, send a request to a route that will trigger an error (e.g., invalid endpoint). Verify the response has `{ error: { code, message, traceId } }` format and the console shows `[ErrorBus]` structured log.

- [ ] **Step 4: Commit**

```bash
git add server/middleware/error-handler.js server/index.js
git commit -m "feat(errors): Fastify global error handler middleware"
```

---

### Task 6: IPC handler wrapper (main process)

**Files:**
- Create: `desktop/ipc-wrapper.cjs`

**Architecture note:** The preload (`preload.cjs`) exposes `window.hana` with ~92 named methods that call `ipcRenderer.invoke(channel)`. Changing the return format to an envelope `{ ok, data/error }` would break all existing callers. Therefore, `wrapIpcHandler` is a **non-breaking safety net**: it catches unhandled errors and logs them structurally, but preserves the original return behavior. Existing handlers that return `null`/`false` on error continue to do so. The wrapper is the "fourth layer" for IPC: if a handler forgets its own try-catch, the wrapper catches, logs, and returns `undefined` (which is safe for most callers).

- [ ] **Step 1: Create `desktop/ipc-wrapper.cjs`**

```javascript
// desktop/ipc-wrapper.cjs
const { ipcMain } = require('electron');

/**
 * Non-breaking IPC handler wrapper.
 * Adds structured error logging as a safety net. Does NOT change return format.
 * Existing handlers continue returning their normal values (null, false, string, etc.).
 * If an error escapes the handler, it is logged and undefined is returned.
 */
function wrapIpcHandler(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (err) {
      const traceId = Math.random().toString(16).slice(2, 10);
      console.error(`[IPC][${channel}][${traceId}] ${err?.message || err}`);
      // Return undefined — callers already handle null/undefined from failed handlers
      return undefined;
    }
  });
}

/**
 * Non-breaking IPC one-way event wrapper.
 */
function wrapIpcOn(channel, handler) {
  ipcMain.on(channel, (event, ...args) => {
    try {
      handler(event, ...args);
    } catch (err) {
      console.error(`[IPC][${channel}] ${err?.message || err}`);
    }
  });
}

module.exports = { wrapIpcHandler, wrapIpcOn };
```

**CJS/ErrorBus trade-off:** `main.cjs` is CJS and cannot synchronously import the ESM `errorBus`. The wrapper uses `console.error` with a structured `[IPC][channel][traceId]` prefix instead. This is an explicit deviation from the spec's "all errors flow through ErrorBus" — the main process is the one exception, compensated by structured log format and the global `uncaughtException` handler.

- [ ] **Step 2: Commit**

```bash
git add desktop/ipc-wrapper.cjs
git commit -m "feat(errors): non-breaking IPC handler wrapper (CJS) with structured logging"
```

---

### Task 7: WebSocket message handler wrapper

**Files:**
- Modify: `server/routes/chat.js` (wrap ws.on("message") handler)

- [ ] **Step 1: Create a `wrapWsHandler` utility in `server/routes/chat.js`**

At the top of `chat.js`, add a local helper (or in a shared server utility file):

```javascript
import { AppError } from '../../shared/errors.js';
import { errorBus } from '../../shared/error-bus.js';

function wrapWsHandler(ws, wsSend, handler) {
  return async (raw) => {
    const msg = wsParse(raw);
    if (!msg) return;
    try {
      await handler(msg);
    } catch (err) {
      const appErr = AppError.wrap(err);
      errorBus.report(appErr, { context: { wsMessageType: msg.type } });
      if (!appErr.message?.includes('aborted')) {
        wsSend(ws, { type: 'error', error: appErr.toJSON() });
      }
    }
  };
}
```

- [ ] **Step 2: Replace the existing `ws.on("message")` body**

Find the existing `ws.on("message", async (raw) => { ... })` handler and wrap it with `wrapWsHandler`. The inner handler receives parsed `msg` instead of `raw`.

- [ ] **Step 3: Verify**

Start app, send a message, verify normal operation. Then test error path by simulating a failure. Check that error response includes `{ type: 'error', error: { code, message, traceId } }`.

- [ ] **Step 4: Commit**

```bash
git add server/routes/chat.js
git commit -m "feat(errors): wrap WebSocket message handler with auto error reporting"
```

---

## Phase 3: Frontend UI Components

### Task 8: Enhanced toast-slice

**Files:**
- Modify: `desktop/src/react/stores/toast-slice.ts`

- [ ] **Step 1: Update Toast interface and slice**

Replace the entire `toast-slice.ts` content:

```typescript
export interface Toast {
  id: number;
  text: string;
  type: 'success' | 'error' | 'info' | 'warning';
  errorCode?: string;
  persistent?: boolean;
  action?: {
    label: string;
    onClick: () => void;
  };
  dedupeKey?: string;
}

export interface ToastSlice {
  toasts: Toast[];
  addToast: (text: string, type?: Toast['type'], duration?: number, opts?: {
    errorCode?: string;
    persistent?: boolean;
    action?: Toast['action'];
    dedupeKey?: string;
  }) => void;
  removeToast: (id: number) => void;
}

const MAX_PERSISTENT = 3;
let _toastId = 0;

export const createToastSlice = (
  set: (partial: Partial<ToastSlice> | ((s: ToastSlice) => Partial<ToastSlice>)) => void,
  get: () => ToastSlice,
): ToastSlice => ({
  toasts: [],
  addToast: (text, type = 'info', duration = 5000, opts = {}) => {
    const id = ++_toastId;

    // Dedup: if dedupeKey matches an existing toast, skip
    if (opts.dedupeKey) {
      const existing = get().toasts;
      if (existing.some(t => t.dedupeKey === opts.dedupeKey)) return;
    }

    const persistent = opts.persistent ?? false;

    set((s) => {
      let toasts = [...s.toasts, { id, text, type, ...opts, persistent }];

      // Cap persistent toasts at MAX_PERSISTENT
      const persistentCount = toasts.filter(t => t.persistent).length;
      if (persistentCount > MAX_PERSISTENT) {
        // Remove oldest persistent toasts beyond cap
        let removed = 0;
        toasts = toasts.filter(t => {
          if (t.persistent && removed < persistentCount - MAX_PERSISTENT) {
            removed++;
            return false;
          }
          return true;
        });
      }

      return { toasts };
    });

    if (!persistent && duration > 0) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, duration);
    }
  },
  removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
});
```

Note: The slice creator now takes `get` as second argument.

- [ ] **Step 2: Update store index to pass `get` to toast slice**

In `desktop/src/react/stores/index.ts`, find the line that calls `createToastSlice(set)` and change it to `createToastSlice(set, _get)`. The store's `create` callback already receives `(set, _get, api)` — `_get` is used by other slices like `createDeskSlice(set, _get)` and `createChatSlice(set, _get)`, so this is the established pattern. The exact diff:

```typescript
// Before:
...createToastSlice(set),
// After:
...createToastSlice(set, _get),
```

- [ ] **Step 3: Commit**

```bash
git add desktop/src/react/stores/toast-slice.ts desktop/src/react/stores/index.ts
git commit -m "feat(errors): enhanced toast slice with persistent, action, dedup, warning type"
```

---

### Task 9: Enhanced ToastContainer

**Files:**
- Modify: `desktop/src/react/components/ToastContainer.tsx`

- [ ] **Step 1: Update ToastContainer with action button support**

Replace the entire `ToastContainer.tsx`:

```typescript
import { useEffect, useRef } from 'react';
import { useStore } from '../stores';
import type { Toast } from '../stores/toast-slice';

export function ToastContainer() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => ref.current?.classList.add('show'));
  }, []);

  function dismiss() {
    const el = ref.current;
    if (!el) return;
    el.classList.remove('show');
    setTimeout(() => useStore.getState().removeToast(toast.id), 300);
  }

  return (
    <div ref={ref} className={`hana-toast ${toast.type}`}>
      <span>{toast.text}</span>
      <div className="hana-toast-actions">
        {toast.action && (
          <button className="hana-toast-action" onClick={() => { toast.action!.onClick(); dismiss(); }}>
            {toast.action.label}
          </button>
        )}
        <button className="hana-toast-close" onClick={dismiss}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add CSS for action button and warning type**

Add the new styles to the existing toast CSS section (the toast styles currently live in `styles.css` with `.hana-toast` class). Since we are modifying this component, per CLAUDE.md rule, add the new styles alongside the existing ones. A full CSS Module migration of toast can be a follow-up.

```css
/* Add to existing .hana-toast styles in styles.css */
.hana-toast.warning {
  border-left-color: var(--warning-color, #c59a28);
}
.hana-toast-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 8px;
}
.hana-toast-action {
  background: none;
  border: 1px solid var(--border-light, #ddd);
  border-radius: 3px;
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
  color: inherit;
  white-space: nowrap;
}
```

- [ ] **Step 3: Commit**

```bash
git add desktop/src/react/components/ToastContainer.tsx
git commit -m "feat(errors): enhanced ToastContainer with action buttons and warning type"
```

---

### Task 10: Connection slice + StatusBar + WebSocket rewrite

**Files:**
- Modify: `desktop/src/react/stores/connection-slice.ts`
- Create: `desktop/src/react/components/StatusBar.tsx`
- Create: `desktop/src/react/components/StatusBar.module.css`
- Modify: `desktop/src/react/services/websocket.ts`
- Modify: `desktop/src/react/App.tsx` (add StatusBar)

- [ ] **Step 1: Extend connection-slice**

Add `wsState` and `wsReconnectAttempt` to the existing slice:

```typescript
// Add to ConnectionSlice interface:
wsState: 'connected' | 'reconnecting' | 'disconnected';
wsReconnectAttempt: number;

// Add to defaults:
wsState: 'disconnected',
wsReconnectAttempt: 0,
```

- [ ] **Step 2: Create StatusBar component**

```typescript
// desktop/src/react/components/StatusBar.tsx
import { useStore } from '../stores';
import { connectWebSocket } from '../services/websocket';
import styles from './StatusBar.module.css';

declare function t(key: string, vars?: Record<string, string | number>): string;

export function StatusBar() {
  const wsState = useStore((s) => s.wsState);
  const attempt = useStore((s) => s.wsReconnectAttempt);

  if (wsState === 'connected') return null;

  return (
    <div className={styles.bar}>
      {wsState === 'reconnecting' && (
        <span className={styles.text}>{t('status.reconnecting')} ({attempt})</span>
      )}
      {wsState === 'disconnected' && (
        <>
          <span className={styles.text}>{t('status.disconnected')}</span>
          <button className={styles.reconnect} onClick={() => connectWebSocket()}>
            {t('status.reconnect')}
          </button>
        </>
      )}
    </div>
  );
}
```

```css
/* desktop/src/react/components/StatusBar.module.css */
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  font-size: 12px;
  color: var(--text-tertiary, #999);
}
.text {
  opacity: 0.8;
}
.reconnect {
  background: none;
  border: 1px solid var(--border-light, #ddd);
  border-radius: 3px;
  padding: 1px 8px;
  font-size: 11px;
  cursor: pointer;
  color: inherit;
}
```

- [ ] **Step 3: Rewrite websocket.ts with ErrorBus + reconnect cap**

Key changes to `desktop/src/react/services/websocket.ts`:
- Import `errorBus` from `shared/error-bus.js` and `AppError` from `shared/errors.js`
- Add `WS_MAX_RETRIES = 20` constant
- Track reconnect attempts in `_wsRetryCount`
- `onopen`: reset retry count, set `wsState: 'connected'`
- `onclose`: if under limit, set `wsState: 'reconnecting'`, increment count; if at limit, set `wsState: 'disconnected'`
- `onerror`: `errorBus.report(new AppError('WS_DISCONNECTED'))`
- Export a `manualReconnect()` that resets retry count and calls `connectWebSocket()`

- [ ] **Step 4: Add StatusBar to App.tsx**

Import StatusBar and add it at the bottom of the chat area (above ToastContainer or inside the main content area).

- [ ] **Step 5: Commit**

```bash
git add desktop/src/react/stores/connection-slice.ts desktop/src/react/components/StatusBar.tsx desktop/src/react/components/StatusBar.module.css desktop/src/react/services/websocket.ts desktop/src/react/App.tsx
git commit -m "feat(errors): WebSocket reconnect cap + StatusBar + wsState in store"
```

---

### Task 11: RegionalErrorBoundary

**Files:**
- Create: `desktop/src/react/components/RegionalErrorBoundary.tsx`
- Create: `desktop/src/react/components/RegionalErrorBoundary.module.css`
- Modify: `desktop/src/react/App.tsx` (wrap panels)

- [ ] **Step 1: Create RegionalErrorBoundary**

```typescript
// desktop/src/react/components/RegionalErrorBoundary.tsx
import { Component, type ReactNode } from 'react';
import { AppError } from '../../../../shared/errors.js';
import { errorBus } from '../../../../shared/error-bus.js';
import styles from './RegionalErrorBoundary.module.css';

declare function t(key: string, vars?: Record<string, string | number>): string;

interface Props {
  region: string;
  resetKeys?: unknown[];
  children: ReactNode;
}

interface State {
  error: Error | null;
  prevResetKeys: unknown[];
}

export class RegionalErrorBoundary extends Component<Props, State> {
  state: State = { error: null, prevResetKeys: this.props.resetKeys || [] };

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // Auto-reset when resetKeys change
    if (props.resetKeys && state.error) {
      const changed = props.resetKeys.some((k, i) => k !== state.prevResetKeys[i]);
      if (changed) return { error: null, prevResetKeys: props.resetKeys };
    }
    if (props.resetKeys) return { prevResetKeys: props.resetKeys };
    return null;
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    errorBus.report(new AppError('RENDER_CRASH', {
      cause: error,
      context: { region: this.props.region, componentStack: info.componentStack?.slice(0, 500) },
    }));
  }

  handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div className={styles.fallback}>
          <p className={styles.message}>{t('error.regionUnavailable', { region: this.props.region })}</p>
          <button className={styles.retry} onClick={this.handleRetry}>
            {t('action.retry')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
```

- [ ] **Step 2: Create CSS module**

```css
/* desktop/src/react/components/RegionalErrorBoundary.module.css */
.fallback {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
  min-height: 100px;
  background: var(--bg-secondary, #f5f5f3);
}
.message {
  font-size: 13px;
  color: var(--text-secondary, #888);
  margin-bottom: 8px;
}
.retry {
  background: none;
  border: 1px solid var(--border-light, #ddd);
  border-radius: 3px;
  padding: 3px 12px;
  font-size: 12px;
  cursor: pointer;
  color: var(--text-secondary, #888);
}
```

- [ ] **Step 3: Wrap panels in App.tsx**

In `App.tsx`, wrap the major UI sections with `RegionalErrorBoundary`:
- Sidebar (SessionList etc.) → `region="sidebar"` `resetKeys={[currentAgentId]}`
- ChatArea → `region="chat"` `resetKeys={[currentSessionPath]}`
- DeskSection / Jian → `region="desk"` `resetKeys={[deskCurrentPath]}`
- InputArea → `region="input"` `resetKeys={[currentSessionPath]}`

Keep the existing root `ErrorBoundary` as the outermost fallback.

- [ ] **Step 4: Commit**

```bash
git add desktop/src/react/components/RegionalErrorBoundary.tsx desktop/src/react/components/RegionalErrorBoundary.module.css desktop/src/react/App.tsx
git commit -m "feat(errors): RegionalErrorBoundary with resetKeys + wrap major panels"
```

---

### Task 12: ErrorBus → Zustand bridge (renderer)

**Files:**
- Create: `desktop/src/react/errors/error-bus-bridge.ts`
- Modify: `desktop/src/react/App.tsx` (initialize bridge in `init()`)

- [ ] **Step 1: Create error-bus-bridge.ts**

This connects the renderer's ErrorBus singleton to Zustand stores:

```typescript
// desktop/src/react/errors/error-bus-bridge.ts
import { errorBus } from '../../../../shared/error-bus.js';
import { useStore } from '../stores';
import type { ErrorRoute } from './types';

declare function t(key: string, vars?: Record<string, string | number>): string;

export function initErrorBusBridge() {
  errorBus.subscribe((entry, route: ErrorRoute) => {
    const { error } = entry;
    const userMessage = t(error.userMessageKey) || error.message;

    switch (route) {
      case 'toast':
        useStore.getState().addToast(userMessage, error.severity === 'cosmetic' ? 'warning' : 'error', error.severity === 'critical' ? 0 : 5000, {
          errorCode: error.code,
          persistent: error.severity === 'critical',
          dedupeKey: error.code,
        });
        break;
      case 'statusbar':
        // Handled by wsState in connection-slice (WebSocket manages its own state)
        break;
      case 'boundary':
        // Boundaries catch errors themselves; ErrorBus just logs
        break;
      case 'silent':
        // Log only, no UI (already logged by ErrorBus._log)
        break;
    }
  });
}
```

- [ ] **Step 2: Initialize in App.tsx**

In the `init()` function, after connecting WebSocket, call:
```typescript
import { initErrorBusBridge } from './errors/error-bus-bridge';
// ... inside init():
initErrorBusBridge();
```

- [ ] **Step 3: Update global error handlers in App.tsx**

Replace the existing `window.addEventListener('error', ...)` and `unhandledrejection` handlers to use ErrorBus:

```typescript
import { errorBus } from '../../../shared/error-bus.js';
import { AppError } from '../../../shared/errors.js';

window.addEventListener('error', (e) => {
  errorBus.report(AppError.wrap(e.error || e.message), {
    context: { filename: e.filename, line: e.lineno },
  });
});
window.addEventListener('unhandledrejection', (e) => {
  errorBus.report(AppError.wrap(e.reason));
});
```

- [ ] **Step 4: Fix `showError` in `ui-helpers.ts`**

Remove the emoji prefix (`\u26A0`) which violates CLAUDE.md icon rules, and route through ErrorBus:

```typescript
// desktop/src/react/utils/ui-helpers.ts — updated showError
import { errorBus } from '../../../../shared/error-bus.js';
import { AppError } from '../../../../shared/errors.js';

export function showError(message: string): void {
  errorBus.report(new AppError('UNKNOWN', { message }));
}
```

- [ ] **Step 5: Commit**

```bash
git add desktop/src/react/errors/error-bus-bridge.ts desktop/src/react/App.tsx desktop/src/react/utils/ui-helpers.ts
git commit -m "feat(errors): ErrorBus → Zustand bridge + global handlers + showError via ErrorBus"
```

---

### Task 12.5: Settings window Toast unification

**Files:**
- Modify: `desktop/src/react/settings/Toast.tsx`
- Modify: `desktop/src/react/settings/store.ts` (or equivalent settings store)

The settings window is a separate BrowserWindow. It currently has its own `Toast.tsx` component and `showToast` state in its own store. Unify it to use the same toast-slice pattern as the main window (independent instance, same behavior).

- [ ] **Step 1: Rewrite settings Toast to match main window pattern**

Replace the settings-specific `Toast.tsx` with a ToastContainer that uses the same `Toast` interface from `toast-slice.ts`. The settings store should create its own toast slice (independent from the main window's store), but with the same API (`addToast`, `removeToast`, same types including `warning`, `persistent`, `action`).

- [ ] **Step 2: Remove old settings toast state**

Remove `toastMessage`, `toastType`, `toastVisible` from the settings store. Replace with the toast slice.

- [ ] **Step 3: Commit**

```bash
git add desktop/src/react/settings/Toast.tsx desktop/src/react/settings/store.ts
git commit -m "refactor(errors): unify settings window Toast with main toast-slice pattern"
```

---

## Phase 4: Codebase-Wide Fixes

### Task 13: LLM client — slow response detection + withRetry

**Files:**
- Modify: `core/llm-client.js`

- [ ] **Step 1: Add imports and slow response timer**

At the top of `llm-client.js`:
```javascript
import { AppError } from '../shared/errors.js';
import { errorBus } from '../shared/error-bus.js';
import { withRetry } from '../shared/retry.js';
```

Inside `callText`, before the fetch call (after building `endpoint`, `headers`, `body`):
```javascript
const SLOW_THRESHOLD_MS = 15_000;
const slowTimer = setTimeout(() => {
  errorBus.report(new AppError('LLM_SLOW_RESPONSE', {
    context: { model, provider, elapsed: SLOW_THRESHOLD_MS },
  }));
}, SLOW_THRESHOLD_MS);
```

After the fetch completes (in the `finally` or after `res.text()`), add:
```javascript
clearTimeout(slowTimer);
```

- [ ] **Step 2: Wrap error classification**

Replace the existing catch block and error throws with AppError codes:
- `AbortError`/`TimeoutError` → `new AppError('LLM_TIMEOUT', { context: { model } })`
- `!res.ok` with 401/403 → `new AppError('LLM_AUTH_FAILED', ...)`
- `!res.ok` with 429 → `new AppError('LLM_RATE_LIMITED', ...)`
- Empty response → `new AppError('LLM_EMPTY_RESPONSE', ...)`

- [ ] **Step 3: Commit**

```bash
git add core/llm-client.js
git commit -m "feat(errors): LLM client slow response detection + AppError classification"
```

---

### Task 14: first-run.js — safeCopyDir + safe file ops

**Files:**
- Modify: `core/first-run.js`

- [ ] **Step 1: Replace `copyDirSync` with `safeCopyDir`**

Import at top:
```javascript
import { safeCopyDir } from '../shared/safe-fs.js';
import { errorBus } from '../shared/error-bus.js';
import { AppError } from '../shared/errors.js';
```

Replace the `copyDirSync` function and its usage in `syncSkills`:
- `copyDirSync(skillSrc, skillDst)` → wrapped in try-catch with `safeCopyDir(skillSrc, skillDst)` and `withRetry` for Windows:

```javascript
import { withRetry } from '../shared/retry.js';

// In syncSkills, replace copyDirSync call:
try {
  await withRetry(() => Promise.resolve(safeCopyDir(skillSrc, skillDst)), {
    maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 3000,
  });
} catch (err) {
  errorBus.report(new AppError('SKILL_SYNC_FAILED', {
    cause: err, context: { skill: entry.name },
  }));
  // Continue with other skills, don't abort
}
```

Note: `syncSkills` needs to become async (or use a sync retry wrapper). If the calling context (`ensureFirstRun`) is sync, consider making it async or using a sync retry loop.

- [ ] **Step 2: Fix TOCTOU in hasAgent check**

Replace the `statSync` that can race with a safer pattern:
```javascript
const hasAgent = fs.readdirSync(agentsDir, { withFileTypes: true }).some(entry => {
  return entry.isDirectory() && !entry.name.startsWith('.');
});
```
(`readdirSync` with `withFileTypes: true` returns `Dirent` objects that carry the type info without a separate `statSync` call.)

- [ ] **Step 3: Remove the old `copyDirSync` function**

Delete the `copyDirSync` function definition (lines 125-141) since it's replaced by `safeCopyDir` from `shared/safe-fs.js`.

- [ ] **Step 4: Commit**

```bash
git add core/first-run.js
git commit -m "fix(errors): first-run uses safeCopyDir + fix TOCTOU race"
```

---

### Task 15: Replace unsafe file operations across codebase

**Files:**
- Modify: `core/provider-registry.js`, `core/bridge-session-manager.js`, `core/sync-favorites.js`, `core/agent.js`, `core/agent-manager.js`
- Modify: `lib/tools/web-search.js`, `lib/memory/compile.js`, `lib/bridge/bridge-manager.js`
- Modify: `server/cli.js`, `server/routes/fs.js`, `server/routes/skills.js`

- [ ] **Step 1: Backend core files**

For each file, add imports and replace unsafe patterns:

**`core/provider-registry.js`**: Replace bare `readFileSync` + `YAML.load` with `safeReadYAMLSync(filePath, fallback, yaml)` (sync context, pass yaml instance).

**`core/bridge-session-manager.js:92`**: Replace `JSON.parse(fs.readFileSync(...))` with `safeReadJSON(filePath, {})`.

**`core/sync-favorites.js`**: Replace bare `YAML.load(readFileSync(...))` with `safeReadYAMLSync`.

**`core/agent.js`**: Replace ~5 places where file read failures silently return `''` with `safeReadFile(filePath, '')`.

**`core/agent-manager.js`**: Replace unguarded readFileSync/JSON.parse with `safeReadJSON` or `safeReadYAMLSync`.

- [ ] **Step 2: Library files**

**`lib/tools/web-search.js`**: In all 3 search functions (`searchTavily`, `searchSerper`, `searchBrave`), replace bare `res.json()` with `safeParseResponse(res, null)`. Add null check after parse.

**`lib/memory/compile.js:121,133`**: Replace silent empty-string fallback with `safeReadFile(filePath, '')`.

**`lib/bridge/bridge-manager.js:463`**: Replace `console.error` with `errorBus.report(new AppError('BRIDGE_SEND_FAILED', ...))`.

- [ ] **Step 3: Server files**

**`server/cli.js:55`**: Replace bare `JSON.parse(data.toString())` with:
```javascript
import { safeParseJSON } from '../shared/safe-parse.js';
const msg = safeParseJSON(data.toString());
if (!msg) return;
```

**`server/routes/fs.js:41,56`**: Replace bare `readFileSync` with `safeReadFile` from `shared/safe-fs.js`.

**`server/routes/skills.js:181`**: Replace `copyDirSync` with `safeCopyDir` from `shared/safe-fs.js`.

- [ ] **Step 4: Commit**

```bash
git add core/provider-registry.js core/bridge-session-manager.js core/sync-favorites.js core/agent.js core/agent-manager.js lib/tools/web-search.js lib/memory/compile.js lib/bridge/bridge-manager.js server/cli.js server/routes/fs.js server/routes/skills.js
git commit -m "fix(errors): replace unsafe file/parse operations with safe wrappers across codebase"
```

---

### Task 16: main.cjs — wrapIpcHandler + safeReadJSON

**Files:**
- Modify: `desktop/main.cjs`

- [ ] **Step 1: Add wrapIpcHandler require**

At the top of `main.cjs`:
```javascript
const { wrapIpcHandler, wrapIpcOn } = require('./ipc-wrapper.cjs');
```

- [ ] **Step 2: Migrate IPC handlers**

Replace `ipcMain.handle(channel, handler)` calls with `wrapIpcHandler(channel, handler)`. The handler functions stay the same, but they no longer need their own try-catch (the wrapper handles it).

Replace `ipcMain.on(channel, handler)` calls with `wrapIpcOn(channel, handler)`.

For handlers that currently return `null`/`false` on error (e.g., `read-file`, `write-file`), keep the existing catch-and-return-fallback behavior inside the handler. The wrapper adds an additional safety net for uncaught errors.

- [ ] **Step 3: Replace bare JSON.parse(readFileSync)**

Find all instances of `JSON.parse(fs.readFileSync(...))` in `main.cjs` and replace with a local safe version:

```javascript
function safeReadJSON(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return fallback; }
}
```

(Use a local function since `main.cjs` is CJS and can't import the ESM `shared/safe-fs.js` synchronously. The wrapper logs via console.error.)

- [ ] **Step 4: Update global error handlers**

Replace the existing `process.on('uncaughtException')` and `process.on('unhandledRejection')` to include structured logging:

```javascript
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ERR_IPC_CHANNEL_CLOSED') return;
  const code = err.code || 'UNKNOWN';
  const traceId = Math.random().toString(16).slice(2, 10);
  console.error(`[ErrorBus][${code}][${traceId}] uncaughtException: ${err.message}`);
  dlog?.error?.('main', `[${traceId}] ${err.stack || err.message}`);
});
```

- [ ] **Step 5: Commit**

```bash
git add desktop/main.cjs
git commit -m "feat(errors): main.cjs wrapIpcHandler + safeReadJSON + structured global handlers"
```

---

### Task 17: i18n keys

**Files:**
- Modify: `desktop/src/locales/en.json`
- Modify: `desktop/src/locales/zh.json` (or equivalent Chinese locale file)

- [ ] **Step 1: Add error i18n keys**

Find the locale files and add all new error keys referenced by `ERROR_DEFS`:

```json
{
  "error.llmTimeout": "Model request timed out",
  "error.llmRateLimited": "Model rate limited, please wait",
  "error.llmEmptyResponse": "Model returned empty response",
  "error.llmAuthFailed": "Model authentication failed",
  "error.llmSlowResponse": "Model is responding slowly, please wait",
  "error.fsPermission": "File permission denied",
  "error.fsNotFound": "File not found",
  "error.fsCopyFailed": "File copy failed",
  "error.wsDisconnected": "Connection lost",
  "error.fetchTimeout": "Request timed out",
  "error.fetchServerError": "Server error",
  "error.ipcFailed": "Internal communication error",
  "error.renderCrash": "Display error",
  "error.configParse": "Configuration file corrupted",
  "error.bridgeSendFailed": "Failed to send message to platform",
  "error.skillSyncFailed": "Skill sync failed",
  "error.memoryCompileFailed": "Memory compilation failed",
  "error.dbError": "Database error",
  "error.serverAuthFailed": "Authentication failed",
  "error.unknown": "An unexpected error occurred",
  "error.regionUnavailable": "This area is temporarily unavailable",
  "status.reconnecting": "Reconnecting...",
  "status.disconnected": "Connection lost",
  "status.reconnect": "Reconnect",
  "action.retry": "Retry"
}
```

Add corresponding Chinese translations in `zh.json`:
```json
{
  "error.llmTimeout": "模型请求超时",
  "error.llmRateLimited": "模型限流，请稍候",
  "error.llmEmptyResponse": "模型返回了空响应",
  "error.llmAuthFailed": "模型认证失败",
  "error.llmSlowResponse": "模型响应较慢，请耐心等待",
  "error.fsPermission": "文件权限不足",
  "error.fsNotFound": "文件未找到",
  "error.fsCopyFailed": "文件复制失败",
  "error.wsDisconnected": "连接已断开",
  "error.fetchTimeout": "请求超时",
  "error.fetchServerError": "服务器错误",
  "error.ipcFailed": "内部通信错误",
  "error.renderCrash": "显示异常",
  "error.configParse": "配置文件损坏",
  "error.bridgeSendFailed": "消息发送失败",
  "error.skillSyncFailed": "技能同步失败",
  "error.memoryCompileFailed": "记忆编译失败",
  "error.dbError": "数据库错误",
  "error.serverAuthFailed": "认证失败",
  "error.unknown": "发生了未知错误",
  "error.regionUnavailable": "此区域暂时无法显示",
  "status.reconnecting": "正在重连...",
  "status.disconnected": "连接已断开",
  "status.reconnect": "重新连接",
  "action.retry": "重试"
}
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src/locales/
git commit -m "feat(i18n): add error handling i18n keys (en + zh)"
```

---

## Phase 5: Integration Verification

### Task 18: End-to-end verification

- [ ] **Step 1: Build and start**

Run: `npm run build:renderer && npm start`
Expected: App starts without errors. No new console warnings from imports.

- [ ] **Step 2: Verify normal operation**

- Send a chat message → works normally
- Switch sessions → works, no stale errors
- Open settings → works
- Check WebSocket status → connected, StatusBar not visible

- [ ] **Step 3: Test error scenarios**

- Stop the Ollama model and send a message → toast shows "模型请求超时" (after timeout)
- Kill the server process briefly → StatusBar shows "正在重连...", then "已重新连接" on recovery
- Edit a config YAML to be invalid → structured error logged, app doesn't crash
- Verify `npm run typecheck` passes

- [ ] **Step 4: Run `npx electron-rebuild -f -w better-sqlite3`**

Per CLAUDE.md rule: if any `npm install` or `npm rebuild` was run during implementation, must rebuild for Electron.

- [ ] **Step 5: Final commit**

```bash
git commit -m "chore: error handling overhaul complete — four-layer defense operational"
```
