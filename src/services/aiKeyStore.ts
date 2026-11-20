/**
 * Storage for the user's own Gemini key (BYOK).
 *
 * - Native (iOS/Android): the key lives in the Keychain or Keystore, through capacitor-secure-storage-plugin.
 * - Web: memory only by default. The key is gone on reload, and that is the safe default: anything in
 *   localStorage can be read by any script that runs on the page.
 * - Web persistence, when a user wants it: PassphraseAiKeyStore encrypts the key with AES-GCM under a key
 *   derived from a passphrase (PBKDF2). The passphrase is never stored. Without it the stored value is
 *   useless to a reader of localStorage.
 *
 * Nothing in this module writes the key to a log, a URL or a request other than an AI call.
 */

export interface AiKeyStore {
  /** Whether a key is stored. Never returns the key, so UI code can ask without holding it. */
  has(): Promise<boolean>;
  get(): Promise<string | null>;
  set(key: string): Promise<void>;
  clear(): Promise<void>;
}

function cleanKey(raw: string): string {
  const key = raw.trim();
  if (key.length < 20 || key.length > 200 || /\s/.test(key)) {
    throw new Error('That does not look like a Gemini API key');
  }
  return key;
}

/** Memory only. Used on the web by default, and as the fallback when secure storage is unavailable. */
export class MemoryAiKeyStore implements AiKeyStore {
  private key: string | null = null;

  async has(): Promise<boolean> {
    return this.key !== null;
  }

  async get(): Promise<string | null> {
    return this.key;
  }

  async set(key: string): Promise<void> {
    this.key = cleanKey(key);
  }

  async clear(): Promise<void> {
    this.key = null;
  }
}

/** The subset of a secure-storage plugin this store needs. Matches capacitor-secure-storage-plugin. */
export interface SecureValuePort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Keychain (iOS) or Keystore (Android) through a secure-storage port. Read failures return null. */
export class SecureValueAiKeyStore implements AiKeyStore {
  constructor(private readonly port: SecureValuePort, private readonly storageKey = 'cyberkiwi.gemini-key') {}

  async has(): Promise<boolean> {
    return (await this.get()) !== null;
  }

  async get(): Promise<string | null> {
    try {
      return (await this.port.get(this.storageKey)) ?? null;
    } catch {
      return null;
    }
  }

  async set(key: string): Promise<void> {
    await this.port.set(this.storageKey, cleanKey(key));
  }

  async clear(): Promise<void> {
    await this.port.remove(this.storageKey).catch(() => undefined);
  }
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface Envelope {
  v: 1;
  salt: string;
  iv: string;
  ct: string;
}

const PBKDF2_ITERATIONS = 600_000;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Web persistence behind a passphrase. The store starts locked: get() returns null and set() throws
 * until unlock(passphrase) succeeds. A wrong passphrase fails the AES-GCM tag check.
 */
export class PassphraseAiKeyStore implements AiKeyStore {
  private aesKey: CryptoKey | null = null;
  private salt: Uint8Array | null = null;
  private unlockedKey: string | null = null;

  constructor(
    private readonly storage: KeyValueStorage,
    private readonly storageKey = 'cyberkiwi.ai-key.v1',
    private readonly iterations = PBKDF2_ITERATIONS
  ) {}

  isLocked(): boolean {
    return this.aesKey === null;
  }

  async has(): Promise<boolean> {
    return this.unlockedKey !== null || this.hasStoredKey();
  }

  hasStoredKey(): boolean {
    return this.readEnvelope() !== null;
  }

  private readEnvelope(): Envelope | null {
    try {
      const raw = this.storage.getItem(this.storageKey);
      return raw ? (JSON.parse(raw) as Envelope) : null;
    } catch {
      return null;
    }
  }

  private async derive(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt as BufferSource, iterations: this.iterations, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async unlock(passphrase: string): Promise<void> {
    if (passphrase.length < 12) throw new Error('Passphrase must be at least 12 characters');
    const envelope = this.readEnvelope();
    const salt = envelope ? fromBase64(envelope.salt) : crypto.getRandomValues(new Uint8Array(16));
    const key = await this.derive(passphrase, salt);

    if (envelope) {
      try {
        const plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: fromBase64(envelope.iv) as BufferSource },
          key,
          fromBase64(envelope.ct) as BufferSource
        );
        this.unlockedKey = new TextDecoder().decode(plain);
      } catch {
        throw new Error('Wrong passphrase');
      }
    }
    this.salt = salt;
    this.aesKey = key;
  }

  lock(): void {
    this.aesKey = null;
    this.unlockedKey = null;
  }

  async get(): Promise<string | null> {
    if (!this.aesKey) return null;
    return this.unlockedKey;
  }

  async set(key: string): Promise<void> {
    if (!this.aesKey || !this.salt) throw new Error('Unlock the key store with your passphrase first');
    const clean = cleanKey(key);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, this.aesKey, new TextEncoder().encode(clean));
    const envelope: Envelope = { v: 1, salt: toBase64(this.salt), iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
    this.storage.setItem(this.storageKey, JSON.stringify(envelope));
    this.unlockedKey = clean;
  }

  async clear(): Promise<void> {
    this.storage.removeItem(this.storageKey);
    this.lock();
  }
}
