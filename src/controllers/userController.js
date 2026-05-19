const db = require("../config/db");
const bcrypt = require("bcrypt");
const { attachSpecialCoins, validateSelectedCoins } = require("../utils/coinHelpers");
const {
  awardCardHandAchievementCoin,
  isCardHandCoinEligible,
  recalculateBestHandEver,
} = require("../utils/achievementCoins");

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
  return CARD_HANDS.includes(normalized) ? normalized : null;
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
        secondary_profile_image_base64,
        created_at,
        card_hand,
        selected_coin_1,
        selected_coin_2,
        is_winner_coin_holder
      FROM users
      WHERE is_active = 1
      ORDER BY username ASC
    `);

    const normalizedRows = rows.map((row) => ({
      ...row,
      id: Number(row.id),
      is_winner_coin_holder: Boolean(row.is_winner_coin_holder),
      card_hand: row.card_hand || "HIGH_CARD",

      // חשוב: לא מחזירים כאן APP/CARD כברירת מחדל,
      // כדי ש-Clear All ומטבע אחד בלבד יעבדו באמת.
      selected_coin_1: row.selected_coin_1,
      selected_coin_2: row.selected_coin_2,
    }));

    const rowsWithCoins = await attachSpecialCoins(db, normalizedRows, "id");

    res.json(rowsWithCoins);
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

    let validated;

    try {
      validated = await validateSelectedCoins(db, userId, selectedCoin1, selectedCoin2);
    } catch (validationError) {
      return res.status(400).json({ message: validationError.message || "Invalid coin selection" });
    }

    const firstCoin = validated.firstCoin;
    const secondCoin = validated.secondCoin;

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
  const connection = await db.getConnection();

  try {
    const adminUserId = req.user.id;
    const targetUserId = Number(req.params.id);
    const cardHand = normalizeCardHand(req.body.cardHand);

    if (!targetUserId || Number.isNaN(targetUserId)) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    if (!cardHand) {
      return res.status(400).json({ message: "Invalid card hand" });
    }

    if (!isCardHandCoinEligible(cardHand)) {
      return res.status(400).json({ message: "Card coin is available only from Full House and above" });
    }

    await connection.beginTransaction();

    const [rows] = await connection.execute(
      "SELECT id, card_hand FROM users WHERE id = ? AND is_active = 1 LIMIT 1 FOR UPDATE",
      [targetUserId],
    );

    if (rows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: "User not found" });
    }

    const result = await awardCardHandAchievementCoin(connection, {
      userId: targetUserId,
      cardHand,
      awardedByUserId: adminUserId,
    });

    await connection.execute("UPDATE users SET card_hand = ? WHERE id = ?", [
      cardHand,
      targetUserId,
    ]);

    await connection.commit();

    res.json({
      message: result.awarded ? "Card coin awarded successfully" : "User already has this card coin",
      awarded: result.awarded,
      userId: targetUserId,
      cardHand,
      coin: result.coin || null,
    });
  } catch (error) {
    await connection.rollback();
    console.error("updateUserCardHand error:", error);
    res.status(500).json({ message: "Server error" });
  } finally {
    connection.release();
  }
}




async function deleteUser(req, res) {
  const connection = await db.getConnection();

  try {
    const adminUserId = req.user.id;
    const targetUserId = Number(req.params.id);
    const { adminPassword } = req.body;

    if (!targetUserId || Number.isNaN(targetUserId)) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    if (!adminPassword) {
      return res.status(400).json({ message: "Admin password is required" });
    }

    if (targetUserId === adminUserId) {
      return res.status(400).json({ message: "You cannot delete yourself" });
    }

    await connection.beginTransaction();

    const [adminRows] = await connection.execute(
      "SELECT password_hash FROM users WHERE id = ? AND role = 'ADMIN' AND is_active = 1 LIMIT 1",
      [adminUserId],
    );

    if (adminRows.length === 0) {
      await connection.rollback();
      return res.status(403).json({ message: "Admin user not found" });
    }

    const passwordValid = await bcrypt.compare(
      String(adminPassword),
      adminRows[0].password_hash,
    );

    if (!passwordValid) {
      await connection.rollback();
      return res.status(400).json({ message: "Admin password is incorrect" });
    }

    const [targetRows] = await connection.execute(
      "SELECT id, role FROM users WHERE id = ? AND is_active = 1 LIMIT 1 FOR UPDATE",
      [targetUserId],
    );

    if (targetRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: "User not found" });
    }

    if (targetRows[0].role === "ADMIN") {
      await connection.rollback();
      return res.status(400).json({ message: "Cannot delete an admin user" });
    }

    await connection.execute(
      "UPDATE users SET is_active = 0 WHERE id = ?",
      [targetUserId],
    );

    await connection.execute(
      "UPDATE auth_sessions SET is_active = 0 WHERE user_id = ?",
      [targetUserId],
    );

    await connection.execute(
      `
      UPDATE session_players
      SET is_playing = FALSE, left_at = COALESCE(left_at, NOW())
      WHERE user_id = ? AND is_playing = TRUE
      `,
      [targetUserId],
    );

    await connection.execute(
      `
      UPDATE conversion_requests
      SET status = 'REJECTED', admin_user_id = ?, admin_decision_at = NOW()
      WHERE user_id = ? AND status = 'PENDING'
      `,
      [adminUserId, targetUserId],
    );

    await connection.execute(
      `
      UPDATE coin_requests
      SET status = 'REJECTED', admin_user_id = ?, admin_decision_at = NOW()
      WHERE user_id = ? AND status = 'PENDING'
      `,
      [adminUserId, targetUserId],
    );

    await connection.execute(
      `
      UPDATE coin_market_state
      SET
        status = 'AVAILABLE',
        owner_user_id = NULL,
        locked_forever = 0,
        last_purchase_price = NULL,
        sale_original_price = NULL,
        sale_seller_user_id = NULL,
        sale_paid_upfront = 0,
        current_price = CASE WHEN current_price IS NULL OR current_price < 100 THEN 100 ELSE current_price END
      WHERE owner_user_id = ?
      `,
      [targetUserId],
    );

    await connection.execute(
      `
      UPDATE coin_market_state
      SET
        status = 'AVAILABLE',
        sale_original_price = NULL,
        sale_seller_user_id = NULL,
        sale_paid_upfront = 0,
        current_price = CASE WHEN current_price IS NULL OR current_price < 100 THEN 100 ELSE current_price END
      WHERE sale_seller_user_id = ?
      `,
      [targetUserId],
    );

    await connection.execute(
      "DELETE FROM user_achievement_coins WHERE user_id = ?",
      [targetUserId],
    );

    await recalculateBestHandEver(connection);

    await connection.execute(
      `
      UPDATE users
      SET selected_coin_1 = NULL, selected_coin_2 = NULL
      WHERE id = ?
      `,
      [targetUserId],
    );

    await connection.commit();

    res.json({ message: "User deleted successfully" });
  } catch (error) {
    await connection.rollback();
    console.error("deleteUser error:", error);
    res.status(500).json({ message: "Server error" });
  } finally {
    connection.release();
  }
}

async function updateUserSecondaryImage(req, res) {
  try {
    const targetUserId = Number(req.params.id);
    const { secondaryProfileImageBase64 } = req.body;

    if (!targetUserId || Number.isNaN(targetUserId)) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    const [rows] = await db.execute(
      "SELECT id FROM users WHERE id = ? AND is_active = 1 LIMIT 1",
      [targetUserId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const normalizedImage = secondaryProfileImageBase64
      ? String(secondaryProfileImageBase64)
      : null;

    await db.execute(
      "UPDATE users SET secondary_profile_image_base64 = ? WHERE id = ?",
      [normalizedImage, targetUserId],
    );

    res.json({
      message: "Secondary image updated successfully",
      userId: targetUserId,
    });
  } catch (error) {
    console.error("updateUserSecondaryImage error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function resetUserPassword(req, res) {
  try {
    const targetUserId = Number(req.params.id);

    if (!targetUserId || Number.isNaN(targetUserId)) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    const [rows] = await db.execute(
      "SELECT id, role FROM users WHERE id = ? AND is_active = 1 LIMIT 1",
      [targetUserId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    if (rows[0].role === "ADMIN") {
      return res.status(400).json({ message: "Cannot reset an admin password from here" });
    }

    const passwordHash = await bcrypt.hash("123456", 10);

    await db.execute("UPDATE users SET password_hash = ? WHERE id = ?", [
      passwordHash,
      targetUserId,
    ]);

    await db.execute(
      "UPDATE auth_sessions SET is_active = 0 WHERE user_id = ?",
      [targetUserId],
    );

    res.json({ message: "Password reset successfully" });
  } catch (error) {
    console.error("resetUserPassword error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

module.exports = {
  getAllUsers,
  updateMyProfile,
  changeMyPassword,
  updateMySelectedCoins,
  updateUserCardHand,
  deleteUser,
  updateUserSecondaryImage,
  resetUserPassword,
};
