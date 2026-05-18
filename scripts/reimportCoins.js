import fs from "fs";
import path from "path";
import pool from "../src/config/db.js";

const coinsDir = "C:\\Users\\ORI\\Desktop\\doubleO\\coins";

// אם אתה רוצה שגם שמות הקבצים עצמם בתיקייה ישתנו ל-coin-1.png וכו׳,
// תשנה ל-true.
// כרגע זה משנה את השמות ב-DB בלבד, שזה מה שבאמת חשוב לאפליקציה.
const RENAME_FILES_ON_DISK = true;

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();

  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function getSafeExt(filename) {
  const ext = path.extname(filename).toLowerCase();

  if (ext === ".jpg" || ext === ".jpeg") return ".jpg";
  if (ext === ".webp") return ".webp";
  return ".png";
}

async function reimportCoins() {
  const connection = await pool.getConnection();

  try {
    const files = fs
      .readdirSync(coinsDir)
      .filter((file) => /\.(png|jpg|jpeg|webp)$/i.test(file))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    if (files.length === 0) {
      console.log("No image files found in:", coinsDir);
      return;
    }

    await connection.beginTransaction();

    console.log("Deleting old coins from coin_catalog...");
    await connection.query("DELETE FROM coin_catalog");

    for (let i = 0; i < files.length; i++) {
      const originalFile = files[i];
      const coinNumber = i + 1;
      const coinName = `coin-${coinNumber}`;
      const originalPath = path.join(coinsDir, originalFile);
      const ext = getSafeExt(originalFile);

      let filePathToRead = originalPath;

      if (RENAME_FILES_ON_DISK) {
        const newFileName = `${coinName}${ext}`;
        const newPath = path.join(coinsDir, newFileName);

        if (originalPath !== newPath) {
          fs.renameSync(originalPath, newPath);
        }

        filePathToRead = newPath;
      }

      const imageMime = getMimeType(filePathToRead);
      const imageBase64 = fs.readFileSync(filePathToRead).toString("base64");

      await connection.query(
        `
        INSERT INTO coin_catalog
          (
            code,
            title,
            description,
            category,
            image_mime,
            image_base64,
            is_active,
            sort_order
          )
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          coinName,
          coinName,
          null,
          "CUSTOM",
          imageMime,
          imageBase64,
          1,
          coinNumber,
        ],
      );

      console.log(`Imported ${coinName} from ${path.basename(filePathToRead)}`);
    }

    await connection.commit();

    console.log("");
    console.log(
      `Done. Deleted old coins and imported ${files.length} new coins.`,
    );
  } catch (error) {
    await connection.rollback();
    console.error("Failed to reimport coins:", error);
    process.exitCode = 1;
  } finally {
    connection.release();
    await pool.end();
  }
}

reimportCoins();
