const db = require("../config/db");

async function getMyTransactions(req, res) {
  try {
    const userId = req.user.id;

    const [rows] = await db.execute(
      `
      SELECT 
        bt.id,
        bt.user_id,
        u.username,
        bt.created_by_user_id,
        cu.username AS created_by_username,
        bt.session_id,
        bt.type,
        bt.direction,
        bt.amount,
        bt.from_unit,
        bt.to_unit,
        bt.note,
        bt.created_at
      FROM balance_transactions bt
      JOIN users u ON u.id = bt.user_id
      JOIN users cu ON cu.id = bt.created_by_user_id
      WHERE bt.user_id = ?
      ORDER BY bt.created_at DESC, bt.id DESC
      `,
      [userId],
    );

    res.json(rows);
  } catch (error) {
    console.error("getMyTransactions error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function getAllTransactions(req, res) {
  try {
    const [rows] = await db.execute(`
      SELECT 
        bt.id,
        bt.user_id,
        u.username,
        bt.created_by_user_id,
        cu.username AS created_by_username,
        bt.session_id,
        bt.type,
        bt.direction,
        bt.amount,
        bt.from_unit,
        bt.to_unit,
        bt.note,
        bt.created_at
      FROM balance_transactions bt
      JOIN users u ON u.id = bt.user_id
      JOIN users cu ON cu.id = bt.created_by_user_id
      ORDER BY bt.created_at DESC, bt.id DESC
    `);

    res.json(rows);
  } catch (error) {
    console.error("getAllTransactions error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function getMyDailySummary(req, res) {
  try {
    const userId = req.user.id;

    const [rows] = await db.execute(
      `
      SELECT
        DATE(created_at) AS date,
        COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0) AS total_in,
        COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 0) AS total_out,
        COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount WHEN direction = 'DEBIT' THEN -amount ELSE 0 END), 0) AS net
      FROM balance_transactions
      WHERE user_id = ?
      GROUP BY DATE(created_at)
      ORDER BY DATE(created_at) DESC
      `,
      [userId],
    );

    res.json(
      rows.map((row) => ({
        date: row.date,
        totalIn: Number(row.total_in),
        totalOut: Number(row.total_out),
        net: Number(row.net),
      })),
    );
  } catch (error) {
    console.error("getMyDailySummary error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

module.exports = {
  getMyTransactions,
  getAllTransactions,
  getMyDailySummary,
};
