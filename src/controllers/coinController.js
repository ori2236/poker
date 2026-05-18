const db = require("../config/db");
const { getOwnedSpecialCoinsForUserIds } = require("../utils/coinUtils");

const STARTING_PRICE = 100;
const PRICE_STEP = 50;

function normalizeSelectedCoinCode(value) {
  if (value === null || value === undefined || value === "") return null;
  return String(value).trim();
}

function normalizeStatus(value) {
  if (value === "PAID_OWNED" || value === "FOR_SALE" || value === "EXCLUSIVE_LOCKED") {
    return value;
  }
  return "AVAILABLE";
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
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
    `,
    [
      data.user_id,
      data.created_by_user_id,
      data.type,
      data.direction,
      data.amount,
      data.from_unit,
      data.to_unit,
      data.note,
    ],
  );
}

async function ensureMarketState(connection, coinId) {
  await connection.execute(
    `
    INSERT IGNORE INTO coin_market_state (coin_id, status, current_price)
    VALUES (?, 'AVAILABLE', ?)
    `,
    [coinId, STARTING_PRICE],
  );

  const [rows] = await connection.execute(
    `
    SELECT *
    FROM coin_market_state
    WHERE coin_id = ?
    LIMIT 1
    FOR UPDATE
    `,
    [coinId],
  );

  return rows[0] || null;
}

async function getActiveCoinForUpdate(connection, coinId) {
  const [coinRows] = await connection.execute(
    `
    SELECT id, code, title, description, category, image_mime, image_base64, sort_order
    FROM coin_catalog
    WHERE id = ? AND is_active = 1
    LIMIT 1
    FOR UPDATE
    `,
    [coinId],
  );

  if (coinRows.length === 0) {
    return null;
  }

  const state = await ensureMarketState(connection, coinId);

  return {
    coin: coinRows[0],
    state,
  };
}

async function getCoins(req, res) {
  try {
    const userId = req.user.id;
    const [coins] = await db.execute(
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
        COALESCE(cms.status, 'AVAILABLE') AS status,
        COALESCE(cms.current_price, ?) AS current_price,
        cms.owner_user_id,
        owner.username AS owner_username,
        cms.last_purchase_price,
        cms.sale_original_price,
        cms.sale_seller_user_id,
        seller.username AS sale_seller_username,
        cms.sale_paid_upfront,
        COALESCE(cms.locked_forever, 0) AS locked_forever,
        EXISTS(
          SELECT 1
          FROM coin_requests cr
          WHERE cr.coin_id = cc.id
            AND cr.user_id = ?
            AND cr.status = 'PENDING'
        ) AS has_pending_request
      FROM coin_catalog cc
      LEFT JOIN coin_market_state cms ON cms.coin_id = cc.id
      LEFT JOIN users owner ON owner.id = cms.owner_user_id
      LEFT JOIN users seller ON seller.id = cms.sale_seller_user_id
      WHERE cc.is_active = 1
      ORDER BY cc.sort_order ASC, cc.id ASC
      `,
      [STARTING_PRICE, userId],
    );

    const balance = await getUserBalance(db, userId);

    res.json({
      balance,
      priceStep: PRICE_STEP,
      coins: coins.map((row) => {
        const status = normalizeStatus(row.status);
        const currentPrice = Number(row.current_price || STARTING_PRICE);
        const ownerUserId = row.owner_user_id === null || row.owner_user_id === undefined ? null : Number(row.owner_user_id);
        const saleSellerUserId = row.sale_seller_user_id === null || row.sale_seller_user_id === undefined ? null : Number(row.sale_seller_user_id);
        const ownedByMe = ownerUserId === userId;
        const isExclusive = status === "EXCLUSIVE_LOCKED" || Number(row.locked_forever) === 1;
        const canBuy = !isExclusive && !ownedByMe && currentPrice > 0;
        const canListForSale = status === "PAID_OWNED" && ownedByMe && Number(row.last_purchase_price || 0) > 0;
        const canRequestExclusive = !isExclusive && Number(row.has_pending_request || 0) !== 1;

        return {
          id: Number(row.id),
          code: row.code,
          title: row.title,
          description: row.description,
          category: row.category,
          image_mime: row.image_mime,
          image_base64: row.image_base64,
          sort_order: Number(row.sort_order || 0),
          status,
          current_price: currentPrice,
          owner_user_id: ownerUserId,
          owner_username: row.owner_username || null,
          last_purchase_price: row.last_purchase_price === null ? null : Number(row.last_purchase_price),
          sale_original_price: row.sale_original_price === null ? null : Number(row.sale_original_price),
          sale_seller_user_id: saleSellerUserId,
          sale_seller_username: row.sale_seller_username || null,
          sale_paid_upfront: row.sale_paid_upfront === null ? 0 : Number(row.sale_paid_upfront),
          locked_forever: isExclusive,
          has_pending_request: Boolean(row.has_pending_request),
          owned_by_me: ownedByMe,
          can_buy: canBuy,
          can_list_for_sale: canListForSale,
          can_request_exclusive: canRequestExclusive,
          insufficient_balance: canBuy && balance < currentPrice,
        };
      }),
    });
  } catch (error) {
    console.error("getCoins error:", error);
    res.status(500).json({ message: "Failed to load coins" });
  }
}

