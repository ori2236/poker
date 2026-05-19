import fs from "fs";
import path from "path";
import pool from "../src/config/db.js";

const sourceCoinsDir = "C:\\Users\\ORI\\Desktop\\doubleO\\coins";

// נוציא את התמונות עם שמות חדשים לתיקייה חדשה, כדי לא לדרוס שום קובץ מקורי
const outputBaseDir = "C:\\Users\\ORI\\Desktop\\doubleO";

// מוחק את המטבעות הישנים מה-DB לפני העלאה מחדש
const DELETE_OLD_COINS_FROM_DB = true;

function getTimestamp() {
  const now = new Date();

  const pad = (value) => String(value).padStart(2, "0");

  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`,
  ].join("-");
}

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

function assertDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Folder does not exist: ${dirPath}`);
  }

  const stat = fs.statSync(dirPath);

  if (!stat.isDirectory()) {
    throw new Error(`Path is not a folder: ${dirPath}`);
  }
}

async function safeReimportCoins() {
  const timestamp = getTimestamp();
  const renamedCoinsDir = path.join(
    outputBaseDir,
    `coins-renamed-${timestamp}`,
  );

  assertDirectoryExists(sourceCoinsDir);

  const sourceFiles = fs
    .readdirSync(sourceCoinsDir)
    .filter((file) => /\.(png|jpg|jpeg|webp)$/i.test(file))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (sourceFiles.length === 0) {
    console.log("No image files found in:", sourceCoinsDir);
    return;
  }

  if (fs.existsSync(renamedCoinsDir)) {
    throw new Error(
      `Output folder already exists, stopping to avoid overwrite: ${renamedCoinsDir}`,
    );
  }

  fs.mkdirSync(renamedCoinsDir, { recursive: false });

  console.log("Source folder:");
  console.log(sourceCoinsDir);
  console.log("");
  console.log("New renamed copies folder:");
  console.log(renamedCoinsDir);
  console.log("");

  const renamedFiles = [];

  for (let i = 0; i < sourceFiles.length; i++) {
    const originalFile = sourceFiles[i];
    const coinNumber = i + 1;
    const coinName = `coin-${coinNumber}`;
    const ext = getSafeExt(originalFile);

    const originalPath = path.join(sourceCoinsDir, originalFile);
    const newFileName = `${coinName}${ext}`;
    const newPath = path.join(renamedCoinsDir, newFileName);

    if (fs.existsSync(newPath)) {
      throw new Error(
        `Target file already exists, stopping to avoid overwrite: ${newPath}`,
      );
    }

    // חשוב: copyFileSync ולא renameSync
    // זה לא מוחק ולא דורס את הקבצים המקוריים
    fs.copyFileSync(originalPath, newPath);

    renamedFiles.push({
      coinNumber,
      coinName,
      originalFile,
      newFileName,
      newPath,
      imageMime: getMimeType(newFileName),
    });

    console.log(`Copied: ${originalFile}  ->  ${newFileName}`);
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    if (DELETE_OLD_COINS_FROM_DB) {
      console.log("");
      console.log("Deleting old coins from coin_catalog...");
      await connection.query("DELETE FROM coin_catalog");
    }

    console.log("");
    console.log("Uploading coins to DB...");

    for (const coin of renamedFiles) {
      const imageBase64 = fs.readFileSync(coin.newPath).toString("base64");

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
          coin.coinName,
          coin.coinName,
          null,
          "CUSTOM",
          coin.imageMime,
          imageBase64,
          1,
          coin.coinNumber,
        ],
      );

      console.log(`Uploaded: ${coin.coinName}`);
    }

    await connection.commit();

    console.log("");
    console.log("Done.");
    console.log(`Created renamed copies in: ${renamedCoinsDir}`);
    console.log(`Uploaded ${renamedFiles.length} coins to DB.`);
    console.log("");
    console.log("Original files were NOT changed.");
  } catch (error) {
    await connection.rollback();

    console.error("");
    console.error("Failed to upload coins. DB changes were rolled back.");
    console.error(error);

    process.exitCode = 1;
  } finally {
    connection.release();
    await pool.end();
  }
}

safeReimportCoins().catch((error) => {
  console.error("");
  console.error("Script failed before DB upload:");
  console.error(error);
  process.exitCode = 1;
});
