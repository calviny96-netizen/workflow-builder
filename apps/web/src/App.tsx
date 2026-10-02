import { useEffect, useState } from 'react';
import { api, fmtTime, STATUS_LABEL } from './api.ts';
import { Editor } from './Editor.tsx';
import { RunView } from './RunView.tsx';

function useHash() {
  const [hash, setHash] = useState(window.location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

function Login({ onDone }: { onDone: (user: any) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="center-page">
      <form
        className="card login"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            onDone((await api('POST', '/api/auth/login', { email, password })).user);
          } catch (err: any) {
            setError(err.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <span className="brand">
          <i />
          AutoAudit Workflow Builder
        </span>
        <p className="muted small">Masuk untuk merakit dan menjalankan workflow.</p>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="btn primary" disabled={busy}>
          {busy ? 'Masuk…' : 'Masuk'}
        </button>
      </form>
    </div>
  );
}

function WorkflowList({ user, onLogout }: { user: any; onLogout: () => void }) {
  const [items, setItems] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const load = () =>
    api('GET', '/api/workflows')
      .then((r) => setItems(r.items))
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const [creating, setCreating] = useState(false);
  const create = () => setCreating(true);

  return (
    <div className="page">
      <header className="topbar">
        <span className="brand">
          <i />
          AutoAudit Workflow Builder
        </span>
        <span className="spacer" />
        <span className="muted">{user.email}</span>
        <button className="btn" onClick={onLogout}>
          Keluar
        </button>
      </header>
      <main className="list-main">
        <div className="list-head">
          <div>
            <h2>Workflow</h2>
            <p className="muted small">Rakit alur Audital Work dengan menyeret node, lalu jalankan dan pantau dari sini.</p>
          </div>
          <button className="btn primary" onClick={create}>
            + Workflow baru
          </button>
        </div>
        {error && <div className="error">{error}</div>}
        {items && items.length === 0 && (
          <div className="empty card">
            <b>Belum ada workflow</b>
            <span>Buat yang pertama untuk mulai merakit.</span>
            <button className="btn primary" onClick={create}>
              + Workflow baru
            </button>
          </div>
        )}
        <div className="wf-grid">
          {items?.map((w) => (
            <a key={w.id} className="card wf-card" href={`#/w/${w.id}`}>
              <div className="wf-card-name">{w.name}</div>
              <div className="muted">{w.company_name || 'Company belum dipilih'}</div>
              <div className="wf-card-foot">
                <span>{w.node_count} node</span>
                {w.last_run ? <span className={`badge st-${w.last_run.status}`}>{STATUS_LABEL[w.last_run.status] ?? w.last_run.status}</span> : <span className="muted">belum pernah jalan</span>}
              </div>
              <div className="muted small">diubah {fmtTime(w.updated_at)}</div>
            </a>
          ))}
        </div>
      </main>
      {creating && <NewWorkflow onClose={() => setCreating(false)} />}
    </div>
  );
}

// Company dipilih di sini, sebelum workflow dibuat, supaya editor langsung punya daftar sales, prompt, dan modelnya.
function NewWorkflow({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<{ id: number; name: string }[] | null>(null);
  const [company, setCompany] = useState<{ id: number; name: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api('GET', `/api/aa/companies?q=${encodeURIComponent(q)}`)
        .then((r) => live && setItems(r.items))
        .catch((e) => live && setError(e.message));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  async function submit() {
    if (!company) return;
    setBusy(true);
    setError('');
    try {
      const graph = { nodes: [{ id: 'trigger', type: 'trigger', position: { x: 40, y: 200 }, config: {} }], edges: [] };
      const w = await api('POST', '/api/workflows', { name: name.trim() || `Workflow ${company.name}`, company_id: company.id, company_name: company.name, graph, settings: {} });
      window.location.hash = `#/w/${w.id}`;
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <form
        className="card modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h3>Workflow baru</h3>
        <label>
          Company
          {company ? (
            <div className="picked">
              <span>
                <b>{company.name}</b> <span className="muted small">#{company.id}</span>
              </span>
              <button type="button" className="link-btn" onClick={() => setCompany(null)}>
                Ganti
              </button>
            </div>
          ) : (
            <input autoFocus placeholder="Cari nama company…" value={q} onChange={(e) => setQ(e.target.value)} />
          )}
        </label>
        {!company && (
          <div className="pick-list">
            {items === null && <div className="muted small">Memuat…</div>}
            {items?.length === 0 && <div className="muted small">Tidak ada company yang cocok.</div>}
            {items?.map((c) => (
              <button type="button" key={c.id} className="pick-item" onClick={() => setCompany(c)}>
                {c.name} <span className="muted small">#{c.id}</span>
              </button>
            ))}
          </div>
        )}
        <p className="muted small">Company menentukan daftar sales, prompt, memory, dan model di dalam workflow, dan tidak bisa diganti setelah workflow dibuat.</p>
        <label>
          Nama workflow
          <input value={name} placeholder={company ? `Workflow ${company.name}` : 'mis. Rekap komplain mingguan'} onChange={(e) => setName(e.target.value)} />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Batal
          </button>
          <button className="btn primary" disabled={!company || busy}>
            {busy ? 'Membuat…' : 'Buat workflow'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function App() {
  const hash = useHash();
  const [user, setUser] = useState<any | null | undefined>(undefined);

  useEffect(() => {
    api('GET', '/api/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => setUser(null));
    const on = () => setUser(null);
    window.addEventListener('aawb:unauthorized', on);
    return () => window.removeEventListener('aawb:unauthorized', on);
  }, []);

  if (user === undefined) return <div className="center-page muted">Memuat…</div>;
  if (!user) return <Login onDone={setUser} />;

  const run = hash.match(/^#\/w\/([0-9a-f-]+)\/run\/([0-9a-f-]+)/);
  if (run) return <RunView key={run[2]} workflowId={run[1]} runId={run[2]} />;
  const wf = hash.match(/^#\/w\/([0-9a-f-]+)/);
  if (wf) return <Editor key={wf[1]} workflowId={wf[1]} />;
  return (
    <WorkflowList
      user={user}
      onLogout={async () => {
        await api('POST', '/api/auth/logout');
        setUser(null);
      }}
    />
  );
}
