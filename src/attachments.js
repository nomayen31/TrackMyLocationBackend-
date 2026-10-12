/**
 * attachments — validation/normalisation for chat media (images + voice notes).
 *
 * Media travels as a data URL (base64) — consistent with how stories are
 * stored in this project. For production, upload to object storage (S3 /
 * Cloudinary) and store the resulting URL instead; `data` accepts http(s)
 * URLs too, so swapping later is a one-line change on the client.
 */

const MAX_ATTACHMENT_LENGTH = 7 * 1024 * 1024; // ~7 MB of base64 text
const TYPES = new Set(['image', 'audio']);

/** Derive a mime type from a `data:` URL header. */
function mimeFromDataUrl(data) {
  const match = /^data:([^;,]+)/i.exec(data);
  return match ? match[1].slice(0, 80) : null;
}

/**
 * Returns a clean attachment object, or `null` when the payload is missing,
 * the wrong type, or too large.
 */
function normalizeAttachment(att) {
  if (!att || typeof att !== 'object') return null;

  const type = String(att.type || '').toLowerCase();
  if (!TYPES.has(type)) return null;

  const data = String(att.data || '');
  if (!data || data.length > MAX_ATTACHMENT_LENGTH) return null;
  if (!/^data:(image|audio)\//i.test(data) && !/^https?:\/\//i.test(data)) return null;

  const duration = Number(att.duration);
  return {
    type,
    data,
    mime: att.mime ? String(att.mime).slice(0, 80) : mimeFromDataUrl(data),
    name: att.name ? String(att.name).slice(0, 140) : null,
    duration:
      Number.isFinite(duration) && duration > 0 ? Math.min(duration, 3600) : null,
  };
}

module.exports = { normalizeAttachment, MAX_ATTACHMENT_LENGTH };
