const { v2: cloudinary } = require('cloudinary');

let configured = false;
function ensureConfigured() {
  if (configured) return;
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    throw new Error(
      'Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET in your .env.'
    );
  }
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  configured = true;
}

/**
 * The real implementation, backed by Cloudinary. Swappable via setImpl()
 * below so tests (and this sandbox, which can't reach cloudinary.com) can
 * inject an in-memory stand-in instead.
 */
const realImpl = {
  /** Uploads a buffer, returns { storageKey, url }. storageKey is what we persist in the DB. */
  async upload(buffer, { folder = 'arden-darpoh-documents', filename } = {}) {
    ensureConfigured();
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder, resource_type: 'auto', filename_override: filename, use_filename: true, unique_filename: true },
        (err, result) => {
          if (err) return reject(err);
          resolve({ storageKey: result.public_id, url: result.secure_url, resourceType: result.resource_type });
        }
      );
      stream.end(buffer);
    });
  },

  /** Fetches the stored file's bytes given its storageKey (public_id) + resourceType. */
  async fetchBuffer(storageKey, resourceType) {
    ensureConfigured();
    const url = cloudinary.url(storageKey, { resource_type: resourceType || 'auto', secure: true });
    const res = await fetch(url);
    if (!res.ok) throw new Error('Could not retrieve the file from storage.');
    return Buffer.from(await res.arrayBuffer());
  },

  async remove(storageKey, resourceType) {
    ensureConfigured();
    await cloudinary.uploader.destroy(storageKey, { resource_type: resourceType || 'auto' });
  },
};

let impl = realImpl;
/** Used by tests to inject a fake storage backend instead of calling out to Cloudinary. */
function setImpl(customImpl) {
  impl = customImpl;
}

module.exports = {
  upload: (...args) => impl.upload(...args),
  fetchBuffer: (...args) => impl.fetchBuffer(...args),
  remove: (...args) => impl.remove(...args),
  setImpl,
  _realImpl: realImpl,
};
