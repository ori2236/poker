const db = require("../config/db");

async function getActions(req, res) {
  try {
    const isAdmin = req.user.role === "ADMIN";
    const scope = req.query.scope === "all" && isAdmin ? "all" : "mine";
    const status = String(req.query.status || "all").toLowerCase();

    if (status !== "all" && status !== "approved") {
      return res.json([]);
    }

    const params = [];
    const whereParts = [];

    if (scope === "mine") {
      whereParts.push("bt.user_id = ?");
      params.push(req.user.id);
    }

    const whereClause = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

    const [rows] = await db.execute(
      `
      SELECT
        bt.id,
        'TRANSACTION' AS source_kind,
        bt.type AS action_type,
        bt.user_id,
        u.username,
        bt.created_by_user_id,
        cu.username AS created_by_username,
        bt.session_id,
        gs.title AS session_title,
        bt.direction,
        bt.amount,
        bt.from_unit,
        bt.to_unit,
        bt.note,
        bt.created_at,
        'APPROVED' AS status,
        NULL AS bonus_title
      FROM balance_transactions bt
      JOIN users u ON u.id = bt.user_id
      LEFT JOIN users cu ON cu.id = bt.created_by_user_id
      LEFT JOIN game_sessions gs ON gs.id = bt.session_id
      ${whereClause}
      ORDER BY bt.created_at DESC, bt.id DESC
      LIMIT 300
      `,
      params,
    );

    res.json(rows.map((row) => ({
      id: `transaction-${row.id}`,
      source_kind: row.source_kind,
      action_type: row.action_type,
      transaction_type: row.type,
      user_id: Number(row.user_id),
      username: row.username,
      created_by_user_id: row.created_by_user_id === null ? null : Number(row.created_by_user_id),
      created_by_username: row.created_by_username || null,
      session_id: row.session_id === null ? null : Number(row.session_id),
      session_title: row.session_title || null,
      direction: row.direction,
      amount: Number(row.amount || 0),
      from_unit: row.from_unit,
      to_unit: row.to_unit,
      note: row.note,
      created_at: row.created_at,
      status: row.status,
      bonus_title: row.bonus_title,
    })));
  } catch (error) {
    console.error("getActions error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

module.exports = {
  getActions,
};
