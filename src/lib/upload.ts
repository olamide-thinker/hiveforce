/**
 * Upload helper — posts a local file URI to /api/upload and returns
 * the public URL the backend hands back.
 *
 * `fetch` with FormData is the cross-platform-stable way to do
 * multipart from React Native — we explicitly DO NOT set the
 * Content-Type header so the runtime auto-fills the multipart
 * boundary. Setting it manually breaks Android.
 *
 * The backend's /api/upload (uploads.controller.ts) accepts a
 * single field called `file` with a 50 MB cap, stores it on disk
 * under /uploads, and returns:
 *   { success, url, filename, size, mimetype }
 *
 * ⚠️ Render free-tier disk is ephemeral — these URLs survive
 * across requests but vanish on every redeploy. Fine for pilot
 * testing; production needs Supabase Storage or S3.
 */
import { auth } from './firebase';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE || '';

export interface UploadResult {
  url: string;
  filename: string;
  size: number;
  mimetype: string;
}

/**
 * Upload one file. Pass the local `uri` from expo-image-picker, the
 * mimetype the picker hands you, and a friendly name (the picker
 * gives `fileName` for library picks but it can be null — fall
 * back to a synthesized name).
 */
export async function uploadFile(opts: {
  uri: string;
  name?: string | null;
  mimeType?: string | null;
}): Promise<UploadResult> {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');
  const token = await user.getIdToken();

  // Build a synthesized filename from the URI extension if the
  // picker didn't give us one (common on Android library picks).
  const extFromUri = opts.uri.split('.').pop()?.split('?')[0] ?? 'bin';
  const safeName =
    opts.name && opts.name.length > 0 ? opts.name : `media-${Date.now()}.${extFromUri}`;
  const mime = opts.mimeType || guessMime(extFromUri);

  // FormData on RN — the file part is the spread { uri, name, type }
  // object literal, not a Blob. RN handles it natively.
  const form = new FormData();
  // The `as any` is the standard RN escape — FormData's TS type
  // expects Blob | string, but RN runtime accepts the file-object
  // shape and the bridge does the right thing.
  form.append('file', {
    uri: opts.uri,
    name: safeName,
    type: mime,
  } as any);

  const res = await fetch(`${API_BASE}/api/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      // Do NOT set Content-Type — let fetch fill in the boundary.
    },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Upload failed (${res.status}): ${text || res.statusText}`);
  }
  const body = await res.json();
  if (!body?.success || !body.url) {
    throw new Error('Upload returned no URL');
  }
  return {
    url: body.url,
    filename: body.filename,
    size: body.size,
    mimetype: body.mimetype,
  };
}

function guessMime(ext: string): string {
  const e = ext.toLowerCase();
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'png') return 'image/png';
  if (e === 'gif') return 'image/gif';
  if (e === 'webp') return 'image/webp';
  if (e === 'heic' || e === 'heif') return 'image/heic';
  if (e === 'mp4') return 'video/mp4';
  if (e === 'mov') return 'video/quicktime';
  if (e === 'webm') return 'video/webm';
  if (e === 'm4a' || e === 'aac') return 'audio/aac';
  if (e === 'mp3') return 'audio/mpeg';
  return 'application/octet-stream';
}
