const db = require("../config/db");
const bcrypt = require("bcrypt");

const CARD_HANDS = [
  "HIGH_CARD",
  "PAIR",
  "TWO_PAIR",
  "THREE_OF_A_KIND",
  "STRAIGHT",
  "FLUSH",
  "FULL_HOUSE",
  "FOUR_OF_A_KIND",
  "STRAIGHT_FLUSH",
  "ROYAL_FLUSH",
];

const SELECTABLE_COINS = ["APP", "CARD", "PLACE"];

function normalizeCardHand(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();

  if (!CARD_HANDS.includes(normalized)) {
    return null;
  }

  return normalized;
}

function normalizeSelectedCoin(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalized = String(value).trim().toUpperCase();

  if (!SELECTABLE_COINS.includes(normalized)) {
    return undefined;
  }

  return normalized;
}

async function getAllUsers(req, res) {
  try {
    const [rows] = await db.execute(`
      SELECT
        id,
        username,
        role,
        profile_image_base64,
        created_at,
        card_hand,
        selected_coin_1,
        selected_coin_2,
        is_winner_coin_holder
      FROM users
      WHERE is_active = 1
      ORDER BY username ASC
    `);

    res.json(
      rows.map((row) => ({
        ...row,
        id: Number(row.id),
        is_winner_coin_holder: Boolean(row.is_winner_coin_holder),
        card_hand: row.card_hand || "HIGH_CARD",
        selected_coin_1: row.selected_coin_1 || "APP",
        selected_coin_2: row.selected_coin_2 || "CARD",
      })),
    );
  } catch (error) {
    console.error("getAllUsers error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function updateMyProfile(req, res) {
  try {
    const userId = req.user.id;
    const { username, profileImageBase64 } = req.body;

    if (!username && !profileImageBase64) {
      return res.status(400).json({ message: "Nothing to update" });
    }

    if (username) {
      const trimmed = String(username).trim();

      if (!trimmed) {
        return res.status(400).json({ message: "Username cannot be empty" });
      }

      const [existingRows] = await db.execute(
        "SELECT id FROM users WHERE username = ? AND id <> ? LIMIT 1",
        [trimmed, userId],
      );

      if (existingRows.length > 0) {
        return res.status(400).json({ message: "Username already exists" });
      }
    }

    const fields = [];
    const values = [];

    if (username) {
      fields.push("username = ?");
      values.push(String(username).trim());
    }

    if (profileImageBase64) {
      fields.push("profile_image_base64 = ?");
      values.push(profileImageBase64);
    }

    values.push(userId);

    await db.execute(
      `
      UPDATE users
      SET ${fields.join(", ")}
      WHERE id = ?
      `,
      values,
    );

    res.json({ message: "Profile updated successfully" });
  } catch (error) {
    console.error("updateMyProfile error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function changeMyPassword(req, res) {
  try {
    const userId = req.user.id;
    const { currentPassword, newPassword, confirmNewPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmNewPassword) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    if (newPassword !== confirmNewPassword) {
      return res.status(400).json({ message: "New passwords do not match" });
    }

    if (newPassword.length < 4) {
      return res.status(400).json({ message: "New password is too short" });
    }

    const [rows] = await db.execute(
      "SELECT password_hash FROM users WHERE id = ? LIMIT 1",
      [userId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const isValid = await bcrypt.compare(
      currentPassword,
      rows[0].password_hash,
    );

    if (!isValid) {
      return res.status(400).json({ message: "Current password is incorrect" });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    await db.execute("UPDATE users SET password_hash = ? WHERE id = ?", [
      passwordHash,
      userId,
    ]);

    res.json({ message: "Password changed successfully" });
  } catch (error) {
    console.error("changeMyPassword error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function updateMySelectedCoins(req, res) {
  try {
    const userId = req.user.id;
    const { selectedCoin1, selectedCoin2 } = req.body;

    let firstCoin = normalizeSelectedCoin(selectedCoin1);
    let secondCoin = normalizeSelectedCoin(selectedCoin2);

    if (firstCoin === undefined || secondCoin === undefined) {
      return res.status(400).json({ message: "Invalid coin selection" });
    }

    if (!firstCoin && secondCoin) {
      firstCoin = secondCoin;
      secondCoin = null;
    }

    if (firstCoin && secondCoin && firstCoin === secondCoin) {
      return res
        .status(400)
        .json({ message: "Cannot select the same coin twice" });
    }

    await db.execute(
      `
      UPDATE users
      SET selected_coin_1 = ?, selected_coin_2 = ?
      WHERE id = ?
      `,
      [firstCoin, secondCoin, userId],
    );

    res.json({
      message: "Selected coins updated successfully",
      selected_coin_1: firstCoin,
      selected_coin_2: secondCoin,
    });
  } catch (error) {
    console.error("updateMySelectedCoins error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function updateUserCardHand(req, res) {
  try {
    const targetUserId = Number(req.params.id);
    const cardHand = normalizeCardHand(req.body.cardHand);

    if (!targetUserId || Number.isNaN(targetUserId)) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    if (!cardHand) {
      return res.status(400).json({ message: "Invalid card hand" });
    }

    const [rows] = await db.execute(
      "SELECT id FROM users WHERE id = ? AND is_active = 1 LIMIT 1",
      [targetUserId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    await db.execute("UPDATE users SET card_hand = ? WHERE id = ?", [
      cardHand,
      targetUserId,
    ]);

    res.json({
      message: "Card coin updated successfully",
      userId: targetUserId,
      cardHand,
    });
  } catch (error) {
    console.error("updateUserCardHand error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

module.exports = {
  getAllUsers,
  updateMyProfile,
  changeMyPassword,
  updateMySelectedCoins,
  updateUserCardHand,
};
