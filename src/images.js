import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { resolve, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { AttachmentBuilder } from 'discord.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMAGES_DIR = resolve(__dirname, '..', 'data', 'images');
mkdirSync(IMAGES_DIR, { recursive: true });

/**
 * Download images from Discord CDN and save to disk.
 * Must be called BEFORE the source message is deleted or URLs expire.
 * Returns array of filenames like ['card_1.png', 'card_2.jpg']
 */
export async function downloadAndSave(predictionId, urls) {
  const dir = resolve(IMAGES_DIR, String(predictionId));
  mkdirSync(dir, { recursive: true });

  const filenames = [];

  for (let i = 0; i < urls.length; i++) {
    // Extract extension from URL (strip query params)
    const urlPath = new URL(urls[i]).pathname;
    const ext = extname(urlPath).toLowerCase() || '.png';
    const filename = `card_${i + 1}${ext}`;
    const filepath = resolve(dir, filename);

    try {
      const response = await fetch(urls[i]);
      if (!response.ok) {
        console.error(`Failed to download image ${i + 1} for prediction #${predictionId}: ${response.status}`);
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(filepath, buffer);
      filenames.push(filename);
    } catch (err) {
      console.error(`Error downloading image ${i + 1} for prediction #${predictionId}:`, err.message);
    }
  }

  return filenames;
}

/**
 * Build discord.js AttachmentBuilder array from saved images on disk.
 * Used when creating or editing messages that need image attachments.
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
