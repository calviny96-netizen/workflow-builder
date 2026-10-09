import { useEffect, useState } from 'react';
import { api } from './api.ts';

export function GoogleCredentials({ onConfigured }: { onConfigured: () => void }) {
  const [status, setStatus] = useState<{ configured: boolean; email: string | null; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { api('GET', '/api/google/credentials').then(setStatus).catch((e) => setError(e.message)); }, []);
  return <div className="card">
    <strong>Kredensial Google Workspace</strong>
    <p className="muted small">{status ? status.configured ? `Terhubung sebagai ${status.email}` : 'Belum terhubung. Unggah file JSON service account Google untuk append dan upsert.' : 'Memeriksa koneksi…'}</p>
    <label>{busy ? 'Memeriksa dan menyimpan…' : status?.configured ? 'Ganti file JSON service account' : 'File JSON service account'}
      <input type="file" accept=".json,application/json" disabled={busy} onChange={async (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        setError('');
        if (file.size > 32_768) { setError('Ukuran file JSON maksimal 32 KB.'); return; }
        setBusy(true);
        try {
          const result = await api('POST', '/api/google/credentials', { json: await file.text() });
          setStatus(result);
          onConfigured();
        } catch (e: any) { setError(e.message); }
        finally { setBusy(false); }
      }} />
    </label>
    {(error || status?.error) && <div className="error" role="alert">{error || status?.error}</div>}
    <p className="muted small">Kredensial berlaku untuk seluruh workflow dan disimpan terenkripsi di server. Aktifkan Google Sheets API, lalu bagikan spreadsheet tujuan sebagai Editor ke email service account.</p>
    <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Buka kredensial Google Cloud</a>
  </div>;
}
