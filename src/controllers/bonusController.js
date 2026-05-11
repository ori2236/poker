const db = require("../config/db");

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

function normalizeImageBase64(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

async function getBonuses(req, res) {
  try {
    const includeInactive = String(req.query.includeInactive || "false").toLowerCase() === "true";
    const isAdmin = req.user.role === "ADMIN";

    const conditions = [];
    const params = [req.user.id, req.user.id];

    if (!(includeInactive && isAdmin)) {
      conditions.push("b.is_active = 1");
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [rows] = await db.execute(
      `
      SELECT
        b.id,
        b.title,
        b.description,
        b.amount,
        b.image_base64,
        b.is_active,
        EXISTS(
          SELECT 1
          FROM bonus_requests br
          WHERE br.bonus_id = b.id
            AND br.user_id = ?
            AND br.status = 'PENDING'
        ) AS has_pending_request,
        CASE
          WHEN COALESCE((
            SELECT SUM(
              CASE
                WHEN bt.direction = 'CREDIT' THEN bt.amount
                WHEN bt.direction = 'DEBIT' THEN -bt.amount
                ELSE 0
              END
            )
            FROM balance_transactions bt
            WHERE bt.user_id = ?
          ), 0) < 300
          THEN TRUE
          ELSE FALSE
        END AS can_request
      FROM bonuses b
      ${whereClause}
      ORDER BY b.is_active DESC, b.created_at DESC, b.id DESC
      `,
      params,
    );

    res.json(
      rows.map((row) => ({
        id: Number(row.id),
        title: row.title,
        description: row.description || "",
        amount: Number(row.amount),
        image_base64: row.image_base64 || null,
        is_active: Number(row.is_active) === 1,
        has_pending_request: Number(row.has_pending_request) === 1,
        can_request: Number(row.can_request) === 1,
      })),
    );
  } catch (error) {
    console.error("getBonuses error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function createBonus(req, res) {
  try {
    const { title, description = "", amount, imageBase64, image_base64 } = req.body;

    const trimmedTitle = String(title || "").trim();
    const trimmedDescription = String(description || "").trim();
    const finalAmount = Number(amount);
    const finalImageBase64 = normalizeImageBase64(imageBase64 ?? image_base64);

    if (!trimmedTitle) {
      return res.status(400).json({ message: "Title is required" });
    }

    if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
      return res.status(400).json({ message: "Amount must be greater than 0" });
    }

    const [result] = await db.execute(
      `
      INSERT INTO bonuses
      (title, description, amount, image_base64, is_active, created_by_user_id)
      VALUES (?, ?, ?, ?, 1, ?)
      `,
      [trimmedTitle, trimmedDescription, finalAmount, finalImageBase64, req.user.id],
    );

    res.status(201).json({
      message: "Bonus created successfully",
      id: result.insertId,
    });
  } catch (error) {
    console.error("createBonus error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function updateBonus(req, res) {
  try {
    const bonusId = Number(req.params.id);
    const { title, description, amount, imageBase64, image_base64, isActive, is_active } = req.body;

    if (!Number.isInteger(bonusId) || bonusId <= 0) {
      return res.status(400).json({ message: "Invalid bonus id" });
    }

    const fields = [];
    const values = [];

    if (title !== undefined) {
      const trimmedTitle = String(title).trim();
      if (!trimmedTitle) {
        return res.status(400).json({ message: "Title cannot be empty" });
      }
      fields.push("title = ?");
      values.push(trimmedTitle);
    }

    if (description !== undefined) {
      fields.push("description = ?");
      values.push(String(description || "").trim());
    }

    if (amount !== undefined) {
      const finalAmount = Number(amount);
      if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
        return res.status(400).json({ message: "Amount must be greater than 0" });
      }
      fields.push("amount = ?");
      values.push(finalAmount);
    }

    if (imageBase64 !== undefined || image_base64 !== undefined) {
      fields.push("image_base64 = ?");
      values.push(normalizeImageBase64(imageBase64 ?? image_base64));
    }

    if (isActive !== undefined || is_active !== undefined) {
      fields.push("is_active = ?");
      values.push(Boolean(isActive ?? is_active) ? 1 : 0);
    }

    if (fields.length === 0) {
      return res.status(400).json({ message: "Nothing to update" });
    }

    values.push(bonusId);

    const [result] = await db.execute(
      `
      UPDATE bonuses
      SET ${fields.join(", ")}, updated_at = NOW()
      WHERE id = ?
      `,
      values,
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Bonus not found" });
    }

    res.json({ message: "Bonus updated successfully" });
  } catch (error) {
    console.error("updateBonus error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function deleteBonus(req, res) {
  try {
    const bonusId = Number(req.params.id);

    if (!Number.isInteger(bonusId) || bonusId <= 0) {
      return res.status(400).json({ message: "Invalid bonus id" });
    }

    const [result] = await db.execute(
      `
      UPDATE bonuses
      SET is_active = 0, updated_at = NOW()
      WHERE id = ?
      `,
      [bonusId],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Bonus not found" });
    }

    res.json({ message: "Bonus deleted successfully" });
  } catch (error) {
    console.error("deleteBonus error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function createBonusRequest(req, res) {
  const connection = await db.getConnection();

  try {
    const bonusId = Number(req.params.id);
    const userId = req.user.id;

    if (!Number.isInteger(bonusId) || bonusId <= 0) {
      return res.status(400).json({ message: "Invalid bonus id" });
    }

    await connection.beginTransaction();

    const [bonusRows] = await connection.execute(
      `
      SELECT id, title, amount, is_active
      FROM bonuses
      WHERE id = ?
      FOR UPDATE
      `,
      [bonusId],
    );

    if (bonusRows.length === 0 || Number(bonusRows[0].is_active) !== 1) {
      await connection.rollback();
      return res.status(404).json({ message: "Bonus not found" });
    }

    const balance = await getUserBalance(connection, userId);

    if (balance >= 300) {
      await connection.rollback();
      return res.status(400).json({ message: "Only users under 300 O² can request a bonus" });
    }

    const [pendingRows] = await connection.execute(
      `
      SELECT id
      FROM bonus_requests
      WHERE bonus_id = ?
        AND user_id = ?
        AND status = 'PENDING'
      LIMIT 1
      `,
      [bonusId, userId],
    );

    if (pendingRows.length > 0) {
      await connection.rollback();
      return res.status(409).json({ message: "A request for this bonus was already sent" });
    }

    const bonus = bonusRows[0];

    const [result] = await connection.execute(
      `
      INSERT INTO bonus_requests
      (bonus_id, user_id, amount_snapshot, status)
      VALUES (?, ?, ?, 'PENDING')
      `,
      [bonusId, userId, Number(bonus.amount)],
    );

    await connection.commit();

    res.status(201).json({
      message: "Bonus request created and waiting for admin approval",
      requestId: result.insertId,
      bonus: {
        id: Number(bonus.id),
        title: bonus.title,
        amount: Number(bonus.amount),
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("createBonusRequest error:", error);
    res.status(500).json({ message: "Server error" });
  } finally {
    connection.release();
  }
}

module.exports = {
  getBonuses,
  createBonus,
  updateBonus,
  deleteBonus,
  createBonusRequest,
};
