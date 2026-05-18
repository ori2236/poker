async function getOwnedSpecialCoinsForUserIds(connection, userIds) {
  const ids = [...new Set((userIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
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
      cc.sort_order,
      cms.status,
      cms.last_purchase_price,
      cms.locked_forever
    FROM coin_market_state cms
    JOIN coin_catalog cc ON cc.id = cms.coin_id
    WHERE cms.owner_user_id IN (${placeholders})
      AND cms.status IN ('PAID_OWNED', 'EXCLUSIVE_LOCKED')
      AND cc.is_active = 1
    ORDER BY cc.sort_order ASC, cc.id ASC
    `,
    ids,
  );

  rows.forEach((row) => {
    const userId = Number(row.user_id);
    if (!map.has(userId)) {
      map.set(userId, []);
    }

    map.get(userId).push({
      id: Number(row.id),
      code: row.code,
      title: row.title,
      description: row.description,
      category: row.category,
      image_mime: row.image_mime,
      image_base64: row.image_base64,
      sort_order: Number(row.sort_order || 0),
      ownership_type: row.status === 'EXCLUSIVE_LOCKED' ? 'EXCLUSIVE' : 'PAID',
      last_purchase_price: row.last_purchase_price === null ? null : Number(row.last_purchase_price),
      locked_forever: Boolean(row.locked_forever),
    });
  });

  return map;
}

module.exports = {
  getOwnedSpecialCoinsForUserIds,
};
