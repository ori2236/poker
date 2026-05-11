const db = require("../config/db");
const bcrypt = require("bcrypt");
const crypto = require("crypto");

async function register(req, res) {
  try {
    const { username, password, confirmPassword, profileImageBase64 } = req.body;

    if (!username || !password || !profileImageBase64) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    if (confirmPassword !== undefined && password !== confirmPassword) {
      return res.status(400).json({ message: "Passwords do not match" });
    }

    const [existingUsers] = await db.execute(
      "SELECT id FROM users WHERE username = ? LIMIT 1",
      [username],
    );

    if (existingUsers.length > 0) {
      return res.status(400).json({ message: "Username already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const [result] = await db.execute(
      `
      INSERT INTO users (username, password_hash, profile_image_base64, role, is_active)
      VALUES (?, ?, ?, 'USER', 1)
      `,
      [username, passwordHash, profileImageBase64],
    );

    const userId = result.insertId;

    await db.execute(
      `
      INSERT INTO balance_transactions
      (user_id, created_by_user_id, type, direction, amount, from_unit, to_unit, note)
      VALUES (?, ?, 'WELCOME_BONUS', 'CREDIT', 1000, NULL, 'DOUBLE_O', 'Welcome bonus')
      `,
      [userId, userId],
    );

    res.status(201).json({ message: "User created successfully" });
  } catch (error) {
    console.error("register error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function login(req, res) {
  try {
    const { username, password } = req.body;

    const [rows] = await db.execute(
      "SELECT id, username, password_hash, role FROM users WHERE username = ? LIMIT 1",
      [username],
    );

    if (rows.length === 0) {
      return res.status(401).json({ message: "Invalid username or password" });
    }

    const user = rows[0];
    const isValid = await bcrypt.compare(password, user.password_hash);

    if (!isValid) {
      return res.status(401).json({ message: "Invalid username or password" });
    }

    const token = crypto.randomBytes(32).toString("hex");

    await db.execute(
      `
      INSERT INTO auth_sessions (user_id, session_token, is_active)
      VALUES (?, ?, 1)
      `,
      [user.id, token],
    );

    res.json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("login error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function me(req, res) {
  res.json({ user: req.user });
}

module.exports = {
  register,
  login,
  me,
};
