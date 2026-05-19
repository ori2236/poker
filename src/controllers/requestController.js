const db = require("../config/db");
const { clearSelectedSpecialCoin } = require("../utils/coinHelpers");

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
      data.session_id,
      data.type,
      data.direction,
      data.amount,
      data.from_unit,
      data.to_unit,
      data.note,
    ],
  );
}

async function getPendingRequests(req, res) {
  try {
    const [conversionRows] = await db.execute(
      `
      SELECT
        cr.id,
        'CONVERSION' AS request_kind,
        u.username,
        cr.type AS conversion_type,
        NULL AS bonus_title,
        cr.amount_total,
        cr.created_at
      FROM conversion_requests cr
      JOIN users u ON u.id = cr.user_id
      WHERE cr.status = 'PENDING'
      `,
    );

    const [bonusRows] = await db.execute(
      `
      SELECT
        br.id,
        'BONUS' AS request_kind,
        u.username,
        NULL AS conversion_type,
        b.title AS bonus_title,
        br.amount_snapshot AS amount_total,
        br.created_at
      FROM bonus_requests br
      JOIN users u ON u.id = br.user_id
      JOIN bonuses b ON b.id = br.bonus_id
      WHERE br.status = 'PENDING'
      `,
    );

    const [coinRows] = await db.execute(
      `
      SELECT
        cor.id,
        'COIN' AS request_kind,
        u.username,
        NULL AS conversion_type,
        NULL AS bonus_title,
        cc.title AS coin_title,
        cc.image_mime AS coin_image_mime,
        cc.image_base64 AS coin_image_base64,
        0 AS amount_total,
        cor.created_at
      FROM coin_requests cor
      JOIN users u ON u.id = cor.user_id
      JOIN coin_catalog cc ON cc.id = cor.coin_id
      WHERE cor.status = 'PENDING'
        AND cc.is_active = 1
      `,
    );

    const merged = [...conversionRows, ...bonusRows, ...coinRows].sort((a, b) => {
      const aTime = new Date(a.created_at).getTime();
      const bTime = new Date(b.created_at).getTime();
      if (aTime !== bTime) return aTime - bTime;
      return Number(a.id) - Number(b.id);
    });

    res.json(
      merged.map((row) => ({
        id: Number(row.id),
        request_kind: row.request_kind,
        username: row.username,
        conversion_type: row.conversion_type,
        bonus_title: row.bonus_title,
        coin_title: row.coin_title || null,
        coin_image_mime: row.coin_image_mime || null,
        coin_image_base64: row.coin_image_base64 || null,
        amount_total: Number(row.amount_total || 0),
        created_at: row.created_at,
      })),
    );
  } catch (error) {
    console.error("getPendingRequests error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function approveBonusRequest(req, res) {
  const connection = await db.getConnection();

  try {
    const requestId = Number(req.params.id);
    const adminUserId = req.user.id;

    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ message: "Invalid request id" });
    }

    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `
      SELECT br.*, b.title AS bonus_title
      FROM bonus_requests br
      JOIN bonuses b ON b.id = br.bonus_id
      WHERE br.id = ?
      FOR UPDATE
      `,
      [requestId],
    );

    if (rows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: "Bonus request not found" });
    }

    const request = rows[0];

    if (request.status !== "PENDING") {
      await connection.rollback();
      return res.status(400).json({ message: "Request already handled" });
    }

    await insertTransaction(connection, {
      user_id: request.user_id,
      created_by_user_id: adminUserId,
      session_id: null,
      type: "BONUS",
      direction: "CREDIT",
      amount: Number(request.amount_snapshot),
      from_unit: null,
      to_unit: "DOUBLE_O",
      note: `Approved bonus: ${request.bonus_title}`,
    });

    await connection.execute(
      `
      UPDATE bonus_requests
      SET
        status = 'APPROVED',
        admin_user_id = ?,
        admin_decision_at = NOW()
      WHERE id = ?
      `,
      [adminUserId, requestId],
    );

    await connection.commit();

    res.json({
      message: "Bonus request approved successfully",
      requestId,
      amount: Number(request.amount_snapshot),
    });
  } catch (error) {
    await connection.rollback();
    console.error("approveBonusRequest error:", error);
    res.status(500).json({ message: "Server error" });
  } finally {
    connection.release();
  }
}

