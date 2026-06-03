/* ============================================================================
 * Webinar Admin — static (browser-only) version.
 *
 * Mirrors the Next.js app, but with no server: the browser talks to Supabase
 * directly using the public anon key. All data access is therefore subject to
 * your Row Level Security (RLS) policies (the Next.js app used a server-side
 * service-role key that bypassed RLS, so behaviour can differ where RLS is
 * restrictive). Query/filter/sort/paginate/CSV logic is ported 1:1 from
 * lib/query.ts, app/api/data/route.ts and app/api/export/route.ts.
 * ==========================================================================*/

/* ---------------- display + whitelist config (from lib/schema.ts, lib/sources.ts) ---------------- */
const SOURCES = [
  { name: 'webinar_registrants', label: 'Registrants — table' },
  { name: 'webinar_events', label: 'Events — table' },
  { name: 'v_all_registrants', label: 'All registrants — view' },
  { name: 'v_registered', label: 'Registered — view' },
  { name: 'v_unregistered', label: 'Unregistered — view' },
  { name: 'v_no_show', label: 'No-shows — view' },
];
const SEARCH_COLUMNS = ['email', 'first_name', 'last_name', 'name', 'phone'];
const ENUM_FILTERS = [
  { key: 'registration_status', label: 'Reg Status', options: ['Registered', 'Not Registered'] },
  { key: 'traffic_first_source', label: 'First Source', options: ['Organic', 'Paid', 'Email', 'Unknown'] },
  { key: 'traffic_last_source', label: 'Last Source', options: ['Organic', 'Paid', 'Email'] },
  { key: 'webinar_status', label: 'Webinar Status', options: ['Scheduled', 'Webinar Live', 'Ended'] },
];
const BOOL_FILTERS = [
  { key: 'is_registrant', label: 'Registrant' },
  { key: 'is_attendee', label: 'Attendee' },
  { key: 'is_no_show', label: 'No Show' },
];
const AUTO_COLUMNS = ['id', 'created_at', 'updated_at'];
const FIELD_TYPES = {
  webinar_status: { type: 'enum', options: ['Scheduled', 'Webinar Live', 'Ended'] },
  webinar_date: { type: 'date' },
  webinar_date_time: { type: 'datetime' },
  end_date: { type: 'datetime' },
  registration_status: { type: 'enum', options: ['Registered', 'Not Registered'] },
  traffic_first_source: { type: 'enum', options: ['Organic', 'Paid', 'Email', 'Unknown'] },
  traffic_last_source: { type: 'enum', options: ['Organic', 'Paid', 'Email'] },
  registration_date: { type: 'datetime' },
  cf_registration_date_time: { type: 'datetime' },
  created_airtable: { type: 'datetime' },
  last_modified_airtable: { type: 'datetime' },
};
const BOOL_COLUMNS = [
  'is_registrant', 'is_attendee', 'is_no_show', 'two_hours_passed',
  'linked', 'conversion_record_needed', 'this_week',
];
const PAGE_SIZES = [25, 50, 100, 200];

const TABLES = ['webinar_registrants', 'webinar_events'];
const IDENT = /^[a-z_][a-z0-9_]*$/;
const isValidIdent = (n) => IDENT.test(n);
const isWritable = (n) => TABLES.includes(n);
const EXPORT_CAP = 10000;

/* ---------------- Supabase client ---------------- */
const cfg = window.APP_CONFIG || {};
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

/* ---------------- small helpers ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'disabled') { if (v) node.disabled = true; }
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString();

/* ============================================================================
 * Auth gating — swap between login + app views based on Supabase session.
 * ==========================================================================*/
const loginView = $('#login-view');
const appView = $('#app-view');
let explorer = null;

function applyAuth(user) {
  if (user) {
    loginView.hidden = true;
    appView.hidden = false;
    if (!explorer) explorer = new Explorer(appView, user.email || '');
  } else {
    appView.hidden = true;
    loginView.hidden = false;
    explorer = null;
    appView.innerHTML = '';
  }
}

async function refreshAuth() {
  // getSession() reads the persisted session from storage (no network round-trip
  // that can hang). Always fall back to the login view on error so we never get
  // stuck on a blank page.
  try {
    const { data } = await sb.auth.getSession();
    applyAuth(data?.session?.user ?? null);
  } catch {
    applyAuth(null);
  }
}

