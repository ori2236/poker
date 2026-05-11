const db = require("../config/db");

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

    const merged = [...conversionRows, ...bonusRows].sort((a, b) => {
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
        amount_total: Number(row.amount_total),
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
        ${conversionWhereClause}
        `,
        conversionParams,
      );

      items.push(
        ...conversionRows.map((row) => ({
          ...row,
          user_id: Number(row.user_id),
          session_id: row.session_id === null ? null : Number(row.session_id),
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
  getRequestHistory,
};