async function getMyCoinCollection(req, res) {
  try {
    const coinsMap = await getOwnedSpecialCoinsForUserIds(db, [req.user.id]);
    res.json({ coins: coinsMap.get(req.user.id) || [] });
  } catch (error) {
    console.error("getMyCoinCollection error:", error);
    res.status(500).json({ message: "Failed to load collection" });
  }
}

async function getUserCoinCollection(req, res) {
  try {
    const userId = Number(req.params.userId);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    const coinsMap = await getOwnedSpecialCoinsForUserIds(db, [userId]);
    res.json({ userId, coins: coinsMap.get(userId) || [] });
  } catch (error) {
    console.error("getUserCoinCollection error:", error);
    res.status(500).json({ message: "Failed to load collection" });
  }
}

async function updateSelectedCoins(req, res) {
  try {
    const { selected_coin_1, selected_coin_2 } = req.body;
    const first = normalizeSelectedCoinCode(selected_coin_1);
    const second = normalizeSelectedCoinCode(selected_coin_2);

    if (first && second && first === second) {
      return res.status(400).json({ message: "Choose two different coins." });
    }

    const codes = [first, second].filter(Boolean);

    if (codes.length > 0) {
      const placeholders = codes.map(() => "?").join(", ");
      const [existing] = await db.execute(
        `
        SELECT code
        FROM coin_catalog
        WHERE code IN (${placeholders}) AND is_active = 1
        `,
        codes,
      );

      if (existing.length !== codes.length) {
        return res.status(400).json({ message: "Invalid coin selected." });
      }
    }

    await db.execute(
      `
      UPDATE users
      SET selected_coin_1 = ?, selected_coin_2 = ?
      WHERE id = ?
      `,
      [first, second, req.user.id],
    );

    res.json({
      message: "Selected coins updated",
      selected_coin_1: first,
      selected_coin_2: second,
    });
  } catch (error) {
    console.error("updateSelectedCoins error:", error);
    res.status(500).json({ message: "Failed to update selected coins" });
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

    const data = await getActiveCoinForUpdate(connection, coinId);

    if (!data) {
      await connection.rollback();
      return res.status(404).json({ message: "Coin not found" });
    }

    const { coin, state } = data;
    const status = normalizeStatus(state.status);
    const lockedForever = Number(state.locked_forever || 0) === 1 || status === "EXCLUSIVE_LOCKED";
    const currentPrice = Number(state.current_price || STARTING_PRICE);
    const currentOwnerId = state.owner_user_id === null ? null : Number(state.owner_user_id);

    if (lockedForever) {
      await connection.rollback();
      return res.status(400).json({ message: "This coin is exclusive and will never be for sale" });
    }

    if (status === "PAID_OWNED" && currentOwnerId === userId) {
      await connection.rollback();
      return res.status(400).json({ message: "You already own this coin" });
    }

    if (currentPrice <= 0) {
      await connection.rollback();
      return res.status(400).json({ message: "Coin is not available for purchase" });
    }

    const balance = await getUserBalance(connection, userId);

    if (balance < currentPrice) {
      await connection.rollback();
      return res.status(400).json({ message: `Insufficient balance. You need ${currentPrice - balance} more O².` });
    }

    await insertTransaction(connection, {
      user_id: userId,
      created_by_user_id: userId,
      type: "COIN_PURCHASE",
      direction: "DEBIT",
      amount: currentPrice,
      from_unit: "DOUBLE_O",
      to_unit: null,
      note: `Bought coin: ${coin.title}`,
    });

    if (status === "PAID_OWNED" && currentOwnerId && currentOwnerId !== userId) {
      const refundAmount = Number(state.last_purchase_price || 0);

      if (refundAmount > 0) {
        await insertTransaction(connection, {
          user_id: currentOwnerId,
          created_by_user_id: userId,
          type: "COIN_OWNER_REFUND",
          direction: "CREDIT",
          amount: refundAmount,
          from_unit: null,
          to_unit: "DOUBLE_O",
          note: `Refund for ${coin.title}: bought by another player`,
        });
      }
    }

    if (status === "FOR_SALE" && state.sale_seller_user_id) {
      const sellerId = Number(state.sale_seller_user_id);
      const remainingRefund = Math.max(0, Number(state.sale_original_price || 0) - Number(state.sale_paid_upfront || 0));

      if (sellerId !== userId && remainingRefund > 0) {
        await insertTransaction(connection, {
          user_id: sellerId,
          created_by_user_id: userId,
          type: "COIN_SALE_FINAL_REFUND",
          direction: "CREDIT",
          amount: remainingRefund,
          from_unit: null,
          to_unit: "DOUBLE_O",
          note: `Final sale refund for ${coin.title}`,
        });
      }
    }

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
        locked_forever = 0,
        updated_at = NOW()
      WHERE coin_id = ?
      `,
      [userId, currentPrice + PRICE_STEP, currentPrice, coinId],
    );

    await connection.commit();

    res.json({
      message: "Coin bought successfully",
      coinId,
      paid: currentPrice,
      nextPrice: currentPrice + PRICE_STEP,
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

    const data = await getActiveCoinForUpdate(connection, coinId);

    if (!data) {
      await connection.rollback();
      return res.status(404).json({ message: "Coin not found" });
    }

    const { coin, state } = data;
    const status = normalizeStatus(state.status);
    const currentOwnerId = state.owner_user_id === null ? null : Number(state.owner_user_id);
    const purchasePrice = Number(state.last_purchase_price || 0);

    if (status !== "PAID_OWNED" || currentOwnerId !== userId || purchasePrice <= 0) {
      await connection.rollback();
      return res.status(400).json({ message: "You can list only a coin you bought from the Treasure Room" });
    }

    const upfrontRefund = Math.floor(purchasePrice / 2);

    if (upfrontRefund > 0) {
      await insertTransaction(connection, {
        user_id: userId,
        created_by_user_id: userId,
        type: "COIN_LIST_FOR_SALE",
        direction: "CREDIT",
        amount: upfrontRefund,
        from_unit: null,
        to_unit: "DOUBLE_O",
        note: `Listed ${coin.title} for sale`,
      });
    }

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
        locked_forever = 0,
        updated_at = NOW()
      WHERE coin_id = ?
      `,
      [upfrontRefund, purchasePrice, userId, upfrontRefund, coinId],
    );

    await connection.commit();

    res.json({
      message: "Coin listed for sale",
      coinId,
      upfrontRefund,
      salePrice: upfrontRefund,
    });
  } catch (error) {
    await connection.rollback();
    console.error("listCoinForSale error:", error);
    res.status(500).json({ message: "Failed to list coin for sale" });
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

    const data = await getActiveCoinForUpdate(connection, coinId);

    if (!data) {
      await connection.rollback();
      return res.status(404).json({ message: "Coin not found" });
    }

    const { state } = data;
    const status = normalizeStatus(state.status);
    const ownerUserId = state.owner_user_id === null ? null : Number(state.owner_user_id);

    if (status === "EXCLUSIVE_LOCKED" || Number(state.locked_forever || 0) === 1) {
      await connection.rollback();
      return res.status(400).json({ message: "This coin is already exclusive" });
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

    res.status(201).json({
      message: "Exclusive ownership request sent",
      requestId: result.insertId,
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
  getMyCoinCollection,
  getUserCoinCollection,
  updateSelectedCoins,
  buyCoin,
  listCoinForSale,
  requestExclusiveOwnership,
};
