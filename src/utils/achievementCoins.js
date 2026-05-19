const ACHIEVEMENT_COIN_CATALOG = [
  {
    code: "DOUBLE_UP",
    title: "Double Up Coin",
    description: "Awarded once a player cashes out at least 2x their total buy-in for a session.",
    award_mode: "AUTO",
    image_name: "double-up-coin.png",
    sort_order: 10,
  },
  {
    code: "TRIPLE_UP",
    title: "Triple Up Coin",
    description: "Awarded once a player cashes out at least 3x their total buy-in for a session.",
    award_mode: "AUTO",
    image_name: "triple-up-coin.png",
    sort_order: 20,
  },
  {
    code: "MARKET_SHARK",
    title: "Market Shark Coin",
    description: "Awarded once a player buys a treasure coin that previously belonged to another player.",
    award_mode: "AUTO",
    image_name: "market-shark-coin.png",
    sort_order: 30,
  },
  {
    code: "HIGH_ROLLER",
    title: "High Roller Coin",
    description: "Awarded once a player buys a treasure coin for 300 O² or more.",
    award_mode: "AUTO",
    image_name: "high-roller-coin.png",
    sort_order: 40,
  },
  {
    code: "WIN_STREAK",
    title: "Win Streak Coin",
    description: "Awarded once a player finishes 2 sessions in a row with profit.",
    award_mode: "AUTO",
    image_name: "win-streak-coin.png",
    sort_order: 50,
  },
  {
    code: "HOT_STREAK",
    title: "Hot Streak Coin",
    description: "Awarded once a player finishes 3 sessions in a row with profit.",
    award_mode: "AUTO",
    image_name: "hot-streak-coin.png",
    sort_order: 60,
  },
  {
    code: "UNSTOPPABLE",
    title: "Unstoppable Coin",
    description: "Awarded once a player finishes 5 sessions in a row with profit.",
    award_mode: "AUTO",
    image_name: "unstoppable-coin.png",
    sort_order: 70,
  },
  {
    code: "PODIUM",
    title: "Podium Coin",
    description: "Awarded once a player reaches the top 3 places on the leaderboard.",
    award_mode: "AUTO",
    image_name: "podium-coin.png",
    sort_order: 80,
  },
  {
    code: "BEST_HAND_EVER",
    title: "Best Hand Ever Coin",
    description: "Admin-awarded coin for the strongest hand ever recorded in the app. If several players share the record, award it to each of them.",
    award_mode: "ADMIN",
    image_name: "best-hand-ever-coin.png",
    sort_order: 110,
  },
  {
    code: "HIGHEST_HAND",
    title: "Highest Hand Coin",
    description: "Admin-awarded coin for a player who won or revealed the strongest hand in a relevant session/night.",
    award_mode: "ADMIN",
    image_name: "highest-hand-coin.png",
    sort_order: 120,
  },
  {
    code: "AA_WIN",
    title: "Pocket Aces Coin",
    description: "Admin-awarded coin for winning a hand with pocket aces.",
    award_mode: "ADMIN",
    image_name: "aa-coin.png",
    sort_order: 130,
  },
  {
    code: "SEVEN_TWO_WIN",
    title: "Seven-Deuce Coin",
    description: "Admin-awarded coin for winning a hand with 7-2.",
    award_mode: "ADMIN",
    image_name: "seven-two-coin.png",
    sort_order: 140,
  },
];

const ACHIEVEMENT_COIN_BY_CODE = new Map(
  ACHIEVEMENT_COIN_CATALOG.map((coin) => [coin.code, coin]),
);

const ADMIN_ACHIEVEMENT_CODES = new Set(
  ACHIEVEMENT_COIN_CATALOG
    .filter((coin) => coin.award_mode === "ADMIN")
    .map((coin) => coin.code),
);

const CARD_HAND_RANKS = {
  HIGH_CARD: 1,
  PAIR: 2,
  TWO_PAIR: 3,
  THREE_OF_A_KIND: 4,
  STRAIGHT: 5,
  FLUSH: 6,
  FULL_HOUSE: 7,
  FOUR_OF_A_KIND: 8,
  STRAIGHT_FLUSH: 9,
  ROYAL_FLUSH: 10,
};

function normalizeAchievementCode(value) {
  const normalized = String(value || "").trim().toUpperCase();
  return ACHIEVEMENT_COIN_BY_CODE.has(normalized) ? normalized : null;
}

function isAdminAchievementCode(code) {
  return ADMIN_ACHIEVEMENT_CODES.has(normalizeAchievementCode(code));
}

function getAchievementCoinCatalog() {
  return ACHIEVEMENT_COIN_CATALOG.map((coin) => ({ ...coin }));
}

function isCardHandCoinEligible(cardHand) {
  const normalized = String(cardHand || "").trim().toUpperCase();
  return Number(CARD_HAND_RANKS[normalized] || 0) >= CARD_HAND_RANKS.FULL_HOUSE;
}