/* ---- login form ---- */
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#loginBtn');
  const errBox = $('#loginError');
  errBox.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  const { error } = await sb.auth.signInWithPassword({
    email: $('#loginEmail').value,
    password: $('#loginPassword').value,
  });
  btn.disabled = false;
  btn.textContent = 'Sign in';
  if (error) {
    errBox.textContent = error.message;
    errBox.hidden = false;
    return;
  }
  await refreshAuth();
});

// IMPORTANT: do NOT call other supabase auth methods (getUser/getSession) inside
// this callback — it runs while the auth lock is held and would deadlock, leaving
// the page blank on refresh. Use the session handed to us directly. This fires
// INITIAL_SESSION on load with the persisted session, then on every sign in/out.
sb.auth.onAuthStateChange((_event, session) => applyAuth(session?.user ?? null));
refreshAuth();

/* ============================================================================
 * Query building — ported from lib/query.ts (parseDataParams / applyDataFilters)
 * ==========================================================================*/
const ALLOWED_OPS = new Set(['eq', 'neq', 'gte', 'lte', 'gt', 'lt', 'ilike', 'is']);
function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  return v;
}
// Apply search + filter clauses to a supabase query builder (same semantics as the API).
function applyDataFilters(qb, p) {
  if (p.q && p.searchCols.length) {
    const safe = p.q.replace(/[%,()]/g, ' ');
    qb = qb.or(p.searchCols.map((c) => `${c}.ilike.%${safe}%`).join(','));
  }
  for (const f of p.filters) {
    const val = coerce(f.val);
    switch (f.op) {
      case 'eq': qb = qb.eq(f.col, val); break;
      case 'neq': qb = qb.neq(f.col, val); break;
      case 'gte': qb = qb.gte(f.col, val); break;
      case 'lte': qb = qb.lte(f.col, val); break;
      case 'gt': qb = qb.gt(f.col, val); break;
      case 'lt': qb = qb.lt(f.col, val); break;
      case 'ilike': qb = qb.ilike(f.col, `%${val}%`); break;
      case 'is': qb = qb.is(f.col, val); break;
    }
  }
  return qb;
}

/* ============================================================================
 * Explorer — ported from components/Explorer.tsx
 * ==========================================================================*/
class Explorer {
  constructor(root, userEmail) {
    this.root = root;
    this.userEmail = userEmail;

    this.source = 'webinar_registrants';
    this.searchInput = '';
    this.q = '';
    this.filters = {};
    this.bools = {};
    this.dateFrom = '';
    this.dateTo = '';
    this.sort = 'id';
    this.order = 'desc';
    this.page = 1;
    this.pageSize = 50;

    this.data = null;
    this.columns = [];
    this.loading = false;
    this.error = null;

    this.drawer = null;        // 'view' | 'edit' | 'create' | null
    this.drawerRow = null;
    this.saving = false;

    this.reqId = 0;
    this.searchTimer = null;

    this.STORAGE_KEY = 'webinar-admin:view';
    this.restore();
    this.render();
    this.fetchData();
  }

