const db = require("../config/db");

async function authMiddleware(req, res, next) {
  try {
    const token = req.headers.authorization;

    if (!token) {
      return res.status(401).json({ message: "No token provided" });
    }

    const [rows] = await db.execute(
      `
      SELECT users.id, users.username, users.role
      FROM auth_sessions
      JOIN users ON users.id = auth_sessions.user_id
      WHERE auth_sessions.session_token = ? AND auth_sessions.is_active = 1
      LIMIT 1
      `,
      [token],
    );

    if (rows.length === 0) {
      return res.status(401).json({ message: "Invalid token" });
    }

    req.user = rows[0];
    next();
  } catch (error) {
    console.error("authMiddleware error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

module.exports = authMiddleware;
