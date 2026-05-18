const db = require("../config/db");

function mapTransactionActionType(type) {
  if (type === "CONVERSION_TO_CHIPS") return "BUY_IN";
  if (type === "CONVERSION_TO_COINS") return "CASH_OUT";
  if (type === "BONUS") return "BONUS";
  if (type === "COIN_PURCHASE") return "COIN_PURCHASE";
  if (type === "COIN_OWNER_REFUND") return "COIN_REFUND";
  if (type === "COIN_LIST_FOR_SALE") return "COIN_LIST_FOR_SALE";
  if (type === "COIN_SALE_FINAL_REFUND") return "COIN_SALE_FINAL_REFUND";
  if (type === "COIN_EXCLUSIVE_GRANTED") return "COIN_EXCLUSIVE_GRANTED";
  if (type === "COIN_EXCLUSIVE_REFUND") return "COIN_EXCLUSIVE_REFUND";
  if (type === "WELCOME_BONUS") return "BONUS";
  return type || "TRANSACTION";
}

async function getActionFeed(req, res) {
  try {
    const scope = req.query.scope === "all" && req.user.role === "ADMIN" ? "all" : "mine";
    const status = String(req.query.status || "all").toUpperCase();

    if (!["ALL", "PENDING", "APPROVED", "REJECTED"].includes(status)) {
      return res.status(400).json({ message: "Invalid status filter" });
    }

    const items = [];

    if (status === "ALL" || status === "APPROVED") {
      const transactionConditions = [];
      const transactionParams = [];

      if (scope === "mine") {
        transactionConditions.push("bt.user_id = ?");
        transactionParams.push(req.user.id);
      }

      const transactionWhere = transactionConditions.length
        ? `WHERE ${transactionConditions.join(" AND ")}`
        : "";

      const [transactionRows] = await db.execute(
        `
        SELECT
          CONCAT('transaction-', bt.id) AS id,
          'TRANSACTION' AS source_kind,
          bt.type AS transaction_type,
          bt.user_id,
          u.username,
          bt.created_by_user_id,
          cu.username AS created_by_username,
          bt.session_id,
          gs.title AS session_title,
          bt.direction,
          bt.amount,
          'APPROVED' AS status,
          bt.note,
          bt.created_at,
          NULL AS admin_decision_at,
          bt.created_by_user_id AS admin_user_id,
          cu.username AS admin_username,
          NULL AS bonus_title,
          NULL AS coin_title
        FROM balance_transactions bt
        JOIN users u ON u.id = bt.user_id
        JOIN users cu ON cu.id = bt.created_by_user_id
        LEFT JOIN game_sessions gs ON gs.id = bt.session_id
        ${transactionWhere}
        `,
        transactionParams,
      );

      items.push(
        ...transactionRows.map((row) => ({
          ...row,
          action_type: mapTransactionActionType(row.transaction_type),
          user_id: Number(row.user_id),
          created_by_user_id: Number(row.created_by_user_id),
          session_id: row.session_id === null ? null : Number(row.session_id),
          amount: Number(row.amount || 0),
          admin_user_id: row.admin_user_id === null ? null : Number(row.admin_user_id),
        })),
      );
    }

    if (status === "ALL" || status === "PENDING" || status === "REJECTED") {
      const requestStatusCondition = status === "ALL" ? "req_status IN ('PENDING', 'REJECTED')" : "req_status = ?";
      const requestStatusParams = status === "ALL" ? [] : [status];
      const userCondition = scope === "mine" ? "AND user_id = ?" : "";
      const userParams = scope === "mine" ? [req.user.id] : [];

      const [requestRows] = await db.execute(
        `
        SELECT * FROM (
          SELECT
            CONCAT('conversion-', cr.id) AS id,
            'REQUEST' AS source_kind,
            CASE WHEN cr.type = 'TO_CHIPS' THEN 'BUY_IN' ELSE 'CASH_OUT' END AS action_type,
            cr.user_id,
            u.username,
            cr.session_id,
            gs.title AS session_title,
            cr.amount_total AS amount,
            cr.status AS req_status,
            CASE
              WHEN cr.type = 'TO_CHIPS' THEN 'Conversion request to chips'
              ELSE 'Conversion request to Double O'
            END AS note,
            cr.created_at,
            cr.admin_decision_at,
            cr.admin_user_id,
            au.username AS admin_username,
            NULL AS bonus_title,
            NULL AS coin_title
          FROM conversion_requests cr
          JOIN users u ON u.id = cr.user_id
          LEFT JOIN users au ON au.id = cr.admin_user_id
          LEFT JOIN game_sessions gs ON gs.id = cr.session_id
          WHERE cr.status IN ('PENDING', 'REJECTED')

          UNION ALL

          SELECT
            CONCAT('bonus-', br.id) AS id,
            'BONUS' AS source_kind,
            'BONUS' AS action_type,
            br.user_id,
            u.username,
            NULL AS session_id,
            NULL AS session_title,
            br.amount_snapshot AS amount,
            br.status AS req_status,
            CONCAT('Bonus request: ', b.title) AS note,
            br.created_at,
            br.admin_decision_at,
            br.admin_user_id,
            au.username AS admin_username,
            b.title AS bonus_title,
            NULL AS coin_title
          FROM bonus_requests br
          JOIN users u ON u.id = br.user_id
          JOIN bonuses b ON b.id = br.bonus_id
          LEFT JOIN users au ON au.id = br.admin_user_id
          WHERE br.status IN ('PENDING', 'REJECTED')

          UNION ALL

          SELECT
            CONCAT('coin-', cor.id) AS id,
            'COIN' AS source_kind,
            'COIN_EXCLUSIVE_REQUEST' AS action_type,
            cor.user_id,
            u.username,
            NULL AS session_id,
            NULL AS session_title,
            0 AS amount,
            cor.status AS req_status,
            CONCAT('Exclusive ownership request: ', cc.title) AS note,
            cor.created_at,
            cor.admin_decision_at,
            cor.admin_user_id,
            au.username AS admin_username,
            NULL AS bonus_title,
            cc.title AS coin_title
          FROM coin_requests cor
          JOIN users u ON u.id = cor.user_id
          JOIN coin_catalog cc ON cc.id = cor.coin_id
          LEFT JOIN users au ON au.id = cor.admin_user_id
          WHERE cor.status IN ('PENDING', 'REJECTED')
        ) request_feed
        WHERE ${requestStatusCondition}
        ${userCondition}
        `,
        [...requestStatusParams, ...userParams],
      );

      items.push(
        ...requestRows.map((row) => ({
          ...row,
          status: row.req_status,
          user_id: Number(row.user_id),
          session_id: row.session_id === null ? null : Number(row.session_id),
          amount: Number(row.amount || 0),
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
    console.error("getActionFeed error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

module.exports = {
  getActionFeed,
};
