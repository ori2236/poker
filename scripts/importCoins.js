import fs from "fs";
import path from "path";
import pool from "../src/config/db.js";

const imagesDir = path.resolve("assets");

function filenameToCode(filename) {
  return path
    .parse(filename)
    .name.trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function filenameToTitle(filename) {
  return path
    .parse(filename)
    .name.replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getMime(filename) {
  const ext = path.extname(filename).toLowerCase();

  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

async function importCoins() {
  const files = fs
    .readdirSync(imagesDir)
    .filter((file) => /\.(png|jpg|jpeg|webp)$/i.test(file));

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fullPath = path.join(imagesDir, file);

    const code = filenameToCode(file);
    const title = filenameToTitle(file);
    const imageMime = getMime(file);
    const imageBase64 = fs.readFileSync(fullPath).toString("base64");

    await pool.query(
      `
      INSERT INTO coin_catalog
        (code, title, category, image_mime, image_base64, sort_order, is_active)
      VALUES
        (?, ?, 'CUSTOM', ?, ?, ?, 1)
      ON DUPLICATE KEY UPDATE
        title = VALUES(title),
        image_mime = VALUES(image_mime),
        image_base64 = VALUES(image_base64),
        sort_order = VALUES(sort_order),
        is_active = 1
      `,
      [code, title, imageMime, imageBase64, i],
    );

    console.log(`Imported ${code}`);
  }

  console.log("Done");
  process.exit(0);
}

importCoins().catch((error) => {
  console.error(error);
  process.exit(1);
});
