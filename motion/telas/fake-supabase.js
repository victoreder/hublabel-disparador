// Supabase falso para capturar as telas reais com dados de exemplo.
// Servido no lugar de https://cdn.jsdelivr.net/npm/@supabase/supabase-js@*/+esm.
// Os dados vêm de window.__FIX = { tabelas: { NomeTabela: [linhas] }, rpc: { nome: dados }, usuario: {...} }.
// Cada consulta é registrada em window.__Q (para descobrir o que a tela precisa).

const LOG = (window.__Q = window.__Q || []);
const fix = () => window.__FIX || { tabelas: {}, rpc: {} };

function matches(row, filters) {
  return filters.every(([op, col, val]) => {
    if (op.startsWith('not.')) return !matches(row, [[op.slice(4), col, val]]) || !(col in row);
    if (!(col in row)) return true; // coluna que não está no fixture: não filtra
    const v = row[col];
    switch (op) {
      case 'eq': return String(v) === String(val);
      case 'neq': return String(v) !== String(val);
      case 'in': return (val || []).map(String).includes(String(v));
      case 'is': return val === null ? v == null : v === val;
      case 'gt': return v > val;
      case 'gte': return v >= val;
      case 'lt': return v < val;
      case 'lte': return v <= val;
      case 'ilike': case 'like': return String(v ?? '').toLowerCase().includes(String(val).replace(/%/g, '').toLowerCase());
      default: return true;
    }
  });
}

class Query {
  constructor(table) { this.table = table; this.filters = []; this.mode = 'select'; this._single = false; this._limit = null; this._order = null; this.opts = {}; }
  _rec(op, a, b) { this.filters.push([op, a, b]); return this; }
  select(cols, opts) { if (this.mode === 'select') this.cols = cols; this.opts = opts || {}; return this; }
  insert(v) { this.mode = 'insert'; this.payload = v; return this; }
  upsert(v) { this.mode = 'upsert'; this.payload = v; return this; }
  update(v) { this.mode = 'update'; this.payload = v; return this; }
  delete() { this.mode = 'delete'; return this; }
  eq(a, b) { return this._rec('eq', a, b); }
  neq(a, b) { return this._rec('neq', a, b); }
  in(a, b) { return this._rec('in', a, b); }
  is(a, b) { return this._rec('is', a, b); }
  gt(a, b) { return this._rec('gt', a, b); }
  gte(a, b) { return this._rec('gte', a, b); }
  lt(a, b) { return this._rec('lt', a, b); }
  lte(a, b) { return this._rec('lte', a, b); }
  like(a, b) { return this._rec('like', a, b); }
  ilike(a, b) { return this._rec('ilike', a, b); }
  not(col, op, val) { if (col && op) this.filters.push(['not.' + op, col, val]); return this; } or() { return this; } filter() { return this; } match() { return this; }
  contains() { return this; } containedBy() { return this; } overlaps() { return this; } textSearch() { return this; }
  order(col, o) { this._order = [col, !(o && o.ascending === false)]; return this; }
  limit(n) { this._limit = n; return this; }
  range(a, b) { this._range = [a, b]; return this; }
  single() { this._single = true; return this; }
  maybeSingle() { this._single = true; this._maybe = true; return this; }
  abortSignal() { return this; } returns() { return this; } csv() { return this; }
  _run() {
    const all = (fix().tabelas[this.table] || []).filter((r) => matches(r, this.filters));
    LOG.push({ t: this.table, mode: this.mode, cols: this.cols, f: this.filters, n: all.length });
    if (this.mode !== 'select') {
      const d = Array.isArray(this.payload) ? this.payload : this.payload ? [this.payload] : [];
      return { data: this._single ? d[0] || null : d, error: null };
    }
    let rows = all.slice();
    if (this._order) { const [c, asc] = this._order; rows.sort((x, y) => (x[c] > y[c] ? 1 : x[c] < y[c] ? -1 : 0) * (asc ? 1 : -1)); }
    if (this._range) rows = rows.slice(this._range[0], this._range[1] + 1);
    if (this._limit != null) rows = rows.slice(0, this._limit);
    if (this.opts.head) return { data: null, count: all.length, error: null };
    if (this._single) return { data: rows[0] || null, error: rows[0] || this._maybe ? null : { message: 'not found', code: 'PGRST116' } };
    return { data: rows, count: all.length, error: null };
  }
  then(res, rej) { try { return Promise.resolve(this._run()).then(res, rej); } catch (e) { return Promise.reject(e).then(res, rej); } }
}

function channel() {
  const c = { on() { return c; }, subscribe(cb) { try { cb && cb('SUBSCRIBED'); } catch {} return c; }, unsubscribe() { return Promise.resolve(); }, send() { return Promise.resolve(); }, track() { return Promise.resolve(); } };
  return c;
}

export function createClient() {
  const u = () => fix().usuario || { id: 'user-demo', email: 'demo@hublabel.com' };
  const session = () => ({ access_token: 'demo', refresh_token: 'demo', user: u(), expires_at: 4102444800 });
  return {
    from: (t) => new Query(t),
    rpc: (name, args) => { LOG.push({ rpc: name, args }); const r = (fix().rpc || {})[name]; return Promise.resolve({ data: typeof r === 'function' ? r(args) : r ?? null, error: null }); },
    channel, removeChannel: () => Promise.resolve(), removeAllChannels: () => Promise.resolve(), getChannels: () => [],
    auth: {
      getSession: async () => ({ data: { session: fix().semSessao ? null : session() }, error: null }),
      getUser: async () => ({ data: { user: fix().semSessao ? null : u() }, error: null }),
      onAuthStateChange: (cb) => { if (!fix().semSessao) setTimeout(() => cb && cb('SIGNED_IN', session()), 0); return { data: { subscription: { unsubscribe() {} } } }; },
      refreshSession: async () => ({ data: { session: session() }, error: null }),
      signOut: async () => ({ error: null }),
    },
    storage: { from: () => ({ getPublicUrl: (p) => ({ data: { publicUrl: p } }), upload: async () => ({ data: {}, error: null }), createSignedUrl: async (p) => ({ data: { signedUrl: p }, error: null }) }) },
    functions: { invoke: async () => ({ data: null, error: null }) },
  };
}
export default { createClient };