async function rejectBonusRequest(req, res) {
  try {
    const requestId = Number(req.params.id);
    const adminUserId = req.user.id;

    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ message: "Invalid request id" });
    }

    const [rows] = await db.execute(
      `
      SELECT id, status
      FROM bonus_requests
      WHERE id = ?
      LIMIT 1
      `,
      [requestId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Bonus request not found" });
    }

    if (rows[0].status !== "PENDING") {
      return res.status(400).json({ message: "Request already handled" });
    }

    await db.execute(
      `
      UPDATE bonus_requests
      SET
        status = 'REJECTED',
        admin_user_id = ?,
        admin_decision_at = NOW()
      WHERE id = ?
      `,
      [adminUserId, requestId],
    );

    res.json({
      message: "Bonus request rejected successfully",
      requestId,
    });
  } catch (error) {
    console.error("rejectBonusRequest error:", error);
    res.status(500).json({ message: "Server error" });
  }
}


async function approveCoinRequest(req, res) {
  const connection = await db.getConnection();

  try {
    const requestId = Number(req.params.id);
    const adminUserId = req.user.id;

    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ message: "Invalid request id" });
    }

    await connection.beginTransaction();

    const [requestRows] = await connection.execute(
      `
      SELECT
        cor.id,
        cor.coin_id,
        cor.user_id,
        cor.status,
        u.username,
        cc.title AS coin_title
      FROM coin_requests cor
      JOIN users u ON u.id = cor.user_id AND u.is_active = 1
      JOIN coin_catalog cc ON cc.id = cor.coin_id AND cc.is_active = 1
      WHERE cor.id = ?
      FOR UPDATE
      `,
      [requestId],
    );

    if (requestRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: "Coin request not found" });
    }

    const request = requestRows[0];

    if (request.status !== "PENDING") {
      await connection.rollback();
      return res.status(400).json({ message: "Request already handled" });
    }

    const [marketRows] = await connection.execute(
      `
      SELECT
        coin_id,
        status,
        owner_user_id,
        current_price,
        last_purchase_price,
        sale_original_price,
        sale_seller_user_id,
        sale_paid_upfront,
        locked_forever
      FROM coin_market_state
      WHERE coin_id = ?
      FOR UPDATE
      `,
      [request.coin_id],
    );

    if (marketRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: "Coin market state not found" });
    }

    const market = marketRows[0];

    if (market.status === "EXCLUSIVE_LOCKED" || market.locked_forever) {
      await connection.rollback();
      return res.status(400).json({ message: "This coin is already exclusive" });
    }

    const usersToClear = [];

    if (market.status === "PAID_OWNED" && market.owner_user_id) {
      const refundAmount = Number(market.last_purchase_price || 0);

      if (refundAmount > 0) {
        await insertTransaction(connection, {
          user_id: market.owner_user_id,
          created_by_user_id: adminUserId,
          session_id: null,
          type: "COIN_EXCLUSIVE_REFUND",
          direction: "CREDIT",
          amount: refundAmount,
          from_unit: "COIN",
          to_unit: "DOUBLE_O",
          note: `Refund for ${request.coin_title} because exclusive ownership was approved`,
        });
      }

      if (Number(market.owner_user_id) !== Number(request.user_id)) {
        usersToClear.push(Number(market.owner_user_id));
      }
    }

    if (market.status === "FOR_SALE" && market.sale_seller_user_id) {
      const finalRefund = Math.max(0, Number(market.sale_original_price || 0) - Number(market.sale_paid_upfront || 0));

      if (finalRefund > 0) {
        await insertTransaction(connection, {
          user_id: market.sale_seller_user_id,
          created_by_user_id: adminUserId,
          session_id: null,
          type: "COIN_EXCLUSIVE_REFUND",
          direction: "CREDIT",
          amount: finalRefund,
          from_unit: "COIN",
          to_unit: "DOUBLE_O",
          note: `Final refund for ${request.coin_title} because exclusive ownership was approved`,
        });
      }

      if (Number(market.sale_seller_user_id) !== Number(request.user_id)) {
        usersToClear.push(Number(market.sale_seller_user_id));
      }
    }

    await clearSelectedSpecialCoin(connection, usersToClear, request.coin_id);

    await insertTransaction(connection, {
      user_id: request.user_id,
      created_by_user_id: adminUserId,
      session_id: null,
      type: "COIN_EXCLUSIVE_GRANTED",
      direction: "CREDIT",
      amount: 0,
      from_unit: "COIN",
      to_unit: "COIN",
      note: `Exclusive ownership approved: ${request.coin_title}`,
    });

    await connection.execute(
      `
      UPDATE coin_market_state
      SET
        status = 'EXCLUSIVE_LOCKED',
        owner_user_id = ?,
        locked_forever = 1,
        last_purchase_price = NULL,
        sale_original_price = NULL,
        sale_seller_user_id = NULL,
        sale_paid_upfront = 0
      WHERE coin_id = ?
      `,
      [request.user_id, request.coin_id],
    );

    await connection.execute(
      `
      UPDATE coin_requests
      SET
        status = 'APPROVED',
        admin_user_id = ?,
        admin_decision_at = NOW()
      WHERE id = ?
      `,
      [adminUserId, requestId],
    );

    await connection.execute(
      `
      UPDATE coin_requests
      SET
        status = 'REJECTED',
        admin_user_id = ?,
        admin_decision_at = NOW()
      WHERE coin_id = ?
        AND status = 'PENDING'
        AND id <> ?
      `,
      [adminUserId, request.coin_id, requestId],
    );

    await connection.commit();

    res.json({
      message: "Exclusive ownership approved successfully",
      requestId,
      coinId: Number(request.coin_id),
    });
  } catch (error) {
    await connection.rollback();
    console.error("approveCoinRequest error:", error);
    res.status(500).json({ message: "Server error" });
  } finally {
    connection.release();
  }
}

