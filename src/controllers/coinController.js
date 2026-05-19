const db = require("../config/db");
const {
  clearSelectedSpecialCoin,
} = require("../utils/coinHelpers");

function toNumber(value) {
  return Number(value || 0);
}

async function ensureMarketRows(connection) {
  await connection.execute(
    `
    INSERT IGNORE INTO coin_market_state (coin_id, status, current_price)
    SELECT id, 'AVAILABLE', 100
    FROM coin_catalog
    WHERE is_active = 1
    `,
  );
}

async function getUserBalance(connection, userId) {
  const [rows] = await connection.execute(
    `
    SELECT
      COALESCE(SUM(
        CASE
          WHEN direction = 'CREDIT' THEN amount
          WHEN direction = 'DEBIT' THEN -amount
          ELSE 0
        END
      ), 0) AS balance
    FROM balance_transactions
    WHERE user_id = ?
    `,
    [userId],
  );

  return Number(rows[0]?.balance || 0);
}

async function insertTransaction(connection, data) {
  await connection.execute(
    `
    INSERT INTO balance_transactions
    (
      user_id,
      created_by_user_id,
      session_id,
      type,
      direction,
      amount,
      from_unit,
      to_unit,
      note
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      data.user_id,
      data.created_by_user_id,
      data.session_id || null,
      data.type,
      data.direction,
      Number(data.amount || 0),
      data.from_unit || null,
      data.to_unit || "DOUBLE_O",
      data.note || null,
    ],
  );
}

function mapCoinRow(row, userId, balance, pendingRequestCoinIds) {
  const currentPrice = Number(row.current_price || 100);
  const ownedByMe = Number(row.owner_user_id || 0) === Number(userId);
  const isMarketOpen = row.status !== "EXCLUSIVE_LOCKED";
  const canBuy = isMarketOpen && !ownedByMe;
  const canListForSale = row.status === "PAID_OWNED" && ownedByMe;
  const hasPendingRequest = pendingRequestCoinIds.has(Number(row.id));
  const canRequestExclusive = isMarketOpen && !hasPendingRequest && (!ownedByMe || row.status === "PAID_OWNED");

  return {
    id: Number(row.id),
    code: row.code,
    title: row.title,
    description: row.description,
    category: row.category,
    image_mime: row.image_mime,
    image_base64: row.image_base64,
    sort_order: Number(row.sort_order || 0),
    status: row.status || "AVAILABLE",
    owner_user_id: row.owner_user_id === null ? null : Number(row.owner_user_id),
    owner_username: row.owner_username || null,
    current_price: currentPrice,
    last_purchase_price: row.last_purchase_price === null ? null : Number(row.last_purchase_price),
    sale_original_price: row.sale_original_price === null ? null : Number(row.sale_original_price),
    sale_seller_user_id: row.sale_seller_user_id === null ? null : Number(row.sale_seller_user_id),
    sale_seller_username: row.sale_seller_username || null,
    sale_paid_upfront: Number(row.sale_paid_upfront || 0),
    locked_forever: Boolean(row.locked_forever),
    has_pending_request: hasPendingRequest,
    owned_by_me: ownedByMe,
    can_buy: canBuy,
    can_list_for_sale: canListForSale,
    can_request_exclusive: canRequestExclusive,
    insufficient_balance: canBuy && balance < currentPrice,
  };
}

async function getCoins(req, res) {
  const connection = await db.getConnection();

  try {
    const userId = req.user.id;
    await ensureMarketRows(connection);

    const balance = await getUserBalance(connection, userId);

    const [pendingRows] = await connection.execute(
      `
      SELECT coin_id
      FROM coin_requests
      WHERE user_id = ? AND status = 'PENDING'
      `,
      [userId],
    );

    const pendingRequestCoinIds = new Set(pendingRows.map((row) => Number(row.coin_id)));

    const [selectedRows] = await connection.execute(
      `
      SELECT selected_coin_1, selected_coin_2
      FROM users
      WHERE id = ?
      LIMIT 1
      `,
      [userId],
    );

    const [coins] = await connection.execute(
      `
      SELECT
        cc.id,
        cc.code,
        cc.title,
        cc.description,
        cc.category,
        cc.image_mime,
        cc.image_base64,
        cc.sort_order,
        cms.status,
        cms.owner_user_id,
        owner.username AS owner_username,
        cms.current_price,
        cms.last_purchase_price,
        cms.sale_original_price,
        cms.sale_seller_user_id,
        seller.username AS sale_seller_username,
        cms.sale_paid_upfront,
        cms.locked_forever
      FROM coin_catalog cc
      JOIN coin_market_state cms ON cms.coin_id = cc.id
      LEFT JOIN users owner ON owner.id = cms.owner_user_id AND owner.is_active = 1
      LEFT JOIN users seller ON seller.id = cms.sale_seller_user_id AND seller.is_active = 1
      WHERE cc.is_active = 1
      ORDER BY cc.sort_order ASC, cc.id ASC
      `,
    );

    const selected = selectedRows[0] || {};

    res.json({
      balance,
      selected_coin_1: selected.selected_coin_1 || null,
      selected_coin_2: selected.selected_coin_2 || null,
      coins: coins.map((row) => mapCoinRow(row, userId, balance, pendingRequestCoinIds)),
    });
  } catch (error) {
    console.error("getCoins error:", error);
    res.status(500).json({ message: "Failed to load coins" });
  } finally {
    connection.release();
  }
}

async function buyCoin(req, res) {
  const connection = await db.getConnection();

  try {
    const userId = req.user.id;
    const coinId = Number(req.params.id);

    if (!Number.isInteger(coinId) || coinId <= 0) {
      return res.status(400).json({ message: "Invalid coin id" });
    }

    await connection.beginTransaction();
    await ensureMarketRows(connection);

    const [rows] = await connection.execute(
      `
      SELECT
        cc.id,
        cc.title,
        cms.status,
        cms.owner_user_id,
        cms.current_price,
        cms.last_purchase_price,
        cms.sale_original_price,
        cms.sale_seller_user_id,
        cms.sale_paid_upfront,
        cms.locked_forever
      FROM coin_catalog cc
      JOIN coin_market_state cms ON cms.coin_id = cc.id
      WHERE cc.id = ? AND cc.is_active = 1
      FOR UPDATE
      `,
      [coinId],
    );

    if (rows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: "Coin not found" });
    }

    const coin = rows[0];

    if (coin.status === "EXCLUSIVE_LOCKED" || coin.locked_forever) {
      await connection.rollback();
      return res.status(400).json({ message: "This coin is exclusive and is not for sale" });
    }

    if (Number(coin.owner_user_id || 0) === Number(userId)) {
      await connection.rollback();
      return res.status(400).json({ message: "You already own this coin" });
    }

    const price = Number(coin.current_price || 100);
    const balance = await getUserBalance(connection, userId);

    if (balance < price) {
      await connection.rollback();
      return res.status(400).json({ message: "Insufficient balance" });
    }

    await insertTransaction(connection, {
      user_id: userId,
      created_by_user_id: userId,
      session_id: null,
      type: "COIN_PURCHASE",
      direction: "DEBIT",
      amount: price,
      from_unit: "DOUBLE_O",
      to_unit: "COIN",
      note: `Bought treasure coin: ${coin.title}`,
    });

    const usersToClear = [];

    if (coin.status === "PAID_OWNED" && coin.owner_user_id) {
      const refundAmount = Number(coin.last_purchase_price || 0);

      if (refundAmount > 0) {
        await insertTransaction(connection, {
          user_id: coin.owner_user_id,
          created_by_user_id: userId,
          session_id: null,
          type: "COIN_REFUND",
          direction: "CREDIT",
          amount: refundAmount,
          from_unit: "COIN",
          to_unit: "DOUBLE_O",
          note: `Refund for ${coin.title} because it was bought by another player`,
        });
      }

      usersToClear.push(Number(coin.owner_user_id));
    }

    if (coin.status === "FOR_SALE" && coin.sale_seller_user_id) {
      const finalRefund = Math.max(0, Number(coin.sale_original_price || 0) - Number(coin.sale_paid_upfront || 0));

      if (finalRefund > 0) {
        await insertTransaction(connection, {
          user_id: coin.sale_seller_user_id,
          created_by_user_id: userId,
          session_id: null,
          type: "COIN_SALE_FINAL_REFUND",
          direction: "CREDIT",
          amount: finalRefund,
          from_unit: "COIN",
          to_unit: "DOUBLE_O",
          note: `Final sale refund for ${coin.title}`,
        });
      }

      usersToClear.push(Number(coin.sale_seller_user_id));
    }

    await clearSelectedSpecialCoin(connection, usersToClear, coinId);

    await connection.execute(
      `
      UPDATE coin_market_state
      SET
        status = 'PAID_OWNED',
        owner_user_id = ?,
        current_price = ?,
        last_purchase_price = ?,
        sale_original_price = NULL,
        sale_seller_user_id = NULL,
        sale_paid_upfront = 0,
        locked_forever = 0
      WHERE coin_id = ?
      `,
      [userId, price + 50, price, coinId],
    );

    await connection.commit();

    res.json({
      message: "Coin bought successfully",
      coinId,
      paid: price,
      nextPrice: price + 50,
    });
  } catch (error) {
    await connection.rollback();
    console.error("buyCoin error:", error);
    res.status(500).json({ message: "Failed to buy coin" });
  } finally {
    connection.release();
  }
}

async function listCoinForSale(req, res) {
  const connection = await db.getConnection();

  try {
    const userId = req.user.id;
    const coinId = Number(req.params.id);

    if (!Number.isInteger(coinId) || coinId <= 0) {
      return res.status(400).json({ message: "Invalid coin id" });
    }

    await connection.beginTransaction();
    await ensureMarketRows(connection);

    const [rows] = await connection.execute(
      `
      SELECT
        cc.id,
        cc.title,
        cms.status,
        cms.owner_user_id,
        cms.last_purchase_price,
        cms.locked_forever
      FROM coin_catalog cc
      JOIN coin_market_state cms ON cms.coin_id = cc.id
      WHERE cc.id = ? AND cc.is_active = 1
      FOR UPDATE
      `,
      [coinId],
    );

    if (rows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: "Coin not found" });
    }

    const coin = rows[0];

    if (coin.status !== "PAID_OWNED" || Number(coin.owner_user_id || 0) !== Number(userId)) {
      await connection.rollback();
      return res.status(400).json({ message: "You can only list paid coins that you currently own" });
    }

    if (coin.locked_forever) {
      await connection.rollback();
      return res.status(400).json({ message: "Exclusive coins cannot be listed for sale" });
    }

    const originalPrice = Number(coin.last_purchase_price || 0);

    if (originalPrice <= 0) {
      await connection.rollback();
      return res.status(400).json({ message: "This coin cannot be listed" });
    }

    const upfront = Math.floor(originalPrice / 2);

    await insertTransaction(connection, {
      user_id: userId,
      created_by_user_id: userId,
      session_id: null,
      type: "COIN_LIST_FOR_SALE",
      direction: "CREDIT",
      amount: upfront,
      from_unit: "COIN",
      to_unit: "DOUBLE_O",
      note: `Listed treasure coin for sale: ${coin.title}`,
    });

    await clearSelectedSpecialCoin(connection, [userId], coinId);

    await connection.execute(
      `
      UPDATE coin_market_state
      SET
        status = 'FOR_SALE',
        owner_user_id = NULL,
        current_price = ?,
        sale_original_price = ?,
        sale_seller_user_id = ?,
        sale_paid_upfront = ?,
        locked_forever = 0
      WHERE coin_id = ?
      `,
      [upfront, originalPrice, userId, upfront, coinId],
    );

    await connection.commit();

    res.json({
      message: "Coin listed for sale",
      coinId,
      upfront,
      price: upfront,
    });
  } catch (error) {
    await connection.rollback();
    console.error("listCoinForSale error:", error);
    res.status(500).json({ message: "Failed to list coin" });
  } finally {
    connection.release();
  }
}

async function requestExclusiveOwnership(req, res) {
  const connection = await db.getConnection();

  try {
    const userId = req.user.id;
    const coinId = Number(req.params.id);

    if (!Number.isInteger(coinId) || coinId <= 0) {
      return res.status(400).json({ message: "Invalid coin id" });
    }

    await connection.beginTransaction();
    await ensureMarketRows(connection);

    const [rows] = await connection.execute(
      `
      SELECT
        cc.id,
        cc.title,
        cms.status,
        cms.owner_user_id,
        cms.locked_forever
      FROM coin_catalog cc
      JOIN coin_market_state cms ON cms.coin_id = cc.id
      WHERE cc.id = ? AND cc.is_active = 1
      FOR UPDATE
      `,
      [coinId],
    );

    if (rows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: "Coin not found" });
    }

    const coin = rows[0];

    if (coin.status === "EXCLUSIVE_LOCKED" || coin.locked_forever) {
      await connection.rollback();
      return res.status(400).json({ message: "This coin is already exclusive" });
    }

    if (Number(coin.owner_user_id || 0) === Number(userId) && coin.status !== "PAID_OWNED") {
      await connection.rollback();
      return res.status(400).json({ message: "You already own this coin" });
    }

    const [pendingRows] = await connection.execute(
      `
      SELECT id
      FROM coin_requests
      WHERE coin_id = ? AND user_id = ? AND status = 'PENDING'
      LIMIT 1
      FOR UPDATE
      `,
      [coinId, userId],
    );

    if (pendingRows.length > 0) {
      await connection.rollback();
      return res.status(400).json({ message: "You already have a pending request for this coin" });
    }

    const [result] = await connection.execute(
      `
      INSERT INTO coin_requests (coin_id, user_id, status)
      VALUES (?, ?, 'PENDING')
      `,
      [coinId, userId],
    );

    await connection.commit();

    res.json({
      message: "Exclusive ownership request sent",
      requestId: Number(result.insertId),
      coinId,
    });
  } catch (error) {
    await connection.rollback();
    console.error("requestExclusiveOwnership error:", error);
    res.status(500).json({ message: "Failed to send request" });
  } finally {
    connection.release();
  }
}

module.exports = {
  getCoins,
  buyCoin,
  listCoinForSale,
  requestExclusiveOwnership,
};
