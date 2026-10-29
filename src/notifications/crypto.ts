import { decodeEncryptionKey } from '../config.js';
import type { EncryptedSecret } from '../contracts/domain.js';

export type SecretField = 'userKey' | 'appToken' | 'receipt' | 'channelConfig';
export class SecretError extends Error {
  constructor(public readonly code: 'invalid_secret' | 'invalid_encryption_key' | 'invalid_envelope' | 'secret_authentication_failed') {
    super(code); this.name = 'SecretError';
  }
}
const encode = (bytes: Uint8Array): string => btoa(Array.from(bytes, v => String.fromCharCode(v)).join(''));
function decode(value: unknown, max: number): Uint8Array {
  if (typeof value !== 'string' || value.length > max || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new SecretError('invalid_envelope');
  const bytes = Uint8Array.from(atob(value), v => v.charCodeAt(0));
  if (encode(bytes) !== value) throw new SecretError('invalid_envelope');
  return bytes;
}
function aad(userId: string, field: SecretField): Uint8Array<ArrayBuffer> {
  if (typeof userId !== 'string' || !userId || userId.length > 200 || !['userKey','appToken','receipt','channelConfig'].includes(field)) throw new SecretError('invalid_secret');
  return new TextEncoder().encode(JSON.stringify(['open-alert','0.1.0',1,userId,field]));
}
async function key(value: string): Promise<CryptoKey> {
  try { return await crypto.subtle.importKey('raw', new Uint8Array(decodeEncryptionKey(value)), 'AES-GCM', false, ['encrypt','decrypt']); }
  catch { throw new SecretError('invalid_encryption_key'); }
}
export function encryptSecret(encryptionKey: string, userId: string, field: SecretField, value: string): Promise<EncryptedSecret>;
/** Compatibility with the interrupted implementation; new integrations use key/user/field/value. */
export function encryptSecret(value: string, encryptionKey: string, userId: string, field: SecretField): Promise<EncryptedSecret>;
export async function encryptSecret(a: string, b: string, c: string, d: string): Promise<EncryptedSecret> {
  const modern = ['userKey','appToken','receipt','channelConfig'].includes(c);
  const [encryptionKey, userId, field, value] = modern ? [a,b,c as SecretField,d] as const : [b,c,d as SecretField,a] as const;
  if (typeof value !== 'string' || !value || new TextEncoder().encode(value).length > 4096) throw new SecretError('invalid_secret');
  const additionalData = aad(userId,field), imported = await key(encryptionKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData,tagLength:128}, imported, new TextEncoder().encode(value));
  return {version:1,algorithm:'A256GCM',iv:encode(iv),ciphertext:encode(new Uint8Array(ciphertext))};
}
export function decryptSecret(encryptionKey: string, userId: string, field: SecretField, envelope: EncryptedSecret): Promise<string>;
export function decryptSecret(envelope: EncryptedSecret, encryptionKey: string, userId: string, field: SecretField): Promise<string>;
export async function decryptSecret(a: string | EncryptedSecret, b: string, c: string, d: EncryptedSecret | SecretField): Promise<string> {
  const [encryptionKey,userId,field,envelope] = typeof a === 'string' ? [a,b,c as SecretField,d as EncryptedSecret] as const : [b,c,d as SecretField,a] as const;
  if (!envelope || envelope.version !== 1 || envelope.algorithm !== 'A256GCM' || Object.keys(envelope).sort().join(',') !== 'algorithm,ciphertext,iv,version') throw new SecretError('invalid_envelope');
  const iv = decode(envelope.iv, 16), ciphertext = decode(envelope.ciphertext, 5500);
  if (iv.length !== 12 || ciphertext.length < 17 || ciphertext.length > 4112) throw new SecretError('invalid_envelope');
  const additionalData = aad(userId,field), imported = await key(encryptionKey);
  try {
    const plaintext = await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(iv),additionalData,tagLength:128}, imported, new Uint8Array(ciphertext));
    return new TextDecoder('utf-8',{fatal:true}).decode(plaintext);
  } catch { throw new SecretError('secret_authentication_failed'); }
}
