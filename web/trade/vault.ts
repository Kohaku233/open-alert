/* Local key vault. OKX credentials are encrypted with a key derived from the
   user's local password (PBKDF2-SHA256 -> AES-GCM-256) and stored only in this
   browser's localStorage. Decrypted credentials stay in memory for the session. */
import type { OkxCredentials } from './okx.js';

const STORAGE_KEY = 'open-alert-okx-vault';
export const VAULT_ITERATIONS = 310_000;
export interface VaultRecord { v: 1; salt: string; iv: string; data: string; hint: string; demo: boolean; iterations: number; savedAt: number }
export interface VaultSummary { hint: string; demo: boolean; savedAt: number }

const encoder = new TextEncoder(), decoder = new TextDecoder();
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), char => char.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealCredentials(creds: OkxCredentials, password: string, iterations = VAULT_ITERATIONS): Promise<VaultRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(password, salt, iterations);
  const plain = encoder.encode(JSON.stringify({ key: creds.key, secret: creds.secret, passphrase: creds.passphrase }));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plain));
  return { v: 1, salt: toBase64(salt), iv: toBase64(iv), data: toBase64(data), hint: creds.key.slice(-4), demo: creds.demo, iterations, savedAt: Date.now() };
}
/** Throws when the password is wrong (AES-GCM authentication fails). */
export async function openRecord(record: VaultRecord, password: string): Promise<OkxCredentials> {
  const key = await derive(password, fromBase64(record.salt), record.iterations);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(record.iv) as BufferSource }, key, fromBase64(record.data) as BufferSource);
  const parsed = JSON.parse(decoder.decode(plain)) as Partial<OkxCredentials>;
  if (typeof parsed.key !== 'string' || typeof parsed.secret !== 'string' || typeof parsed.passphrase !== 'string') throw new Error('vault_corrupt');
  return { key: parsed.key, secret: parsed.secret, passphrase: parsed.passphrase, demo: record.demo };
}

function isRecord(value: unknown): value is VaultRecord {
  const r = value as VaultRecord | null;
  return !!r && r.v === 1 && [r.salt, r.iv, r.data, r.hint].every(part => typeof part === 'string') && typeof r.demo === 'boolean' && Number.isInteger(r.iterations) && r.iterations >= 100_000;
}
export function readVault(): VaultRecord | null {
  try { const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'); return isRecord(parsed) ? parsed : null; } catch { return null; }
}
export function vaultSummary(): VaultSummary | null {
  const record = readVault();
  return record ? { hint: record.hint, demo: record.demo, savedAt: record.savedAt } : null;
}
export async function saveVault(creds: OkxCredentials, password: string): Promise<void> {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(await sealCredentials(creds, password)));
}
export async function unlockVault(password: string): Promise<OkxCredentials> {
  const record = readVault();
  if (!record) throw new Error('vault_missing');
  return openRecord(record, password);
}
export function forgetVault(): void { try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage blocked */ } }
