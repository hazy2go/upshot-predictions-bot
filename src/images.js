import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { AttachmentBuilder } from 'discord.js';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMAGES_DIR = resolve(__dirname, '..', 'data', 'images');
mkdirSync(IMAGES_DIR, { recursive: true });

// Max dimensions and file size for compressed images
const MAX_WIDTH = 1200;
const MAX_HEIGHT = 1200;
const JPEG_QUALITY = 80;
const MAX_FILE_SIZE = 500_000; // 500KB — skip compression if already under this

/**
 * Compress an image buffer. Returns a smaller JPEG/WebP buffer.
 * Fast path: skips compression if the file is already small enough.
 */
async function compress(buffer) {
  // Skip if already small
  if (buffer.length <= MAX_FILE_SIZE) {
    // Still resize if dimensions are huge
    try {
      const meta = await sharp(buffer).metadata();
      if (meta.width <= MAX_WIDTH && meta.height <= MAX_HEIGHT) {
        return { buffer, ext: `.${meta.format || 'png'}` };
      }
    } catch {
      return { buffer, ext: '.png' };
    }
  }

  try {
    const compressed = await sharp(buffer)
      .resize(MAX_WIDTH, MAX_HEIGHT, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
    return { buffer: compressed, ext: '.jpg' };
  } catch (err) {
    console.error('Image compression failed, using original:', err.message);
    return { buffer, ext: '.png' };
  }
}

/**
 * Download images from Discord CDN, compress, and save to disk.
 * Must be called BEFORE the source URLs expire.
 * Returns array of filenames like ['card_1.jpg', 'card_2.jpg']
 */
export async function downloadAndSave(predictionId, urls) {
  const dir = resolve(IMAGES_DIR, String(predictionId));
  mkdirSync(dir, { recursive: true });

  const filenames = [];

  for (let i = 0; i < urls.length; i++) {
    try {
      const response = await fetch(urls[i], { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) {
        console.error(`Failed to download image ${i + 1} for prediction #${predictionId}: ${response.status}`);
        continue;
      }

      const rawBuffer = Buffer.from(await response.arrayBuffer());
      const { buffer: finalBuffer, ext } = await compress(rawBuffer);
      const filename = `card_${i + 1}${ext}`;
      const filepath = resolve(dir, filename);

      writeFileSync(filepath, finalBuffer);
      filenames.push(filename);

      const saved = Math.round((1 - finalBuffer.length / rawBuffer.length) * 100);
      if (saved > 5) {
        console.log(`   Image ${i + 1} for #${predictionId}: ${Math.round(rawBuffer.length / 1024)}KB → ${Math.round(finalBuffer.length / 1024)}KB (-${saved}%)`);
      }
    } catch (err) {
      console.error(`Error downloading image ${i + 1} for prediction #${predictionId}:`, err.message);
    }
  }

  return filenames;
}

/**
 * Build discord.js AttachmentBuilder array from saved images on disk.
 */
export function getAttachmentBuilders(predictionId, filenames) {
  const dir = resolve(IMAGES_DIR, String(predictionId));
  const builders = [];

  for (const filename of filenames) {
    const filepath = resolve(dir, filename);
    if (existsSync(filepath)) {
      builders.push(new AttachmentBuilder(filepath, { name: filename }));
    }
  }

  return builders;
}

/**
 * Check if images exist on disk for a prediction.
 */
export function hasLocalImages(predictionId) {
  const dir = resolve(IMAGES_DIR, String(predictionId));
  if (!existsSync(dir)) return false;
  return readdirSync(dir).length > 0;
}
