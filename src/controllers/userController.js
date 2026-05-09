const db = require("../config/db");
const bcrypt = require("bcrypt");

async function getAllUsers(req, res) {
  try {
    const [rows] = await db.execute(`
      SELECT id, username, role, profile_image_base64, created_at
      FROM users
      WHERE is_active = 1
      ORDER BY username ASC
    `);

    res.json(rows);
  } catch (error) {
    console.error("getAllUsers error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function updateMyProfile(req, res) {
  try {
    const userId = req.user.id;
    const { username, profileImageBase64 } = req.body;

    if (!username && !profileImageBase64) {
      return res.status(400).json({ message: "Nothing to update" });
    }

    if (username) {
      const trimmed = String(username).trim();
      if (!trimmed) {
        return res.status(400).json({ message: "Username cannot be empty" });
      }

      const [existingRows] = await db.execute(
        "SELECT id FROM users WHERE username = ? AND id <> ? LIMIT 1",
        [trimmed, userId],
      );

      if (existingRows.length > 0) {
        return res.status(400).json({ message: "Username already exists" });
      }
    }

    const fields = [];
    const values = [];

    if (username) {
      fields.push("username = ?");
      values.push(String(username).trim());
    }

    if (profileImageBase64) {
      fields.push("profile_image_base64 = ?");
      values.push(profileImageBase64);
    }

    values.push(userId);

    await db.execute(
      `
      UPDATE users
      SET ${fields.join(", ")}
      WHERE id = ?
      `,
      values,
    );

    res.json({ message: "Profile updated successfully" });
  } catch (error) {
    console.error("updateMyProfile error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function changeMyPassword(req, res) {
  try {
    const userId = req.user.id;
    const { currentPassword, newPassword, confirmNewPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmNewPassword) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    if (newPassword !== confirmNewPassword) {
      return res.status(400).json({ message: "New passwords do not match" });
    }

    if (newPassword.length < 4) {
      return res.status(400).json({ message: "New password is too short" });
    }

    const [rows] = await db.execute(
      "SELECT password_hash FROM users WHERE id = ? LIMIT 1",
      [userId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const isValid = await bcrypt.compare(
      currentPassword,
      rows[0].password_hash,
    );

    if (!isValid) {
      return res.status(400).json({ message: "Current password is incorrect" });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    await db.execute("UPDATE users SET password_hash = ? WHERE id = ?", [
      passwordHash,
      userId,
    ]);

    res.json({ message: "Password changed successfully" });
  } catch (error) {
    console.error("changeMyPassword error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

module.exports = {
  getAllUsers,
  updateMyProfile,
  changeMyPassword,
};
