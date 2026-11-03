/**
 * Session Archive — browser half.
 *
 * Registers one sidebar panel row ("已归档") and the management page it opens.
 * The page keeps its own selection state, reads the archived inventory from the
 * Host route, and never deletes without the two confirmation gates.
 *
 * Styling follows the host: theme tokens only, self-contained controls, no
 * imports of shipped client packages, no DOM writes outside the component.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-admin',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'session-archive';
    const NS = 'session.admin';
    const LIST_URL = '/dsh-session-admin/api/archived';
    const DELETE_URL = '/dsh-session-admin/api/delete';
    const CANCEL_PENDING_URL = '/dsh-session-admin/api/pending/cancel';
    const EMPTY_ARRAY = Object.freeze([]);
    const EMPTY_OBJECT = Object.freeze({});

    const zh = {
      panel: '已归档',
      'page.title': '已归档会话',
      'page.subtitle': '共 {count} 个会话 · 占用 {size}',
      'page.subtitleDescendants': '含 {descendants} 个派生子会话',
      'toolbar.selectAll': '全选',
      'toolbar.selected': '已选 {count} 项',
      'toolbar.refresh': '刷新',
      'toolbar.unarchive': '取消归档',
      'toolbar.delete': '删除',
      'list.select': '选择会话',
      'list.workspaceUnknown': '未分组',
      'list.untitled': '未命名会话',
      'tag.missingLog': '日志缺失',
      'tag.duplicate': '目录冲突',
      'tag.pending': '待删除',
      'tag.pendingFailed': '删除失败',
      'pending.hint': '下次启动 DSH 时自动删除，可取消',
      'action.cancelPending': '取消待删除',
      'action.cancelPendingRow': '取消',
      'empty.title': '暂无已归档会话',
      'empty.hint': '在会话的“...”菜单中选择归档后，会话会出现在这里。',
      'loading': '正在读取归档会话…',
      'error.title': '读取失败',
      'error.retry': '重试',
      'error.deletePlan': '无法生成删除计划：{message}',
      'error.delete': '删除失败：{message}',
      'error.unarchive': '取消归档失败：{message}',
      'error.cancelPending': '取消待删除失败：{message}',
      'notice.unarchive': '已取消归档 {ok} 个会话，失败 {failed} 个。',
      'notice.delete': '已删除 {deleted} 个会话，释放 {freed}；失败 {failed} 个。',
      'notice.queued': '已排队 {count} 个会话，下次启动 DSH 时自动删除。',
      'notice.cancelled': '已取消 {count} 个待删除会话。',
      'notice.attachmentsSkipped': '附件未清理（{reason}）。',
      'notice.attachmentsCleared': '同时清理了 {count} 个无人引用的附件对象，释放 {size}。',
      'skip.scanUnavailable': '无法扫描其余会话',
      'skip.budget': '引用扫描超出预算',
      'skip.listingFailed': '无法读取会话列表',
      'notice.close': '关闭',
      'confirm.title': '永久删除 {count} 个已归档会话',
      'confirm.body': '将删除会话日志目录、投影缓存、定时任务与归档记录。此操作不可恢复。',
      'confirm.size': '预计释放：{size}',
      'confirm.descendants': '其中包含 {count} 个派生子会话，将一并删除。',
      'confirm.immediate': '{count} 个会话将立即删除。',
      'confirm.queued': '{count} 个会话仍在内存中，将标记为待删除，下次启动 DSH 时自动删除。',
      'confirm.pendingHint': '待删除不会立即删除任何文件，可随时取消。',
      'confirm.attach': '同时清理未被其他会话引用的附件对象',
      'confirm.attachHint': '删除前会扫描其余会话与上传索引；扫描不完整时附件一律保留。',
      'confirm.ack': '我确认删除这些会话（立即删除或下次启动自动删除）',
      'confirm.cancel': '取消',
      'confirm.confirm': '确认删除',
      'confirm.busy': '正在处理…',
      'confirm.empty': '当前选择没有可删除的会话。',
      'confirm.invalid': '以下会话无法删除：',
      'result.failed': '失败明细',
      'unit.session': '个会话',
    };

    const en = {
      panel: 'Archived',
      'page.title': 'Archived sessions',
      'page.subtitle': '{count} sessions · {size} on disk',
      'page.subtitleDescendants': 'includes {descendants} subagent sessions',
      'toolbar.selectAll': 'Select all',
      'toolbar.selected': '{count} selected',
      'toolbar.refresh': 'Refresh',
      'toolbar.unarchive': 'Unarchive',
      'toolbar.delete': 'Delete',
      'list.select': 'Select session',
      'list.workspaceUnknown': 'Ungrouped',
      'list.untitled': 'Untitled session',
      'tag.missingLog': 'Log missing',
      'tag.duplicate': 'Directory conflict',
      'tag.pending': 'Pending deletion',
      'tag.pendingFailed': 'Deletion failed',
      'pending.hint': 'Deleted automatically on the next DSH start; you can cancel it',
      'action.cancelPending': 'Cancel pending',
      'action.cancelPendingRow': 'Cancel',
      'empty.title': 'No archived sessions',
      'empty.hint': 'Archive a session from its “...” menu and it appears here.',
      'loading': 'Reading archived sessions…',
      'error.title': 'Could not load',
      'error.retry': 'Retry',
      'error.deletePlan': 'Could not build the delete plan: {message}',
      'error.delete': 'Delete failed: {message}',
      'error.unarchive': 'Unarchive failed: {message}',
      'error.cancelPending': 'Could not cancel the pending deletion: {message}',
      'notice.unarchive': 'Unarchived {ok} session(s); {failed} failed.',
      'notice.delete': 'Deleted {deleted} session(s), freed {freed}; {failed} failed.',
      'notice.queued': '{count} session(s) queued for deletion on the next DSH start.',
      'notice.cancelled': 'Cancelled {count} pending deletion(s).',
      'notice.attachmentsSkipped': 'Attachments were kept ({reason}).',
      'notice.attachmentsCleared': 'Also removed {count} unreferenced attachment object(s), freeing {size}.',
      'skip.scanUnavailable': 'the remaining sessions could not be scanned',
      'skip.budget': 'the reference scan exceeded its budget',
      'skip.listingFailed': 'the session list could not be read',
      'notice.close': 'Dismiss',
      'confirm.title': 'Permanently delete {count} archived session(s)',
      'confirm.body': 'This removes the session log directories, projection cache, schedules, and archive records. It cannot be undone.',
      'confirm.size': 'Estimated reclaim: {size}',
      'confirm.descendants': 'This includes {count} subagent session(s), deleted with it.',
      'confirm.immediate': '{count} session(s) will be deleted immediately.',
      'confirm.queued': '{count} session(s) are still in memory and will be marked for deletion on the next DSH start.',
      'confirm.pendingHint': 'A pending deletion touches no files and can be cancelled at any time.',
      'confirm.attach': 'Also remove attachment objects no other session references',
      'confirm.attachHint': 'Remaining sessions and the upload index are scanned first; if the scan is incomplete, every attachment is kept.',
      'confirm.ack': 'I understand these sessions will be deleted now or on the next DSH start',
      'confirm.cancel': 'Cancel',
      'confirm.confirm': 'Delete permanently',
      'confirm.busy': 'Working…',
      'confirm.empty': 'The current selection has nothing to delete.',
      'confirm.invalid': 'These sessions cannot be deleted:',
      'result.failed': 'Failure details',
      'unit.session': 'sessions',
    };

    const CSS = `
.dsa-page { height: 100%; overflow: auto; box-sizing: border-box; padding: 28px 32px 48px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.dsa-inner { max-width: 920px; margin: 0 auto; }
.dsa-header { display: flex; align-items: flex-start; gap: 16px; }
.dsa-heading { min-width: 0; flex: 1; }
.dsa-title { margin: 0; font-size: 20px; font-weight: 600; line-height: 28px; }
.dsa-subtitle { margin: 6px 0 0; font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsa-toolbar { display: flex; align-items: center; gap: 8px; margin: 20px 0 12px; flex-wrap: wrap; }
.dsa-spacer { flex: 1; }
.dsa-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; cursor: pointer; }
.dsa-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dsa-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.dsa-btn-danger { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dsa-btn-danger:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dsa-btn-danger-solid { border-color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-state-error-primary); color: #ffffff; }
.dsa-btn-danger-solid:hover:not(:disabled) { opacity: 0.92; }
.dsa-btn:focus-visible, .dsa-check:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsa-link { flex: none; border: none; background: none; padding: 0; margin: 2px 0 0; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 16px; text-decoration: underline; cursor: pointer; }
.dsa-link:hover { color: var(--dsw-alias-label-primary); }
.dsa-link:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsa-count { font-size: 13px; color: var(--dsw-alias-label-secondary); }
.dsa-banner { display: flex; align-items: flex-start; gap: 10px; margin: 12px 0; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); font-size: 13px; line-height: 18px; }
.dsa-banner-error { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dsa-banner-success { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.dsa-banner-warn { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.dsa-banner-text { flex: 1; min-width: 0; white-space: pre-wrap; }
.dsa-banner-close { flex: none; border: none; background: none; color: inherit; font: inherit; font-size: 12px; cursor: pointer; text-decoration: underline; }
.dsa-list { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; overflow: hidden; background: var(--dsw-alias-bg-layer-1); }
.dsa-row { display: flex; align-items: flex-start; gap: 12px; padding: 12px 14px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsa-row:first-child { border-top: none; }
.dsa-row:hover { background: var(--dsw-alias-bg-layer-2); }
.dsa-check { flex: none; width: 16px; height: 16px; margin: 2px 0 0; accent-color: var(--dsw-alias-brand-primary); cursor: pointer; }
.dsa-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.dsa-row-title { font-size: 14px; line-height: 20px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsa-row-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
.dsa-tag { padding: 1px 6px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); font-size: 11px; line-height: 14px; }
.dsa-tag-warn { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.dsa-size { flex: none; margin-top: 2px; font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.dsa-empty { border: 1px dashed var(--dsw-alias-border-l1); border-radius: 10px; padding: 48px 24px; text-align: center; }
.dsa-empty-title { font-size: 15px; font-weight: 500; }
.dsa-empty-hint { margin-top: 8px; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.dsa-loading { padding: 40px 0; text-align: center; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.dsa-failures { margin: 12px 0 0; padding: 10px 12px; border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.dsa-failure-title { font-weight: 600; margin-bottom: 4px; }
.dsa-failure-row { word-break: break-word; }
.dsa-overlay { position: fixed; inset: 0; z-index: 1200; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0, 0, 0, 0.42); }
.dsa-dialog { width: min(560px, 100%); max-height: 82vh; overflow: auto; padding: 20px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28); }
.dsa-dialog-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; }
.dsa-dialog-body { margin: 10px 0 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.dsa-dialog-meta { margin: 10px 0 0; font-size: 13px; line-height: 20px; }
.dsa-invalid { margin: 12px 0 0; padding-left: 18px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-warn-primary); }
.dsa-option { display: flex; align-items: flex-start; gap: 8px; margin-top: 14px; font-size: 13px; line-height: 20px; }
.dsa-option input { margin: 3px 0 0; accent-color: var(--dsw-alias-brand-primary); }
.dsa-option-hint { margin: 4px 0 0 24px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsa-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
.dsa-dialog-section { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsa-dialog-section-title { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
`;

    /**
     * Replace `{name}` placeholders in one translated template.
     * @param {string} template translated text
     * @param {Record<string, unknown>} [values] placeholder values
     * @returns {string} filled text
     */
    function fill(template, values) {
      const source = typeof template === 'string' ? template : String(template ?? '');
      if (values === undefined) return source;
      return source.replace(/\{(\w+)\}/g, (match, key) => (
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
      ));
    }

    /**
     * Human-readable byte count.
     * @param {number} bytes raw bytes
     * @returns {string} formatted size
     */
    function formatBytes(bytes) {
      const value = Number(bytes);
      if (!Number.isFinite(value) || value <= 0) return '0 B';
      if (value < 1024) return `${Math.round(value)} B`;
      const units = ['KB', 'MB', 'GB', 'TB'];
      let scaled = value / 1024;
      let unit = 0;
      while (scaled >= 1024 && unit < units.length - 1) {
        scaled /= 1024;
        unit += 1;
      }
      const digits = scaled >= 100 ? 0 : 1;
      return `${scaled.toFixed(digits)} ${units[unit]}`;
    }

    /**
     * Localized timestamp for a summary's updatedAt value.
     * @param {unknown} value milliseconds or ISO string
     * @returns {string} display text (empty when unknown)
     */
    function formatTime(value) {
      if (value === undefined || value === null) return '';
      const date = new Date(typeof value === 'number' ? value : String(value));
      if (Number.isNaN(date.getTime())) return '';
      try {
        return date.toLocaleString();
      } catch {
        return date.toISOString();
      }
    }

    /**
     * POST one JSON request to a Host route.
     * @param {string} url endpoint
     * @param {unknown} body JSON body
     * @returns {Promise<any>} decoded response
     */
    async function postJson(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`);
      return payload;
    }

    /**
     * Build the page component bound to one plugin context.
     * @param {import('@deepseek-ai/cordis').Context} ctx browser plugin context
     * @param {(key: string) => string} fallbackTranslate namespace translator
     * @returns {Function} React component
     */
    function createPage(ctx, fallbackTranslate) {
      return function SessionArchivePage(props) {
        const componentProps = props ?? {};
        const translate = (key) => {
          try {
            if (typeof componentProps.t === 'function') {
              const value = componentProps.t(key);
              if (typeof value === 'string' && value !== key) return value;
            }
          } catch {
            /* fall through to the namespace translator */
          }
          return fallbackTranslate(key);
        };
        const T = (key, values) => fill(translate(key), values ?? {});
        const useWorkspaces = typeof componentProps.useWorkspaces === 'function' ? componentProps.useWorkspaces : null;
        const useSessions = typeof componentProps.useSessions === 'function' ? componentProps.useSessions : null;
        const archivedIds = (useWorkspaces !== null && useWorkspaces((snapshot) => snapshot.archivedSessionIds)) || EMPTY_ARRAY;
        const workspaceItems = (useWorkspaces !== null && useWorkspaces((snapshot) => snapshot.items)) || EMPTY_ARRAY;
        const sessionById = (useSessions !== null && useSessions((snapshot) => snapshot.byId)) || EMPTY_OBJECT;

        const [state, setState] = React.useState({ phase: 'loading', items: EMPTY_ARRAY, totals: { count: 0, bytes: 0, descendants: 0 }, error: null });
        const [selected, setSelected] = React.useState(() => new Set());
        const [busy, setBusy] = React.useState(null);
        const [notice, setNotice] = React.useState(null);
        const [failures, setFailures] = React.useState(EMPTY_ARRAY);
        const [dialog, setDialog] = React.useState(null);
        const [defaultCleanup, setDefaultCleanup] = React.useState(true);
        const requestToken = React.useRef(0);
        const cancelRef = React.useRef(null);
        const archivedKey = Array.isArray(archivedIds) ? archivedIds.join('|') : '';

        const reload = React.useCallback(async () => {
          const token = requestToken.current + 1;
          requestToken.current = token;
          try {
            const response = await fetch(LIST_URL, { cache: 'no-store', credentials: 'same-origin' });
            const payload = await response.json();
            if (token !== requestToken.current) return;
            if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`);
            setState({
              phase: 'ready',
              items: Array.isArray(payload.items) ? payload.items : EMPTY_ARRAY,
              totals: payload.totals ?? { count: 0, bytes: 0, descendants: 0 },
              error: null,
            });
            setDefaultCleanup(payload.defaults?.cleanupAttachments !== false);
          } catch (error) {
            if (token !== requestToken.current) return;
            setState((previous) => ({
              ...previous,
              phase: previous.phase === 'ready' ? 'ready' : 'error',
              error: error instanceof Error ? error.message : String(error),
            }));
          }
        }, []);

        React.useEffect(() => {
          reload();
        }, [reload, archivedKey]);

        React.useEffect(() => {
          if (dialog === null) return undefined;
          const onKeyDown = (event) => {
            if (event.key === 'Escape' && busy === null) {
              setDialog(null);
            }
          };
          window.addEventListener('keydown', onKeyDown);
          try {
            cancelRef.current?.focus?.();
          } catch {
            /* focus is best-effort */
          }
          return () => window.removeEventListener('keydown', onKeyDown);
        }, [dialog, busy]);

        const workspaces = Array.isArray(workspaceItems)
          ? workspaceItems
          : (workspaceItems !== null && typeof workspaceItems === 'object' ? Object.values(workspaceItems) : EMPTY_ARRAY);
        const workspaceFor = (sessionId) => {
          for (const workspace of workspaces) {
            if (workspace !== null && typeof workspace === 'object' && Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) return workspace;
          }
          return undefined;
        };

        const rows = (Array.isArray(state.items) ? state.items : EMPTY_ARRAY).map((item) => {
          const summary = sessionById !== null && typeof sessionById === 'object' ? sessionById[item.id] : undefined;
          const workspace = workspaceFor(item.id);
          const displayTitle = typeof summary?.displayTitle === 'string' && summary.displayTitle !== ''
            ? summary.displayTitle
            : (typeof summary?.title === 'string' && summary.title !== '' ? summary.title : '');
          return {
            ...item,
            title: displayTitle === '' ? T('list.untitled') : displayTitle,
            updatedAt: summary?.updatedAt,
            workspaceTitle: typeof workspace?.title === 'string' && workspace.title !== ''
              ? workspace.title
              : (typeof item.workspaceTitle === 'string' && item.workspaceTitle !== '' ? item.workspaceTitle : T('list.workspaceUnknown')),
          };
        });

        const existing = new Set(rows.map((row) => row.id));
        const selectedIds = [...selected].filter((id) => existing.has(id));
        const selectedSet = new Set(selectedIds);
        const pendingIds = new Set(rows.filter((row) => row.pending !== undefined).map((row) => row.id));
        const selectedReady = selectedIds.filter((id) => !pendingIds.has(id));
        const selectedPending = selectedIds.filter((id) => pendingIds.has(id));
        const selectable = rows.filter((row) => row.duplicate !== true).map((row) => row.id);
        const allSelected = selectable.length > 0 && selectable.every((id) => selectedSet.has(id));

        const toggleOne = (id) => {
          setSelected((previous) => {
            const next = new Set(previous);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
        };
        const toggleAll = () => {
          setSelected(allSelected ? new Set() : new Set(selectable));
        };

        const showError = (message) => setNotice({ tone: 'error', text: message });
        const showSuccess = (text) => setNotice({ tone: 'success', text });
        /**
         * Rebuild the sidebar's session list after this page changed sessions on
         * disk. Without it the native list keeps rendering rows for sessions this
         * plugin already removed, and those rows cannot be archived or deleted.
         */
        const refreshSessionList = async () => {
          try {
            const service = ctx.sessions;
            if (service !== undefined && typeof service.refresh === 'function') await service.refresh();
          } catch {
            /* the next page load rebuilds the list anyway */
          }
        };

        const unarchiveSelected = async () => {
          if (selectedIds.length === 0 || busy !== null) return;
          setBusy('unarchive');
          setNotice(null);
          setFailures(EMPTY_ARRAY);
          const failed = [];
          const unarchived = [];
          for (const id of selectedIds) {
            try {
              await ctx.workspaces.unarchiveSession(id);
              unarchived.push(id);
            } catch (error) {
              failed.push({ id, message: error instanceof Error ? error.message : String(error) });
            }
          }
          // Unarchiving a pending deletion cancels it immediately; the queue is
          // only an intent, so there is nothing to restore.
          const pendingUnarchived = unarchived.filter((id) => pendingIds.has(id));
          if (pendingUnarchived.length > 0) {
            try {
              await postJson(CANCEL_PENDING_URL, { ids: pendingUnarchived });
            } catch {
              /* the startup sweep also drops intents for unarchived sessions */
            }
          }
          await refreshSessionList();
          setBusy(null);
          setSelected(new Set());
          setFailures(failed);
          if (failed.length === 0) showSuccess(T('notice.unarchive', { ok: unarchived.length, failed: 0 }));
          else setNotice({ tone: 'warn', text: T('notice.unarchive', { ok: unarchived.length, failed: failed.length }) });
          await reload();
        };

        /**
         * Cancel queued deletions. The queue only records intent, so this never
         * deletes or restores files and is always safe.
         * @param {string[]} ids ids to cancel
         */
        const cancelPendingIds = async (ids) => {
          if (ids.length === 0 || busy !== null) return;
          setBusy('cancel');
          setNotice(null);
          setFailures(EMPTY_ARRAY);
          try {
            const result = await postJson(CANCEL_PENDING_URL, { ids });
            const cancelled = result.totals?.cancelled ?? 0;
            setSelected((previous) => {
              const next = new Set(previous);
              for (const id of ids) next.delete(id);
              return next;
            });
            showSuccess(T('notice.cancelled', { count: cancelled }));
            await reload();
          } catch (error) {
            showError(T('error.cancelPending', { message: error instanceof Error ? error.message : String(error) }));
          }
          setBusy(null);
        };

        const openDeleteDialog = async () => {
          const ids = selectedReady;
          if (ids.length === 0 || busy !== null) return;
          setBusy('plan');
          setNotice(null);
          setFailures(EMPTY_ARRAY);
          try {
            const plan = await postJson(DELETE_URL, { ids, dryRun: true, cleanupAttachments: defaultCleanup });
            if ((plan.totals?.count ?? 0) === 0) {
              showError(T('confirm.empty'));
              setBusy(null);
              return;
            }
            setDialog({ ids, plan, cleanupAttachments: defaultCleanup, acknowledged: false });
          } catch (error) {
            showError(T('error.deletePlan', { message: error instanceof Error ? error.message : String(error) }));
          }
          setBusy(null);
        };

        const confirmDelete = async () => {
          if (dialog === null || dialog.acknowledged !== true || busy !== null) return;
          setBusy('delete');
          setNotice(null);
          try {
            const result = await postJson(DELETE_URL, {
              ids: dialog.ids,
              dryRun: false,
              cleanupAttachments: dialog.cleanupAttachments,
            });
            const totals = result.totals ?? { deleted: 0, queued: 0, failed: 0, freedBytes: 0 };
            let text = T('notice.delete', {
              deleted: totals.deleted ?? 0,
              freed: formatBytes(totals.freedBytes ?? 0),
              failed: totals.failed ?? 0,
            });
            if ((totals.queued ?? 0) > 0) text += ` ${T('notice.queued', { count: totals.queued })}`;
            const attachment = result.attachment ?? {};
            if (typeof attachment.deleted === 'number' && attachment.deleted > 0) {
              text += ` ${T('notice.attachmentsCleared', { count: attachment.deleted, size: formatBytes(attachment.freedBytes ?? 0) })}`;
            } else if (typeof attachment.skipped === 'string' && attachment.skipped !== 'no-candidates' && attachment.skipped !== 'disabled') {
              const reasonKey = {
                'reference-scan-unavailable': 'skip.scanUnavailable',
                'read-failed': 'skip.scanUnavailable',
                'listing-failed': 'skip.listingFailed',
                'session-budget': 'skip.budget',
                'event-budget': 'skip.budget',
                'time-budget': 'skip.budget',
              }[attachment.skipped] ?? 'skip.scanUnavailable';
              text += ` ${T('notice.attachmentsSkipped', { reason: translate(reasonKey) })}`;
            }
            setDialog(null);
            setSelected(new Set());
            const failedRows = (Array.isArray(result.results) ? result.results : [])
              .filter((row) => row.deleted !== true && row.queued !== true)
              .map((row) => ({ id: row.id, message: row.message ?? row.code ?? 'failed' }));
            setFailures(failedRows);
            if ((totals.failed ?? 0) === 0) showSuccess(text);
            else setNotice({ tone: 'warn', text });
            await refreshSessionList();
            await reload();
          } catch (error) {
            showError(T('error.delete', { message: error instanceof Error ? error.message : String(error) }));
            await refreshSessionList();
          }
          setBusy(null);
        };

        const banner = (tone) => ({
          className: `dsa-banner dsa-banner-${tone}`,
          role: 'status',
          'aria-live': 'polite',
        });

        const header = h('div', { className: 'dsa-header' }, [
          h('div', { key: 'heading', className: 'dsa-heading' }, [
            h('h1', { key: 'title', className: 'dsa-title' }, T('page.title')),
            h('p', { key: 'sub', className: 'dsa-subtitle' }, [
              T('page.subtitle', { count: state.totals?.count ?? rows.length, size: formatBytes(state.totals?.bytes ?? 0) }),
              (state.totals?.descendants ?? 0) > 0
                ? ` · ${T('page.subtitleDescendants', { descendants: state.totals.descendants })}`
                : '',
            ]),
          ]),
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'dsa-btn',
            onClick: () => { reload(); },
            disabled: busy !== null,
          }, T('toolbar.refresh')),
        ]);

        const toolbar = h('div', { className: 'dsa-toolbar' }, [
          h('input', {
            key: 'checkall',
            type: 'checkbox',
            className: 'dsa-check',
            checked: allSelected,
            ref: (element) => {
              if (element !== null) element.indeterminate = selectedIds.length > 0 && !allSelected;
            },
            onChange: toggleAll,
            disabled: selectable.length === 0 || busy !== null,
            'aria-label': T('toolbar.selectAll'),
          }),
          h('span', { key: 'label', className: 'dsa-count' }, T('toolbar.selectAll')),
          h('span', { key: 'count', className: 'dsa-count' }, T('toolbar.selected', { count: selectedIds.length })),
          h('span', { key: 'spacer', className: 'dsa-spacer' }),
          h('button', {
            key: 'cancel-pending',
            type: 'button',
            className: 'dsa-btn',
            onClick: () => cancelPendingIds(selectedPending),
            disabled: selectedPending.length === 0 || busy !== null,
          }, busy === 'cancel' ? T('confirm.busy') : T('action.cancelPending')),
          h('button', {
            key: 'unarchive',
            type: 'button',
            className: 'dsa-btn',
            onClick: unarchiveSelected,
            disabled: selectedIds.length === 0 || busy !== null,
          }, busy === 'unarchive' ? T('confirm.busy') : T('toolbar.unarchive')),
          h('button', {
            key: 'delete',
            type: 'button',
            className: 'dsa-btn dsa-btn-danger',
            onClick: openDeleteDialog,
            disabled: selectedReady.length === 0 || busy !== null,
          }, busy === 'plan' ? T('confirm.busy') : T('toolbar.delete')),
        ]);

        const notices = [];
        if (state.error !== null && state.phase === 'ready') {
          notices.push(h('div', { key: 'load-error', className: 'dsa-banner dsa-banner-error', role: 'status' },
            h('span', { className: 'dsa-banner-text' }, `${T('error.title')}: ${state.error}`),
            h('button', { type: 'button', className: 'dsa-banner-close', onClick: () => { reload(); } }, T('error.retry'))));
        }
        if (notice !== null) {
          notices.push(h('div', { key: 'notice', ...banner(notice.tone) },
            h('span', { className: 'dsa-banner-text' }, notice.text),
            h('button', { type: 'button', className: 'dsa-banner-close', onClick: () => setNotice(null) }, T('notice.close'))));
        }

        const list = state.phase === 'loading'
          ? h('div', { className: 'dsa-loading' }, T('loading'))
          : state.phase === 'error'
            ? h('div', { className: 'dsa-banner dsa-banner-error', role: 'status' },
              h('span', { className: 'dsa-banner-text' }, `${T('error.title')}: ${state.error ?? ''}`),
              h('button', { type: 'button', className: 'dsa-banner-close', onClick: () => { reload(); } }, T('error.retry')))
            : rows.length === 0
              ? h('div', { className: 'dsa-empty' }, [
                h('div', { key: 't', className: 'dsa-empty-title' }, T('empty.title')),
                h('div', { key: 'h', className: 'dsa-empty-hint' }, T('empty.hint')),
              ])
              : h('div', { className: 'dsa-list' }, rows.map((row) => {
                const pending = row.pending;
                const tags = [];
                if (pending !== undefined) {
                  tags.push(h('span', { key: 'pending', className: 'dsa-tag dsa-tag-warn', title: T('pending.hint') }, T('tag.pending')));
                  if (typeof pending.lastError === 'string' && pending.lastError !== '') {
                    tags.push(h('span', { key: 'pending-failed', className: 'dsa-tag dsa-tag-warn', title: pending.lastError }, T('tag.pendingFailed')));
                  }
                }
                if (row.hasLog === false) tags.push(h('span', { key: 'missing', className: 'dsa-tag dsa-tag-warn' }, T('tag.missingLog')));
                if (row.duplicate === true) tags.push(h('span', { key: 'dup', className: 'dsa-tag dsa-tag-warn' }, T('tag.duplicate')));
                const time = formatTime(row.updatedAt);
                return h('div', { key: row.id, className: 'dsa-row' }, [
                  h('input', {
                    key: 'check',
                    type: 'checkbox',
                    className: 'dsa-check',
                    checked: selectedSet.has(row.id),
                    onChange: () => toggleOne(row.id),
                    disabled: row.duplicate === true || busy !== null,
                    'aria-label': `${T('list.select')}: ${row.title}`,
                  }),
                  h('div', { key: 'main', className: 'dsa-row-main' }, [
                    h('div', { key: 'title', className: 'dsa-row-title' }, row.title),
                    h('div', { key: 'meta', className: 'dsa-row-meta' }, [
                      h('span', { key: 'ws' }, row.workspaceTitle),
                      time === '' ? null : h('span', { key: 'time' }, time),
                      ...tags,
                    ].filter((value) => value !== null)),
                  ]),
                  pending === undefined ? null : h('button', {
                    key: 'cancel-pending-row',
                    type: 'button',
                    className: 'dsa-link',
                    onClick: () => cancelPendingIds([row.id]),
                    disabled: busy !== null,
                  }, T('action.cancelPendingRow')),
                  h('div', { key: 'size', className: 'dsa-size' }, formatBytes(row.totalBytes)),
                ].filter((value) => value !== null));
              }));

        const failuresBlock = failures.length === 0 ? null : h('div', { className: 'dsa-failures' }, [
          h('div', { key: 'title', className: 'dsa-failure-title' }, T('result.failed')),
          ...failures.map((failure, index) => h('div', { key: `${failure.id}-${index}`, className: 'dsa-failure-row' }, `${failure.id}: ${failure.message}`)),
        ]);

        const dialogElement = dialog === null ? null : (() => {
          const plan = dialog.plan ?? {};
          const totals = plan.totals ?? { count: 0, bytes: 0, descendants: 0, immediate: 0, queued: 0 };
          const invalid = (Array.isArray(plan.items) ? plan.items : []).filter((item) => item.ok !== true);
          return h('div', {
            className: 'dsa-overlay',
            onMouseDown: (event) => {
              if (event.target === event.currentTarget && busy === null) setDialog(null);
            },
          }, h('div', {
            className: 'dsa-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'dsa-dialog-title',
          }, [
            h('h2', { key: 'title', id: 'dsa-dialog-title', className: 'dsa-dialog-title' }, T('confirm.title', { count: totals.count ?? 0 })),
            h('p', { key: 'body', className: 'dsa-dialog-body' }, T('confirm.body')),
            h('p', { key: 'size', className: 'dsa-dialog-meta' }, T('confirm.size', { size: formatBytes(totals.bytes ?? 0) })),
            (totals.descendants ?? 0) > 0
              ? h('p', { key: 'desc', className: 'dsa-dialog-meta' }, T('confirm.descendants', { count: totals.descendants }))
              : null,
            (totals.immediate ?? 0) > 0
              ? h('p', { key: 'immediate', className: 'dsa-dialog-meta' }, T('confirm.immediate', { count: totals.immediate }))
              : null,
            (totals.queued ?? 0) > 0
              ? h('p', { key: 'queued', className: 'dsa-dialog-meta' }, T('confirm.queued', { count: totals.queued }))
              : null,
            (totals.queued ?? 0) > 0
              ? h('p', { key: 'pending-hint', className: 'dsa-dialog-meta' }, T('confirm.pendingHint'))
              : null,
            invalid.length === 0 ? null : h('div', { key: 'invalid', className: 'dsa-dialog-section' }, [
              h('p', { key: 'title', className: 'dsa-dialog-section-title' }, T('confirm.invalid')),
              h('ul', { key: 'list', className: 'dsa-invalid' }, invalid.map((item) => h('li', { key: item.id }, `${item.id}: ${item.message ?? item.code ?? ''}`))),
            ]),
            h('div', { key: 'attach', className: 'dsa-dialog-section' }, [
              h('label', { key: 'label', className: 'dsa-option' }, [
                h('input', {
                  key: 'check',
                  type: 'checkbox',
                  checked: dialog.cleanupAttachments,
                  disabled: busy !== null,
                  onChange: (event) => setDialog((previous) => (previous === null ? previous : { ...previous, cleanupAttachments: event.target.checked })),
                }),
                h('span', { key: 'text' }, T('confirm.attach')),
              ]),
              h('p', { key: 'hint', className: 'dsa-option-hint' }, T('confirm.attachHint')),
            ]),
            h('label', { key: 'ack', className: 'dsa-option' }, [
              h('input', {
                key: 'check',
                type: 'checkbox',
                checked: dialog.acknowledged,
                disabled: busy !== null,
                onChange: (event) => setDialog((previous) => (previous === null ? previous : { ...previous, acknowledged: event.target.checked })),
              }),
              h('span', { key: 'text' }, T('confirm.ack')),
            ]),
            h('div', { key: 'actions', className: 'dsa-dialog-actions' }, [
              h('button', {
                key: 'cancel',
                ref: cancelRef,
                type: 'button',
                className: 'dsa-btn',
                onClick: () => { if (busy === null) setDialog(null); },
                disabled: busy !== null,
              }, T('confirm.cancel')),
              h('button', {
                key: 'confirm',
                type: 'button',
                className: 'dsa-btn dsa-btn-danger-solid',
                onClick: confirmDelete,
                disabled: dialog.acknowledged !== true || busy !== null,
              }, busy === 'delete' ? T('confirm.busy') : T('confirm.confirm')),
            ]),
          ]));
        })();

        return h('div', { className: 'dsa-page' }, [
          h('style', { key: 'css' }, CSS),
          h('div', { key: 'inner', className: 'dsa-inner' }, [
            header,
            toolbar,
            ...notices,
            list,
            failuresBlock,
          ]),
          dialogElement,
        ]);
      };
    }

    /**
     * Archive-box glyph used by the sidebar panel row.
     * @param {{ size?: number, active?: boolean }} props owner presentation
     * @returns {object} svg element
     */
    function PanelIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, [
        h('rect', { key: 'lid', x: 3, y: 4, width: 18, height: 4.2, rx: 1.2 }),
        h('path', { key: 'body', d: 'M5.2 8.2v10.1c0 1 .8 1.7 1.7 1.7h10.2c.9 0 1.7-.7 1.7-1.7V8.2' }),
        h('path', { key: 'handle', d: 'M10 12.2h4' }),
      ]);
    }

    /**
     * Browser plugin body.
     * @param {import('@deepseek-ai/cordis').Context} ctx browser plugin context
     * @returns {void}
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-admin: dictionaries');
      const t = ctx.locale.bind(NS);
      const Page = createPage(ctx, t);
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      }, Page));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        locale: NS,
        label: () => t('panel'),
      }, PanelIcon));
    }

    const inject = ['slots', 'locale', 'workspaces', 'sessions'];
    return { inject, apply };
  },
});
