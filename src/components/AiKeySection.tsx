import { useEffect, useState } from 'react';
import { CheckCircle2, KeyRound, Lock, Trash2 } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import {
  clearAiKey,
  describeValidation,
  enablePassphraseStorage,
  hasAiKey,
  saveAiKey,
  storedKeyNeedsPassphrase,
  unlockStoredKey,
  validateAiKey,
  validateStoredAiKey,
  type ValidationResult,
} from '../services/aiKeyService';

interface Props {
  theme: 'light' | 'dark';
}

const PASSPHRASE_MIN = 12;

/**
 * Your own Gemini key. The component knows only whether a key exists. The key goes straight from this
 * input to the key store, and it is cleared from state after a successful save.
 */
export function AiKeySection({ theme }: Props) {
  const dark = theme === 'dark';
  const native = Capacitor.isNativePlatform();
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [needsPassphrase, setNeedsPassphrase] = useState(false);
  const [draft, setDraft] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [keepEncrypted, setKeepEncrypted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: 'ok' | 'error' | 'info'; text: string } | null>(null);

  useEffect(() => {
    void hasAiKey().then(setHasKey);
    setNeedsPassphrase(storedKeyNeedsPassphrase());
  }, []);

  const report = (result: ValidationResult) =>
    setStatus({ tone: result.valid ? 'ok' : 'error', text: describeValidation(result) });

  const save = async () => {
    setBusy(true);
    setStatus({ tone: 'info', text: 'Checking the key with Google…' });
    try {
      if (keepEncrypted && !native) {
        if (passphrase.length < PASSPHRASE_MIN) {
          setStatus({ tone: 'error', text: `Use a passphrase of at least ${PASSPHRASE_MIN} characters.` });
          return;
        }
        const result = await validateAiKey(draft);
        if (!result.valid) return report(result);
        await enablePassphraseStorage(passphrase, draft.trim());
        setNeedsPassphrase(false);
        setStatus({ tone: 'ok', text: 'Key saved, encrypted with your passphrase on this device.' });
      } else {
        const result = await saveAiKey(draft);
        if (!result.valid) return report(result);
        setStatus({ tone: 'ok', text: 'Key saved for this session.' });
      }
      setHasKey(true);
      setDraft('');
      setPassphrase('');
    } catch (err) {
      setStatus({ tone: 'error', text: (err as Error).message || 'Could not save the key.' });
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    setBusy(true);
    try {
      report(await validateStoredAiKey());
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await clearAiKey();
      setHasKey(false);
      setNeedsPassphrase(false);
      setStatus({ tone: 'info', text: 'Key removed from this device.' });
    } finally {
      setBusy(false);
    }
  };

  const unlock = async () => {
    setBusy(true);
    try {
      const ok = await unlockStoredKey(passphrase);
      setPassphrase('');
      setHasKey(ok);
      setNeedsPassphrase(!ok);
      setStatus(ok ? { tone: 'ok', text: 'Key unlocked for this session.' } : { tone: 'error', text: 'No key is stored.' });
    } catch {
      setStatus({ tone: 'error', text: 'Wrong passphrase.' });
    } finally {
      setBusy(false);
    }
  };

  const panel = `p-4 rounded-card border space-y-3 ${dark ? 'border-neutral-800 bg-neutral-950/60' : 'border-neutral-200 bg-neutral-50/80'}`;
  const input = `w-full px-3 py-2 rounded-control border text-sm ${dark ? 'bg-neutral-900 border-neutral-700 text-neutral-100' : 'bg-white border-neutral-300 text-neutral-900'}`;
  const button = 'px-3 py-2 rounded-control font-bold text-sm border disabled:opacity-50';

  return (
    <section className={panel} aria-labelledby="ai-key-heading">
      <div className="flex items-center gap-2">
        <KeyRound className="w-4 h-4 text-purple-400 shrink-0" aria-hidden="true" />
        <div>
          <h3 id="ai-key-heading" className="text-sm font-black">Your Gemini API key (optional)</h3>
          <p className="text-sm text-neutral-400">
            Use your own key for AI features. Your key is never shown again, and the server does not store it.
          </p>
        </div>
      </div>

      {hasKey === true && (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-1.5 font-medium">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" aria-hidden="true" />
            Key configured <span aria-hidden="true" className="text-neutral-400">••••••••••••</span>
          </span>
          <div className="flex gap-2">
            <button type="button" onClick={check} disabled={busy} className={`${button} border-purple-500/40 text-purple-400`}>
              Check key
            </button>
            <button type="button" onClick={remove} disabled={busy} className={`${button} border-red-500/40 text-red-400 flex items-center gap-1`}>
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
              Remove
            </button>
          </div>
        </div>
      )}

      {hasKey === false && needsPassphrase && (
        <div className="space-y-2">
          <label htmlFor="ai-key-unlock" className="text-sm font-medium flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5" aria-hidden="true" /> Enter your passphrase to unlock the saved key
          </label>
          <div className="flex gap-2">
            <input id="ai-key-unlock" type="password" autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} className={input} />
            <button type="button" onClick={unlock} disabled={busy || passphrase.length === 0} className={`${button} border-purple-500/40 text-purple-400`}>
              Unlock
            </button>
          </div>
        </div>
      )}

      {hasKey === false && !needsPassphrase && (
        <div className="space-y-2">
          <label htmlFor="ai-key-input" className="text-sm font-medium">Gemini API key</label>
          <input
            id="ai-key-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className={input}
          />
          {!native && (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={keepEncrypted} onChange={(e) => setKeepEncrypted(e.target.checked)} />
                Keep it on this device, encrypted with a passphrase
              </label>
              {keepEncrypted && (
                <>
                  <label htmlFor="ai-key-passphrase" className="text-sm font-medium">Passphrase (at least {PASSPHRASE_MIN} characters)</label>
                  <input id="ai-key-passphrase" type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} className={input} />
                </>
              )}
            </div>
          )}
          <button type="button" onClick={save} disabled={busy || draft.trim().length === 0} className={`${button} bg-purple-500/20 border-purple-500/40 text-purple-400`}>
            Save and check key
          </button>
        </div>
      )}

      <p role="status" aria-live="polite" className={`text-sm ${status?.tone === 'error' ? 'text-red-400' : status?.tone === 'ok' ? 'text-emerald-400' : 'text-neutral-400'}`}>
        {status?.text ?? ''}
      </p>
    </section>
  );
}
