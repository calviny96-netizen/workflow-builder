import { useState } from 'react';
import { api } from './api.ts';

export function AccountSettings({ user, onUpdated }: { user: { email: string }; onUpdated: (user: any) => void }) {
  const [email, setEmail] = useState(user.email);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  return (
    <div className="page">
      <header className="topbar">
        <a className="btn ghost" href="#/" aria-label="Kembali ke daftar workflow">← Workflow</a>
        <span className="spacer" />
        <span className="muted">{user.email}</span>
      </header>
      <main className="list-main account-main">
        <h2>Pengaturan akun</h2>
        <p className="muted small">Ubah email dan password yang Anda gunakan untuk masuk.</p>
        <form className="card account-form" onSubmit={async (e) => {
          e.preventDefault();
          setError('');
          setSuccess('');
          if (newPassword !== confirmation) {
            setError('Konfirmasi password baru tidak cocok.');
            return;
          }
          setBusy(true);
          try {
            const result = await api('PATCH', '/api/auth/account', {
              email,
              currentPassword,
              ...(newPassword ? { newPassword } : {}),
            });
            onUpdated(result.user);
            setEmail(result.user.email);
            setCurrentPassword('');
            setNewPassword('');
            setConfirmation('');
            setSuccess('Pengaturan akun tersimpan. Gunakan kredensial terbaru saat masuk kembali.');
          } catch (err: any) {
            setError([err.message, ...(err.issues ?? [])].join(' '));
          } finally {
            setBusy(false);
          }
        }}>
          <fieldset disabled={busy} className="account-fields">
            <label>Email<input type="email" autoComplete="username" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label>Password saat ini<input type="password" autoComplete="current-password" required maxLength={1024} value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} /></label>
            <label>Password baru<input type="password" autoComplete="new-password" minLength={8} maxLength={128} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} aria-describedby="password-hint" /></label>
            <p id="password-hint" className="muted small">Minimal 8 karakter. Kosongkan jika hanya ingin mengganti email.</p>
            <label>Konfirmasi password baru<input type="password" autoComplete="new-password" required={!!newPassword} maxLength={128} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /></label>
          </fieldset>
          {error && <div className="error" role="alert">{error}</div>}
          {success && <div className="account-success" role="status">{success}</div>}
          <p className="muted small">Setelah disimpan, sesi di perangkat lain akan keluar. Sesi ini tetap aktif.</p>
          <div className="row end"><button className="btn primary" disabled={busy}>{busy ? 'Menyimpan…' : 'Simpan perubahan'}</button></div>
        </form>
      </main>
    </div>
  );
}