async function ensureAchievementCoinTables(connection) {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS user_achievement_coins (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      coin_code VARCHAR(64) NOT NULL,
      awarded_by_user_id BIGINT UNSIGNED NULL,
      source_session_id BIGINT UNSIGNED NULL,
      metadata_json TEXT NULL,
      awarded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_user_achievement_coin (user_id, coin_code),
      KEY idx_user_achievement_user (user_id),
      KEY idx_user_achievement_code (coin_code)
    )
  `);
}

async function awardAchievementCoin(connection, {
  userId,
  coinCode,
  awardedByUserId = null,
  sourceSessionId = null,
  metadata = null,
}) {
  const normalizedCode = normalizeAchievementCode(coinCode);
  const normalizedUserId = Number(userId);

  if (!normalizedCode || !Number.isInteger(normalizedUserId) || normalizedUserId <= 0) {
    return { awarded: false, reason: "INVALID_INPUT" };
  }


  const [userRows] = await connection.execute(
    "SELECT id FROM users WHERE id = ? AND is_active = 1 LIMIT 1",
    [normalizedUserId],
  );

  if (userRows.length === 0) {
    return { awarded: false, reason: "USER_NOT_FOUND" };
  }

  const metadataJson = metadata ? JSON.stringify(metadata) : null;

  const [result] = await connection.execute(
    `
    INSERT IGNORE INTO user_achievement_coins
      (user_id, coin_code, awarded_by_user_id, source_session_id, metadata_json)
    VALUES (?, ?, ?, ?, ?)
    `,
    [
      normalizedUserId,
      normalizedCode,
      awardedByUserId ? Number(awardedByUserId) : null,
      sourceSessionId ? Number(sourceSessionId) : null,
      metadataJson,
    ],
  );

  return {
    awarded: Number(result.affectedRows || 0) > 0,
    coin: ACHIEVEMENT_COIN_BY_CODE.get(normalizedCode),
  };
}

async function revokeAchievementCoin(connection, userId, coinCode) {
  const normalizedCode = normalizeAchievementCode(coinCode);
  const normalizedUserId = Number(userId);

  if (!normalizedCode || !Number.isInteger(normalizedUserId) || normalizedUserId <= 0) {
    return { removed: false, reason: "INVALID_INPUT" };
  }


  const [result] = await connection.execute(
    "DELETE FROM user_achievement_coins WHERE user_id = ? AND coin_code = ?",
    [normalizedUserId, normalizedCode],
  );

  return { removed: Number(result.affectedRows || 0) > 0 };
}

async function getAchievementCoinsForUserIds(connection, userIds) {
  const ids = [...new Set((userIds || [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0))];

  const map = new Map();
  ids.forEach((id) => map.set(id, []));

  if (ids.length === 0) {
    return map;
  }


  const placeholders = ids.map(() => "?").join(", ");
  const [rows] = await connection.execute(
    `
    SELECT
      user_id,
      coin_code,
      awarded_by_user_id,
      source_session_id,
      metadata_json,
      awarded_at
    FROM user_achievement_coins
    WHERE user_id IN (${placeholders})
    ORDER BY awarded_at ASC, id ASC
    `,
    ids,
  );

  rows.forEach((row) => {
    const catalogCoin = ACHIEVEMENT_COIN_BY_CODE.get(row.coin_code);
    if (!catalogCoin) return;

    const userId = Number(row.user_id);
    if (!map.has(userId)) map.set(userId, []);

    map.get(userId).push({
      ...catalogCoin,
      awarded_by_user_id: row.awarded_by_user_id === null ? null : Number(row.awarded_by_user_id),
      source_session_id: row.source_session_id === null ? null : Number(row.source_session_id),
      metadata_json: row.metadata_json || null,
      awarded_at: row.awarded_at,
    });
  });

  return map;
}

async function attachAchievementCoins(connection, rows, idField = "id") {
  const userIds = rows
    .map((row) => Number(row[idField]))
    .filter((id) => Number.isInteger(id) && id > 0);

  const coinsByUserId = await getAchievementCoinsForUserIds(connection, userIds);

  return rows.map((row) => ({
    ...row,
    achievement_coins: coinsByUserId.get(Number(row[idField])) || [],
  }));
}

async function awardMarketPurchaseAchievements(connection, {
  buyerUserId,
  coinId,
  price,
  previousOwnerUserId = null,
  previousSellerUserId = null,
}) {
  const awards = [];
  const buyerId = Number(buyerUserId);
  const previousOwnerId = Number(previousOwnerUserId || 0);
  const previousSellerId = Number(previousSellerUserId || 0);

  if (previousOwnerId > 0 || previousSellerId > 0) {
    awards.push(await awardAchievementCoin(connection, {
      userId: buyerId,
      coinCode: "MARKET_SHARK",
      awardedByUserId: buyerId,
      metadata: {
        coinId: Number(coinId),
        price: Number(price || 0),
        previousOwnerUserId: previousOwnerId || null,
        previousSellerUserId: previousSellerId || null,
      },
    }));
  }

  if (Number(price || 0) >= 300) {
    awards.push(await awardAchievementCoin(connection, {
      userId: buyerId,
      coinCode: "HIGH_ROLLER",
      awardedByUserId: buyerId,
      metadata: {
        coinId: Number(coinId),
        price: Number(price || 0),
      },
    }));
  }

  return awards;
}

async function getSessionResult(connection, sessionId, userId) {
  const [rows] = await connection.execute(
    `
    SELECT
      COALESCE(SUM(CASE WHEN type = 'TO_CHIPS' THEN amount_total ELSE 0 END), 0) AS buy_in_total,
      COALESCE(SUM(CASE WHEN type = 'TO_COINS' THEN amount_total ELSE 0 END), 0) AS cash_out_total
    FROM conversion_requests
    WHERE session_id = ?
      AND user_id = ?
      AND status = 'APPROVED'
    `,
    [sessionId, userId],
  );

  const buyInTotal = Number(rows[0]?.buy_in_total || 0);
  const cashOutTotal = Number(rows[0]?.cash_out_total || 0);

  return {
    buyInTotal,
    cashOutTotal,
    pnl: cashOutTotal - buyInTotal,
  };
}

async function getCurrentProfitStreak(connection, userId) {
  const [rows] = await connection.execute(
    `
    SELECT
      gs.id AS session_id,
      gs.ended_at,
      COALESCE(SUM(CASE WHEN cr.type = 'TO_CHIPS' THEN cr.amount_total ELSE 0 END), 0) AS buy_in_total,
      COALESCE(SUM(CASE WHEN cr.type = 'TO_COINS' THEN cr.amount_total ELSE 0 END), 0) AS cash_out_total
    FROM game_sessions gs
    JOIN conversion_requests cr
      ON cr.session_id = gs.id
     AND cr.user_id = ?
     AND cr.status = 'APPROVED'
    WHERE gs.status = 'ENDED'
    GROUP BY gs.id, gs.ended_at
    HAVING buy_in_total > 0
    ORDER BY COALESCE(gs.ended_at, '1970-01-01') DESC, gs.id DESC
    `,
    [userId],
  );

  let streak = 0;

  for (const row of rows) {
    const buyInTotal = Number(row.buy_in_total || 0);
    const cashOutTotal = Number(row.cash_out_total || 0);
    const isProfit = cashOutTotal - buyInTotal > 0;

    if (!isProfit) break;
    streak += 1;
  }

  return streak;
}

async function awardSessionResultAchievements(connection, {
  userId,
  sessionId,
  awardedByUserId = null,
}) {
  const result = await getSessionResult(connection, sessionId, userId);
  const awards = [];

  if (result.buyInTotal > 0) {
    const ratio = result.cashOutTotal / result.buyInTotal;

    if (ratio >= 2) {
      awards.push(await awardAchievementCoin(connection, {
        userId,
        coinCode: "DOUBLE_UP",
        awardedByUserId,
        sourceSessionId: sessionId,
        metadata: result,
      }));
    }

    if (ratio >= 3) {
      awards.push(await awardAchievementCoin(connection, {
        userId,
        coinCode: "TRIPLE_UP",
        awardedByUserId,
        sourceSessionId: sessionId,
        metadata: result,
      }));
    }
  }

  const streak = await getCurrentProfitStreak(connection, userId);

  if (streak >= 2) {
    awards.push(await awardAchievementCoin(connection, {
      userId,
      coinCode: "WIN_STREAK",
      awardedByUserId,
      sourceSessionId: sessionId,
      metadata: { streak },
    }));
  }

  if (streak >= 3) {
    awards.push(await awardAchievementCoin(connection, {
      userId,
      coinCode: "HOT_STREAK",
      awardedByUserId,
      sourceSessionId: sessionId,
      metadata: { streak },
    }));
  }

  if (streak >= 5) {
    awards.push(await awardAchievementCoin(connection, {
      userId,
      coinCode: "UNSTOPPABLE",
      awardedByUserId,
      sourceSessionId: sessionId,
      metadata: { streak },
    }));
  }

  return awards;
}

async function awardPodiumAchievements(connection, leaderboardRows) {
  const topThree = (leaderboardRows || []).slice(0, 3);
  const awards = [];

  for (const row of topThree) {
    awards.push(await awardAchievementCoin(connection, {
      userId: row.id,
      coinCode: "PODIUM",
      awardedByUserId: null,
      metadata: { rank: row.rank, balance: row.balance },
    }));
  }

  return awards;
}

module.exports = {
  ACHIEVEMENT_COIN_CATALOG,
  normalizeAchievementCode,
  isAdminAchievementCode,
  getAchievementCoinCatalog,
  isCardHandCoinEligible,
  ensureAchievementCoinTables,
  awardAchievementCoin,
  revokeAchievementCoin,
  getAchievementCoinsForUserIds,
  attachAchievementCoins,
  awardMarketPurchaseAchievements,
  awardSessionResultAchievements,
  awardPodiumAchievements,
};
