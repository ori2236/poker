const db = require("../config/db");

async function getMyBalance(req, res) {
  try {
    const userId = req.user.id;

    const [balanceRows] = await db.execute(
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

    const [todayRows] = await db.execute(
      `
      SELECT 
        COALESCE(SUM(
          CASE 
            WHEN direction = 'CREDIT' THEN amount
            WHEN direction = 'DEBIT' THEN -amount
            ELSE 0
          END
        ), 0) AS today_net
      FROM balance_transactions
      WHERE user_id = ? AND DATE(created_at) = CURDATE()
      `,
      [userId],
    );

    res.json({
      userId,
      balance: Number(balanceRows[0].balance),
      todayNet: Number(todayRows[0].today_net),
    });
  } catch (error) {
    console.error("getMyBalance error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function getLeaderboard(req, res) {
  try {
    const [rows] = await db.execute(`
      SELECT 
        u.id,
        u.username,
        u.profile_image_base64,
        COALESCE(SUM(
          CASE 
            WHEN bt.direction = 'CREDIT' THEN bt.amount
            WHEN bt.direction = 'DEBIT' THEN -bt.amount
            ELSE 0
          END
        ), 0) AS balance
      FROM users u
      LEFT JOIN balance_transactions bt ON bt.user_id = u.id
      WHERE u.is_active = 1
      GROUP BY u.id, u.username, u.profile_image_base64
      ORDER BY balance DESC, u.username ASC
    `);

    res.json(
      rows.map((row, index) => ({
        rank: index + 1,
        id: row.id,
        username: row.username,
        profile_image_base64: row.profile_image_base64,
        balance: Number(row.balance),
      })),
    );
  } catch (error) {
    console.error("getLeaderboard error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

module.exports = {
  getMyBalance,
  getLeaderboard,
};
