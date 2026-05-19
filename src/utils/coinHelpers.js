const BASIC_SELECTED_COINS = new Set(["APP", "CARD", "PLACE"]);

function normalizeSelectedCoinValue(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalized = String(value).trim().toUpperCase();

  if (BASIC_SELECTED_COINS.has(normalized)) {
    return normalized;
  }

  const specialMatch = normalized.match(/^SPECIAL_(\d+)$/);
  if (specialMatch) {
    const coinId = Number(specialMatch[1]);
    if (Number.isInteger(coinId) && coinId > 0) {
      return `SPECIAL_${coinId}`;
    }
  }

  return undefined;
}

function getSpecialCoinId(selectionValue) {
  const normalized = normalizeSelectedCoinValue(selectionValue);
  if (!normalized || normalized === undefined) return null;
  const match = normalized.match(/^SPECIAL_(\d+)$/);
  return match ? Number(match[1]) : null;
}

async function validateSelectedCoins(connection, userId, firstCoin, secondCoin) {
  const normalizedFirst = normalizeSelectedCoinValue(firstCoin);
  const normalizedSecond = normalizeSelectedCoinValue(secondCoin);

  if (normalizedFirst === undefined || normalizedSecond === undefined) {
    throw new Error("Invalid coin selection");
  }

  if (normalizedFirst && normalizedSecond && normalizedFirst === normalizedSecond) {
    throw new Error("Cannot select the same coin twice");
  }

  const specialIds = [getSpecialCoinId(normalizedFirst), getSpecialCoinId(normalizedSecond)].filter(Boolean);

  if (specialIds.length > 0) {
    const placeholders = specialIds.map(() => "?").join(", ");
    const [rows] = await connection.execute(
      `
      SELECT cms.coin_id
      FROM coin_market_state cms
      JOIN coin_catalog cc ON cc.id = cms.coin_id AND cc.is_active = 1
      WHERE cms.owner_user_id = ?
        AND cms.status IN ('PAID_OWNED', 'EXCLUSIVE_LOCKED')
        AND cms.coin_id IN (${placeholders})
      `,
      [userId, ...specialIds],
    );

    if (rows.length !== specialIds.length) {
      throw new Error("You can only select coins that belong to you");
    }
  }

  return {
    firstCoin: normalizedFirst,
    secondCoin: normalizedSecond,
  };
}

async function getSpecialCoinsForUserIds(connection, userIds) {
  const ids = [...new Set((userIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const map = new Map();

  ids.forEach((id) => map.set(id, []));

  if (ids.length === 0) {
    return map;
  }

  const placeholders = ids.map(() => "?").join(", ");
  const [rows] = await connection.execute(
    `
    SELECT
      cms.owner_user_id AS user_id,
      cc.id,
      cc.code,
      cc.title,
      cc.description,
      cc.category,
      cc.image_mime,
      cc.image_base64,
      CASE
        WHEN cms.status = 'EXCLUSIVE_LOCKED' OR cms.locked_forever = 1 THEN 'EXCLUSIVE'
        ELSE 'PAID'
      END AS ownership_type,
      cms.last_purchase_price,
      cms.locked_forever,
      cc.sort_order
    FROM coin_market_state cms
    JOIN coin_catalog cc ON cc.id = cms.coin_id AND cc.is_active = 1
    WHERE cms.owner_user_id IN (${placeholders})
      AND cms.status IN ('PAID_OWNED', 'EXCLUSIVE_LOCKED')
    ORDER BY cc.sort_order ASC, cc.id ASC
    `,
    ids,
  );

  rows.forEach((row) => {
    const userId = Number(row.user_id);
    if (!map.has(userId)) map.set(userId, []);
    map.get(userId).push({
      id: Number(row.id),
      code: row.code,
      title: row.title,
      description: row.description,
      category: row.category,
      image_mime: row.image_mime,
      image_base64: row.image_base64,
      ownership_type: row.ownership_type,
      last_purchase_price: row.last_purchase_price === null ? null : Number(row.last_purchase_price),
      locked_forever: Boolean(row.locked_forever),
    });
  });

  return map;
}

async function attachSpecialCoins(connection, rows, idField = "id") {
  const userIds = rows.map((row) => Number(row[idField])).filter((id) => Number.isInteger(id) && id > 0);
  const coinsByUserId = await getSpecialCoinsForUserIds(connection, userIds);

  return rows.map((row) => ({
    ...row,
    special_coins: coinsByUserId.get(Number(row[idField])) || [],
  }));
}

async function clearSelectedSpecialCoin(connection, userIds, coinId) {
  const ids = [...new Set((userIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const normalizedCoinId = Number(coinId);

  if (ids.length === 0 || !Number.isInteger(normalizedCoinId) || normalizedCoinId <= 0) {
    return;
  }

  const selectionKey = `SPECIAL_${normalizedCoinId}`;
  const placeholders = ids.map(() => "?").join(", ");

  await connection.execute(
    `
    UPDATE users
    SET
      selected_coin_1 = CASE WHEN selected_coin_1 = ? THEN NULL ELSE selected_coin_1 END,
      selected_coin_2 = CASE WHEN selected_coin_2 = ? THEN NULL ELSE selected_coin_2 END
    WHERE id IN (${placeholders})
    `,
    [selectionKey, selectionKey, ...ids],
  );
}

module.exports = {
  normalizeSelectedCoinValue,
  validateSelectedCoins,
  getSpecialCoinId,
  getSpecialCoinsForUserIds,
  attachSpecialCoins,
  clearSelectedSpecialCoin,
};
