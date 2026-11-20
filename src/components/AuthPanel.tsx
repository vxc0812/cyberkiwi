import { useState } from 'react';
import { LogIn, LogOut, UserPlus } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { AuthError } from '../services/authClient';

interface Props {
  theme: 'light' | 'dark';
}

const PASSWORD_MIN = 12;

/** Login and registration. The server decides whether an invite is required. */
export function AuthPanel({ theme }: Props) {
  const { user, isLoading, login, register, logout } = useAuth();
  const dark = theme === 'dark';
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const panel = `p-4 rounded-card border space-y-3 ${dark ? 'border-neutral-800 bg-neutral-950/60' : 'border-neutral-200 bg-neutral-50/80'}`;
  const input = `w-full px-3 py-2 rounded-control border text-sm ${dark ? 'bg-neutral-900 border-neutral-700 text-neutral-100' : 'bg-white border-neutral-300 text-neutral-900'}`;
  const button = 'px-3 py-2 rounded-control font-bold text-sm border disabled:opacity-50 flex items-center gap-1.5';

  if (isLoading) {
    return (
      <section className={panel} aria-labelledby="account-heading">
        <h3 id="account-heading" className="text-sm font-black">Account</h3>
        <p className="text-sm text-neutral-400" role="status">Checking your session…</p>
      </section>
    );
  }

  if (user) {
    return (
      <section className={panel} aria-labelledby="account-heading">
        <h3 id="account-heading" className="text-sm font-black">Account</h3>
        <div className="flex items-center justify-between gap-2 text-sm">
          <span>Signed in as <strong>{user.email}</strong></span>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await logout();
              } finally {
                setBusy(false);
              }
            }}
            className={`${button} border-neutral-500/40`}
          >
            <LogOut className="w-3.5 h-3.5" aria-hidden="true" /> Sign out
          </button>
        </div>
      </section>
    );
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (mode === 'register' && password.length < PASSWORD_MIN) {
      setMessage({ tone: 'error', text: `Use a password of at least ${PASSWORD_MIN} characters.` });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      if (mode === 'login') {
        await login(email.trim(), password);
      } else {
        await register(email.trim(), password, inviteCode.trim());
        setMode('login');
        setMessage({ tone: 'ok', text: 'Account created. Sign in to continue.' });
      }
      setPassword('');
      setInviteCode('');
    } catch (err) {
      const text = err instanceof AuthError ? err.message : 'Something went wrong. Try again.';
      setMessage({ tone: 'error', text });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={panel} aria-labelledby="account-heading">
      <div className="flex gap-2" role="tablist" aria-label="Account">
        <button type="button" role="tab" aria-selected={mode === 'login'} onClick={() => setMode('login')} className={`${button} ${mode === 'login' ? 'border-orange-500 text-orange-400' : 'border-neutral-500/40'}`}>
          <LogIn className="w-3.5 h-3.5" aria-hidden="true" /> Sign in
        </button>
        <button type="button" role="tab" aria-selected={mode === 'register'} onClick={() => setMode('register')} className={`${button} ${mode === 'register' ? 'border-orange-500 text-orange-400' : 'border-neutral-500/40'}`}>
          <UserPlus className="w-3.5 h-3.5" aria-hidden="true" /> Create account
        </button>
      </div>

      <form onSubmit={submit} className="space-y-2" aria-labelledby="account-heading">
        <label htmlFor="auth-email" className="block text-sm font-medium">Email</label>
        <input id="auth-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={input} />

        <label htmlFor="auth-password" className="block text-sm font-medium">Password</label>
        <input
          id="auth-password"
          type="password"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={input}
        />

        {mode === 'register' && (
          <>
            <label htmlFor="auth-invite" className="block text-sm font-medium">Invite code</label>
            <input id="auth-invite" type="text" autoComplete="off" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} className={input} />
          </>
        )}

        <button type="submit" disabled={busy} className={`${button} bg-orange-500/20 border-orange-500/40 text-orange-400`}>
          {mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
      </form>

      <p role="status" aria-live="polite" className={`text-sm ${message?.tone === 'error' ? 'text-red-400' : message?.tone === 'ok' ? 'text-emerald-400' : 'text-neutral-400'}`}>
        {message?.text ?? ''}
      </p>
    </section>
  );
}