  /* ---- persistence (localStorage) ---- */
  restore() {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      // Only restore a saved source if it still exists as a tab — otherwise a
      // since-removed source (e.g. an old view name) would fetch and 404.
      if (typeof s.source === 'string' && SOURCES.some((src) => src.name === s.source)) this.source = s.source;
      if (s.filters && typeof s.filters === 'object') this.filters = s.filters;
      if (s.bools && typeof s.bools === 'object') this.bools = s.bools;
      if (typeof s.dateFrom === 'string') this.dateFrom = s.dateFrom;
      if (typeof s.dateTo === 'string') this.dateTo = s.dateTo;
      if (typeof s.sort === 'string') this.sort = s.sort;
      if (s.order === 'asc' || s.order === 'desc') this.order = s.order;
      if (typeof s.pageSize === 'number') this.pageSize = s.pageSize;
      if (typeof s.searchInput === 'string') { this.searchInput = s.searchInput; this.q = s.searchInput.trim(); }
      if (typeof s.page === 'number') this.page = s.page;
    } catch { /* ignore malformed storage */ }
  }
  persist() {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify({
        source: this.source, filters: this.filters, bools: this.bools,
        dateFrom: this.dateFrom, dateTo: this.dateTo, sort: this.sort,
        order: this.order, page: this.page, pageSize: this.pageSize, searchInput: this.searchInput,
      }));
    } catch { /* storage unavailable — non-fatal */ }
  }

  get presentSearchCols() { return SEARCH_COLUMNS.filter((c) => this.columns.includes(c)); }
  get writable() { return this.data?.writable ?? false; }

  buildParams() {
    const filters = [];
    for (const [k, v] of Object.entries(this.filters)) if (v) filters.push({ col: k, op: 'eq', val: v });
    for (const [k, v] of Object.entries(this.bools)) if (v) filters.push({ col: k, op: 'eq', val: v });
    if (this.dateFrom && this.columns.includes('registration_date'))
      filters.push({ col: 'registration_date', op: 'gte', val: this.dateFrom });
    if (this.dateTo && this.columns.includes('registration_date'))
      filters.push({ col: 'registration_date', op: 'lte', val: this.dateTo });
    return {
      q: this.q && this.presentSearchCols.length ? this.q : '',
      searchCols: this.presentSearchCols,
      filters,
      sort: isValidIdent(this.sort) ? this.sort : 'id',
      order: this.order === 'asc' ? 'asc' : 'desc',
    };
  }

  /* ---- data fetch (replaces GET /api/data) ---- */
  async fetchData() {
    const id = ++this.reqId;
    this.loading = true;
    this.error = null;
    this.renderBusy();
    try {
      const p = this.buildParams();
      const from = (this.page - 1) * this.pageSize;
      const to = from + this.pageSize - 1;
      let query = sb.from(this.source).select('*', { count: 'exact' });
      query = applyDataFilters(query, p);
      query = query.order(p.sort, { ascending: p.order === 'asc', nullsFirst: false }).range(from, to);
      const { data, count, error } = await query;
      if (id !== this.reqId) return;
      if (error) throw error;
      this.data = {
        rows: data ?? [],
        total: count ?? 0,
        page: this.page,
        pageSize: this.pageSize,
        totalPages: count ? Math.ceil(count / this.pageSize) : 0,
        writable: isWritable(this.source),
      };
      if (this.data.rows.length) this.columns = Object.keys(this.data.rows[0]);
    } catch (e) {
      if (id !== this.reqId) return;
      this.error = e.message ?? String(e);
      this.data = null;
    } finally {
      if (id === this.reqId) {
        this.loading = false;
        this.persist();
        this.render();
      }
    }
  }

  /* ---- state transitions ---- */
  changeSource(next) {
    this.source = next; this.columns = []; this.filters = {}; this.bools = {};
    this.dateFrom = ''; this.dateTo = ''; this.searchInput = ''; this.q = '';
    this.sort = 'id'; this.order = 'desc'; this.page = 1;
    this.render(); this.fetchData();
  }
  toggleSort(col) {
    if (this.sort === col) this.order = this.order === 'asc' ? 'desc' : 'asc';
    else { this.sort = col; this.order = 'asc'; }
    this.page = 1; this.fetchData();
  }
  setPage(p) { this.page = p; this.fetchData(); }
  clearFilters() {
    this.filters = {}; this.bools = {}; this.dateFrom = ''; this.dateTo = '';
    this.searchInput = ''; this.q = ''; this.page = 1;
    this.render(); this.fetchData();
  }
  onSearchInput(v) {
    this.searchInput = v;
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.q = this.searchInput.trim(); this.page = 1; this.fetchData();
    }, 350);
  }

  get activeFilters() {
    let n = 0;
    if (this.q) n++;
    n += Object.values(this.filters).filter(Boolean).length;
    n += Object.values(this.bools).filter(Boolean).length;
    if (this.dateFrom) n++;
    if (this.dateTo) n++;
    return n;
  }

  async logout() {
    await sb.auth.signOut();
    refreshAuth();
  }

  /* ---- toasts ---- */
  toast(msg, kind = 'ok') {
    const box = $('.toasts', this.root);
    if (!box) return;
    const node = el('div', { class: `toast ${kind}` }, [msg]);
    box.appendChild(node);
    setTimeout(() => node.remove(), 3800);
  }

  /* ---- CRUD (replaces POST/PATCH/DELETE /api/data) ---- */
  openCreate() {
    const blank = {};
    this.columns.forEach((c) => (blank[c] = ''));
    this.drawerRow = blank; this.drawer = 'create'; this.render();
  }
  openRow(row) { this.drawerRow = row; this.drawer = this.writable ? 'edit' : 'view'; this.render(); }
  closeDrawer() { this.drawer = null; this.drawerRow = null; this.render(); }

  sanitize(values) {
    const out = {};
    for (const [k, v] of Object.entries(values)) {
      if (!isValidIdent(k)) continue;
      out[k] = v === '' ? null : v;
    }
    return Object.keys(out).length ? out : null;
  }

  async saveDrawer() {
    const form = $('#drawerForm', this.root);
    if (!form) return;
    const values = {};
    form.querySelectorAll('[data-col]').forEach((node) => {
      const col = node.getAttribute('data-col');
      const v = node.value;
      values[col] = v === '' ? null : v === 'true' ? true : v === 'false' ? false : v;
    });
    const clean = this.sanitize(values);
    if (!clean) { this.toast('No values provided', 'err'); return; }
    this.saving = true; this.render();
    try {
      if (this.drawer === 'create') {
        const { error } = await sb.from(this.source).insert(clean).select();
        if (error) throw error;
        this.toast(this.source === 'webinar_events' ? 'Webinar created' : 'Row created', 'ok');
        if (this.source === 'webinar_events') {
          this.toast('Note: the n8n backfill webhook only runs in the server version.', 'ok');
        }
      } else {
        delete clean.id;
        const { error } = await sb.from(this.source).update(clean).eq('id', this.drawerRow.id).select();
        if (error) throw error;
        this.toast('Row updated', 'ok');
      }
      this.drawer = null; this.drawerRow = null;
      await this.fetchData();
    } catch (e) {
      this.toast(e.message ?? String(e), 'err');
    } finally {
      this.saving = false; this.render();
    }
  }

  async deleteRow(row) {
    if (!confirm(`Delete row id ${row.id}? This cannot be undone.`)) return;
    try {
      const { error } = await sb.from(this.source).delete().eq('id', row.id);
      if (error) throw error;
      this.toast('Row deleted', 'ok');
      await this.fetchData();
    } catch (e) {
      this.toast(e.message ?? String(e), 'err');
    }
  }

  /* ---- CSV export (replaces GET /api/export) — runs entirely client-side ---- */
  async exportCsv() {
    this.toast('Building CSV…', 'ok');
    try {
      const p = this.buildParams();
      const csvCell = (v) => {
        if (v === null || v === undefined) return '';
        const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const lines = [];
      let header = null;
      const batch = 1000;
      let fetched = 0;
      while (fetched < EXPORT_CAP) {
        const from = fetched;
        const to = Math.min(fetched + batch, EXPORT_CAP) - 1;
        let query = sb.from(this.source).select('*');
        query = applyDataFilters(query, p);
        query = query.order(p.sort, { ascending: p.order === 'asc', nullsFirst: false }).range(from, to);
        const { data, error } = await query;
        if (error) throw error;
        if (!data || data.length === 0) break;
        if (!header) { header = Object.keys(data[0]); lines.push(header.join(',')); }
        for (const row of data) lines.push(header.map((c) => csvCell(row[c])).join(','));
        fetched += data.length;
        if (data.length < batch) break;
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: `${this.source}_export.csv` });
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      this.toast(e.message ?? String(e), 'err');
    }
  }

  /* ---- lightweight busy indicator without a full re-render ---- */
  renderBusy() {
    const spin = $('.topbar .spin', this.root);
    if (this.loading && !spin) {
      const badge = $('.topbar .badge', this.root);
      if (badge) badge.parentNode.insertBefore(el('span', { class: 'spin' }), badge);
    } else if (!this.loading && spin) {
      spin.remove();
    }
  }

  /* ---- cell formatter (mirrors fmtCell) ---- */
  cell(v) {
    if (v === null || v === undefined) return el('span', { class: 'pill gray' }, ['—']);
    if (v === true) return el('span', { class: 'bool-yes' }, ['✔']);
    if (v === false) return el('span', { class: 'bool-no' }, ['—']);
    if (typeof v === 'object') return document.createTextNode(JSON.stringify(v));
    return document.createTextNode(String(v));
  }

  /* ---- full render ---- */
  render() {
    const d = this.data;
    const total = d?.total ?? 0;
    const totalPages = d?.totalPages ?? 0;
    const fromRow = total ? (this.page - 1) * this.pageSize + 1 : 0;
    const toRow = Math.min(this.page * this.pageSize, total);
    const writable = this.writable;

    const app = el('div', { class: 'app' });

    /* topbar */
    const topbar = el('div', { class: 'topbar' });
    topbar.appendChild(el('div', { class: 'brand' }, [
      el('span', { class: 'logo' }, ['▦']),
      el('h1', {}, ['Webinar Admin']),
    ]));
    const search = el('input', {
      class: 'search', placeholder: 'Search email, name, phone…', value: this.searchInput,
      oninput: (e) => this.onSearchInput(e.target.value),
    });
    topbar.appendChild(search);
    topbar.appendChild(el('span', { class: 'spacer' }));
    if (this.loading) topbar.appendChild(el('span', { class: 'spin' }));
    topbar.appendChild(el('span', { class: 'badge' }, [`${fmt(total)} rows`]));
    topbar.appendChild(el('span', { class: `badge ${writable ? 'rw' : 'ro'}` }, [writable ? 'editable' : 'read-only']));
    topbar.appendChild(el('button', { onclick: () => this.exportCsv() }, ['⬇ Export CSV']));
    if (writable) {
      topbar.appendChild(el('button', { class: 'primary', onclick: () => this.openCreate() },
        [this.source === 'webinar_events' ? '+ New webinar' : '+ New']));
    }
    topbar.appendChild(el('span', { class: 'userbar' }, [
      el('span', { class: 'who' }, [this.userEmail]),
      el('button', { onclick: () => this.logout() }, ['Log out']),
    ]));
    app.appendChild(topbar);

    /* tabstrip */
    const tabs = el('div', { class: 'tabstrip' });
    SOURCES.forEach((s) => {
      tabs.appendChild(el('button', {
        class: `tab ${this.source === s.name ? 'active' : ''}`,
        onclick: () => this.source !== s.name && this.changeSource(s.name),
      }, [s.label]));
    });
    app.appendChild(tabs);

    /* filter bar */
    const fbar = el('div', { class: 'filterbar' });
    ENUM_FILTERS.filter((f) => this.columns.includes(f.key)).forEach((f) => {
      const sel = el('select', {
        onchange: (e) => { this.filters[f.key] = e.target.value; this.page = 1; this.fetchData(); },
      }, [el('option', { value: '' }, ['All']), ...f.options.map((o) => el('option', { value: o }, [o]))]);
      sel.value = this.filters[f.key] ?? '';
      fbar.appendChild(el('div', { class: 'field' }, [el('label', {}, [f.label]), sel]));
    });
    BOOL_FILTERS.filter((b) => this.columns.includes(b.key)).forEach((b) => {
      const sel = el('select', {
        onchange: (e) => { this.bools[b.key] = e.target.value; this.page = 1; this.fetchData(); },
      }, [el('option', { value: '' }, ['All']), el('option', { value: 'true' }, ['Yes']), el('option', { value: 'false' }, ['No'])]);
      sel.value = this.bools[b.key] ?? '';
      fbar.appendChild(el('div', { class: 'field' }, [el('label', {}, [b.label]), sel]));
    });
    if (this.columns.includes('registration_date')) {
      fbar.appendChild(el('div', { class: 'field' }, [
        el('label', {}, ['Registered From']),
        el('input', { type: 'date', value: this.dateFrom, onchange: (e) => { this.dateFrom = e.target.value; this.page = 1; this.fetchData(); } }),
      ]));
      fbar.appendChild(el('div', { class: 'field' }, [
        el('label', {}, ['Registered To']),
        el('input', { type: 'date', value: this.dateTo, onchange: (e) => { this.dateTo = e.target.value; this.page = 1; this.fetchData(); } }),
      ]));
    }
    if (this.activeFilters > 0) {
      fbar.appendChild(el('div', { class: 'field' }, [
        el('label', {}, [document.createTextNode(' ')]),
        el('button', { class: 'btn-clear', onclick: () => this.clearFilters() }, [`✕ Clear (${this.activeFilters})`]),
      ]));
    }
    app.appendChild(fbar);

    /* table */
    const wrap = el('div', { class: 'table-wrap' });
    if (this.error) {
      wrap.appendChild(el('div', { class: 'state error' }, [`Error: ${this.error}`]));
    } else if (!d) {
      wrap.appendChild(el('div', { class: 'state' }, ['Loading…']));
    } else if (d.rows.length === 0) {
      wrap.appendChild(el('div', { class: 'state' }, ['No rows match.']));
    } else {
      const table = el('table');
      const headRow = el('tr');
      headRow.appendChild(el('th', { style: `min-width:${writable ? 110 : 60}px` }, ['actions']));
      this.columns.forEach((c) => {
        const th = el('th', { onclick: () => this.toggleSort(c) }, [c]);
        if (this.sort === c) th.appendChild(el('span', { class: 'sort-ind' }, [this.order === 'asc' ? '▲' : '▼']));
        headRow.appendChild(th);
      });
      table.appendChild(el('thead', {}, [headRow]));
      const tbody = el('tbody');
      d.rows.forEach((row) => {
        const tr = el('tr');
        const btns = el('td', { class: 'rowbtns' }, [
          el('button', { onclick: (e) => { e.stopPropagation(); this.openRow(row); } }, [writable ? 'Edit' : 'View']),
        ]);
        if (writable) btns.appendChild(el('button', { class: 'danger', onclick: (e) => { e.stopPropagation(); this.deleteRow(row); } }, ['Del']));
        tr.appendChild(btns);
        this.columns.forEach((c) => {
          const td = el('td', { title: String(row[c] ?? '') });
          td.appendChild(this.cell(row[c]));
          tr.appendChild(td);
        });
        tr.addEventListener('click', () => this.openRow(row));
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
    }
    app.appendChild(wrap);

    /* footer / pager */
    const footer = el('div', { class: 'footer' });
    const pager = el('div', { class: 'pager' }, [
      el('button', { disabled: this.page <= 1, onclick: () => this.setPage(1) }, ['« First']),
      el('button', { disabled: this.page <= 1, onclick: () => this.setPage(this.page - 1) }, ['‹ Prev']),
      el('span', { class: 'info' }, [`${fmt(fromRow)}–${fmt(toRow)} of ${fmt(total)}`]),
      el('button', { disabled: totalPages > 0 && this.page >= totalPages, onclick: () => this.setPage(this.page + 1) }, ['Next ›']),
      el('button', { disabled: totalPages > 0 && this.page >= totalPages, onclick: () => this.setPage(totalPages) }, ['Last »']),
    ]);
    footer.appendChild(pager);
    footer.appendChild(el('span', { class: 'spacer' }));
    const psSel = el('select', {
      onchange: (e) => { this.pageSize = Number(e.target.value); this.page = 1; this.fetchData(); },
    }, PAGE_SIZES.map((s) => el('option', { value: s }, [String(s)])));
    psSel.value = String(this.pageSize);
    footer.appendChild(el('div', { class: 'field', style: 'flex-direction:row;align-items:center;gap:6px' }, [
      el('label', { style: 'text-transform:none' }, ['Rows / page']), psSel,
    ]));
    app.appendChild(footer);

    /* toasts container (preserve existing toasts across re-render) */
    const existingToasts = $('.toasts', this.root);
    app.appendChild(existingToasts || el('div', { class: 'toasts' }));

    /* preserve search focus + caret across the re-render */
    const searchHadFocus = document.activeElement && document.activeElement.classList.contains('search');
    const caret = searchHadFocus ? document.activeElement.selectionStart : null;

    /* commit */
    this.root.innerHTML = '';
    this.root.appendChild(app);

    if (searchHadFocus) {
      search.focus();
      if (caret != null) try { search.setSelectionRange(caret, caret); } catch { /* non-text input */ }
    }

    /* drawer */
    if (this.drawer && this.drawerRow) this.renderDrawer();
  }

  /* ---- drawer (mirrors DrawerForm) ---- */
  renderDrawer() {
    const mode = this.drawer;
    const row = this.drawerRow;
    const ro = mode === 'view';
    const cols = mode === 'create' ? this.columns.filter((c) => !AUTO_COLUMNS.includes(c)) : this.columns;

    const inputFor = (col) => {
      const val = row[col];
      const disabled = ro || (mode === 'edit' && col === 'id');

      if (col === 'webinar_status' && mode === 'create') {
        const i = el('input', { class: 'field-in', 'data-col': col, disabled: true });
        i.value = 'Scheduled';
        return i;
      }
      if (BOOL_COLUMNS.includes(col)) {
        const s = el('select', { class: 'field-in', 'data-col': col, disabled }, [
          el('option', { value: '' }, ['(null)']),
          el('option', { value: 'true' }, ['true']),
          el('option', { value: 'false' }, ['false']),
        ]);
        s.value = val === true ? 'true' : val === false ? 'false' : '';
        return s;
      }
      const ft = FIELD_TYPES[col];
      if (ft?.type === 'enum') {
        const opts = [...(ft.options ?? [])];
        if (val && !opts.includes(val)) opts.push(val);
        const s = el('select', { class: 'field-in', 'data-col': col, disabled },
          [el('option', { value: '' }, ['(null)']), ...opts.map((o) => el('option', { value: o }, [o]))]);
        s.value = val ?? '';
        return s;
      }
      if (ft?.type === 'date') {
        const i = el('input', { type: 'date', class: 'field-in', 'data-col': col, disabled });
        i.value = val ? String(val).slice(0, 10) : '';
        return i;
      }
      if (ft?.type === 'datetime') {
        const i = el('input', { type: 'datetime-local', class: 'field-in', 'data-col': col, disabled });
        i.value = val ? String(val).slice(0, 16) : '';
        return i;
      }
      const str = val === null || val === undefined ? '' : typeof val === 'object' ? JSON.stringify(val) : String(val);
      if (str.length > 60) {
        const t = el('textarea', { class: 'field-in', 'data-col': col, disabled });
        t.value = str;
        return t;
      }
      const i = el('input', { class: 'field-in', 'data-col': col, disabled });
      i.value = str;
      return i;
    };

    const backdrop = el('div', { class: 'drawer-backdrop', onclick: () => this.closeDrawer() });
    const drawer = el('div', { class: 'drawer' });
    drawer.appendChild(el('button', { class: 'close', onclick: () => this.closeDrawer() }, ['✕']));
    const title = el('h2', {}, [mode === 'create' ? 'New row' : mode === 'edit' ? 'Edit row' : 'Row detail']);
    if (ro) title.appendChild(el('span', { class: 'readonly-tag' }, [' · read-only view']));
    drawer.appendChild(title);
    drawer.appendChild(el('div', { class: 'sub' }, [`${this.source}${row.id ? ` · ${row.id}` : ''}`]));

    const form = el('form', { id: 'drawerForm', onsubmit: (e) => e.preventDefault() });
    cols.forEach((c) => {
      form.appendChild(el('div', { class: 'frow' }, [el('span', { class: 'k' }, [c]), inputFor(c)]));
    });
    drawer.appendChild(form);

    if (!ro) {
      const actions = el('div', { class: 'actions' }, [
        el('button', { class: 'primary', disabled: this.saving, onclick: () => this.saveDrawer() }, [this.saving ? 'Saving…' : 'Save']),
        el('button', { onclick: () => this.closeDrawer() }, ['Cancel']),
      ]);
      if (mode === 'edit') {
        actions.appendChild(el('button', { class: 'danger', style: 'margin-left:auto', onclick: () => { const r = this.drawerRow; this.closeDrawer(); this.deleteRow(r); } }, ['Delete']));
      }
      drawer.appendChild(actions);
    }

    this.root.appendChild(backdrop);
    this.root.appendChild(drawer);

    if (!this._escBound) {
      this._escHandler = (e) => { if (e.key === 'Escape' && this.drawer) this.closeDrawer(); };
      window.addEventListener('keydown', this._escHandler);
      this._escBound = true;
    }
  }
}
