const db = require("../config/db");
const {
  getAchievementCoinCatalog,
  isAdminAchievementCode,
  isCardHandAchievementCode,
  normalizeAchievementCode,
  awardAchievementCoin,
  revokeAchievementCoin,
  clearSelectedAchievementCoin,
  recalculateBestHandEver,
} = require("../utils/achievementCoins");

async function getAchievementCoinsCatalog(req, res) {
  try {
    res.json({ coins: getAchievementCoinCatalog() });
  } catch (error) {
    console.error("getAchievementCoinsCatalog error:", error);
    res.status(500).json({ message: "Failed to load achievement coins" });
  }
}

async function grantAchievementCoinToUser(req, res) {
  const connection = await db.getConnection();

  try {
    const adminUserId = req.user.id;
    const targetUserId = Number(req.params.id);
    const coinCode = normalizeAchievementCode(req.body.coinCode);

    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    if (!coinCode || !isAdminAchievementCode(coinCode)) {
      return res.status(400).json({ message: "Invalid admin achievement coin" });
    }

    await connection.beginTransaction();
    const [userRows] = await connection.execute(
      "SELECT id FROM users WHERE id = ? AND is_active = 1 LIMIT 1 FOR UPDATE",
      [targetUserId],
    );

    if (userRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: "User not found" });
    }

    const result = await awardAchievementCoin(connection, {
      userId: targetUserId,
      coinCode,
      awardedByUserId: adminUserId,
      metadata: {
        source: "ADMIN_PANEL",
      },
    });

    if (isCardHandAchievementCode(coinCode)) {
      await recalculateBestHandEver(connection);
    }

    await connection.commit();

    res.json({
      message: result.awarded ? "Achievement coin awarded" : "User already has this achievement coin",
      awarded: result.awarded,
      userId: targetUserId,
      coin: result.coin || null,
    });
  } catch (error) {
    await connection.rollback();
    console.error("grantAchievementCoinToUser error:", error);
    res.status(500).json({ message: "Failed to award achievement coin" });
  } finally {
    connection.release();
  }
}

async function removeAchievementCoinFromUser(req, res) {
  const connection = await db.getConnection();

  try {
    const targetUserId = Number(req.params.id);
    const coinCode = normalizeAchievementCode(req.params.coinCode);

    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    if (!coinCode || !isAdminAchievementCode(coinCode)) {
      return res.status(400).json({ message: "Invalid admin achievement coin" });
    }

    await connection.beginTransaction();
    const result = await revokeAchievementCoin(connection, targetUserId, coinCode);

    await clearSelectedAchievementCoin(connection, coinCode, [targetUserId]);

    if (isCardHandAchievementCode(coinCode)) {
      await recalculateBestHandEver(connection);
    }

    await connection.commit();

    res.json({
      message: result.removed ? "Achievement coin removed" : "User did not have this achievement coin",
      removed: result.removed,
      userId: targetUserId,
      coinCode,
    });
  } catch (error) {
    await connection.rollback();
    console.error("removeAchievementCoinFromUser error:", error);
    res.status(500).json({ message: "Failed to remove achievement coin" });
  } finally {
    connection.release();
  }
}

module.exports = {
  getAchievementCoinsCatalog,
  grantAchievementCoinToUser,
  removeAchievementCoinFromUser,
};