async function rejectCoinRequest(req, res) {
  try {
    const requestId = Number(req.params.id);
    const adminUserId = req.user.id;

    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ message: "Invalid request id" });
    }

    const [rows] = await db.execute(
      `
      SELECT id, status
      FROM coin_requests
      WHERE id = ?
      LIMIT 1
      `,
      [requestId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Coin request not found" });
    }

    if (rows[0].status !== "PENDING") {
      return res.status(400).json({ message: "Request already handled" });
    }

    await db.execute(
      `
      UPDATE coin_requests
      SET
        status = 'REJECTED',
        admin_user_id = ?,
        admin_decision_at = NOW()
      WHERE id = ?
      `,
      [adminUserId, requestId],
    );

    res.json({
      message: "Coin request rejected successfully",
      requestId,
    });
  } catch (error) {
    console.error("rejectCoinRequest error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function getRequestHistory(req, res) {
  try {
    const scope = req.query.scope === "all" && req.user.role === "ADMIN" ? "all" : "mine";
    const status = String(req.query.status || "all").toUpperCase();
    const type = String(req.query.type || "all").toLowerCase();

    const conversionParams = [];
    const conversionConditions = [];
    const bonusParams = [];
    const bonusConditions = [];

    if (scope === "mine") {
      conversionConditions.push("cr.user_id = ?");
      conversionParams.push(req.user.id);
      bonusConditions.push("br.user_id = ?");
      bonusParams.push(req.user.id);
    }

    if (["PENDING", "APPROVED", "REJECTED"].includes(status)) {
      conversionConditions.push("cr.status = ?");
      conversionParams.push(status);
      bonusConditions.push("br.status = ?");
      bonusParams.push(status);
    }

    if (type === "buy_in") {
      conversionConditions.push("cr.type = 'TO_CHIPS'");
    } else if (type === "cash_out") {
      conversionConditions.push("cr.type = 'TO_COINS'");
    } else if (type !== "all" && type !== "bonus") {
      return res.status(400).json({ message: "Invalid type filter" });
    }

    const items = [];

    if (type !== "bonus") {
      const conversionWhereClause = conversionConditions.length
        ? `WHERE ${conversionConditions.join(" AND ")}`
        : "";

      const [conversionRows] = await db.execute(
        `
        SELECT
          CONCAT('conversion-', cr.id) AS id,
          'REQUEST' AS source_kind,
          CASE WHEN cr.type = 'TO_CHIPS' THEN 'BUY_IN' ELSE 'CASH_OUT' END AS action_type,
          cr.user_id,
          u.username,
          cr.session_id,
          gs.title AS session_title,
          cr.amount_total AS amount,
          cr.status,
          CASE
            WHEN cr.type = 'TO_CHIPS' THEN 'Conversion request to chips'
            ELSE 'Conversion request to Double O'
          END AS note,
          cr.created_at,
          cr.admin_decision_at,
          cr.admin_user_id,
          au.username AS admin_username,
          NULL AS bonus_title
        FROM conversion_requests cr
        JOIN users u ON u.id = cr.user_id
        LEFT JOIN users au ON au.id = cr.admin_user_id
        LEFT JOIN game_sessions gs ON gs.id = cr.session_id
        ${conversionWhereClause}
        `,
        conversionParams,
      );

      items.push(
        ...conversionRows.map((row) => ({
          ...row,
          user_id: Number(row.user_id),
          session_id: row.session_id === null ? null : Number(row.session_id),
          session_title: row.session_title || null,
          amount: Number(row.amount),
          admin_user_id: row.admin_user_id === null ? null : Number(row.admin_user_id),
        })),
      );
    }

    if (type === "all" || type === "bonus") {
      const bonusWhereClause = bonusConditions.length
        ? `WHERE ${bonusConditions.join(" AND ")}`
        : "";

      const [bonusRows] = await db.execute(
        `
        SELECT
          CONCAT('bonus-', br.id) AS id,
          'BONUS' AS source_kind,
          'BONUS' AS action_type,
          br.user_id,
          u.username,
          NULL AS session_id,
          br.amount_snapshot AS amount,
          br.status,
          CONCAT('Bonus request: ', b.title) AS note,
          br.created_at,
          br.admin_decision_at,
          br.admin_user_id,
          au.username AS admin_username,
          b.title AS bonus_title
        FROM bonus_requests br
        JOIN users u ON u.id = br.user_id
        JOIN bonuses b ON b.id = br.bonus_id
        LEFT JOIN users au ON au.id = br.admin_user_id
        ${bonusWhereClause}
        `,
        bonusParams,
      );

      items.push(
        ...bonusRows.map((row) => ({
          ...row,
          user_id: Number(row.user_id),
          session_id: null,
          session_title: null,
          amount: Number(row.amount),
          admin_user_id: row.admin_user_id === null ? null : Number(row.admin_user_id),
        })),
      );
    }

    items.sort((a, b) => {
      const aTime = new Date(a.created_at).getTime();
      const bTime = new Date(b.created_at).getTime();
      if (bTime !== aTime) return bTime - aTime;
      return String(b.id).localeCompare(String(a.id));
    });

    res.json(items);
  } catch (error) {
    console.error("getRequestHistory error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

module.exports = {
  getPendingRequests,
  approveBonusRequest,
  rejectBonusRequest,
  approveCoinRequest,
  rejectCoinRequest,
  getRequestHistory,
};
