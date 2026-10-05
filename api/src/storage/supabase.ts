import { env } from "../env.js";

/**
 * Supabase Storage via plain REST — a dumb pipe, like the mail module.
 * The bucket is private; every download goes through the documents routes
 * so tenant rules decide access. Credentials come from env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * When either is unset the feature is dormant (routes answer 503).
 */
const BUCKET = env.DOCUMENTS_BUCKET;

export function storageConfigured(): boolean {
  return !!env.SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY;
}

function requireConfig(): { base: string; key: string } {
  if (!storageConfigured()) {
    throw new StorageUnavailableError();
  }
  return { base: env.SUPABASE_URL.replace(/\/$/, ""), key: env.SUPABASE_SERVICE_ROLE_KEY };
}

export class StorageUnavailableError extends Error {
  constructor() {
    super("Storage is not configured");
  }
}

async function ensureBucketOnce(): Promise<void> {
  const { base, key } = requireConfig();
  const res = await fetch(`${base}/storage/v1/bucket`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: BUCKET, public: false })
  });
  // 409 (or Supabase's duplicate error) simply means it already exists.
  if (!res.ok && res.status !== 400 && res.status !== 409) {
    throw new Error(`Bucket create failed: ${res.status} ${await res.text()}`);
  }
}

let bucketReady: Promise<void> | null = null;
function bucketOnce(): Promise<void> {
  bucketReady ??= ensureBucketOnce();
  return bucketReady;
}

/** Upload bytes; returns the storage path used. */
export async function putObject(path: string, bytes: Buffer, mimeType: string): Promise<string> {
  await bucketOnce();
  const { base, key } = requireConfig();
  const res = await fetch(`${base}/storage/v1/object/${BUCKET}/${encodeURI(path)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": mimeType,
      "x-upsert": "false"
    },
    body: new Uint8Array(bytes)
  });
  if (!res.ok) {
    throw new Error(`Storage upload failed: ${res.status} ${await res.text()}`);
  }
  return path;
}

export async function getObject(path: string): Promise<{ bytes: Buffer; contentType: string | null }> {
  const { base, key } = requireConfig();
  const res = await fetch(`${base}/storage/v1/object/${BUCKET}/${encodeURI(path)}`, {
    headers: { Authorization: `Bearer ${key}` }
  });
  if (!res.ok) {
    throw new Error(`Storage download failed: ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { bytes: buf, contentType: res.headers.get("content-type") };
}

export async function deleteObject(path: string): Promise<void> {
  const { base, key } = requireConfig();
  await fetch(`${base}/storage/v1/object/${BUCKET}/${encodeURI(path)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${key}` }
  });
  // Best effort: a missing object is not an error for the caller.
}

/** Short-lived signed URL so <img> tags (no Bearer headers) can render files. */
export async function signObject(path: string, expiresInSeconds: number): Promise<string> {
  const { base, key } = requireConfig();
  const res = await fetch(`${base}/storage/v1/object/sign/${BUCKET}/${encodeURI(path)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: expiresInSeconds })
  });
  if (!res.ok) {
    throw new Error(`Storage sign failed: ${res.status}`);
  }
  const j: any = await res.json();
  return `${base}/storage/v1${j.signedURL}`;
}
