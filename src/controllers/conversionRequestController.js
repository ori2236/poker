const db = require("../config/db");

function calculateAmountFromBreakdown({
  white_count = 0,
  red_count = 0,
  blue_count = 0,
  green_count = 0,
  black_count = 0,
}) {
  return (
    Number(white_count) * 1 +
    Number(red_count) * 5 +
    Number(blue_count) * 10 +
    Number(green_count) * 25 +
    Number(black_count) * 50
  );
}

function normalizeAmount({
  amount_mode,
  amount_total,
  white_count = 0,
  red_count = 0,
  blue_count = 0,
  green_count = 0,
  black_count = 0,
}) {
  if (amount_mode === "TOTAL_AMOUNT") {
    if (
      amount_total === undefined ||
      amount_total === null ||
      Number.isNaN(Number(amount_total)) ||
      Number(amount_total) < 0
    ) {
      throw new Error("Invalid amount_total");
    }

    return Number(amount_total);
  }

  if (amount_mode === "CHIP_BREAKDOWN") {
    return calculateAmountFromBreakdown({
      white_count,
      red_count,
      blue_count,
      green_count,
      black_count,
    });
  }

  throw new Error("Invalid amount_mode");
}

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

  return Number(rows[0].balance);
}

async function getActiveSession(connection) {
  const [rows] = await connection.execute(
    `
    SELECT id, title
    FROM game_sessions
    WHERE status = 'ACTIVE'
    LIMIT 1
    `,
  );

  return rows[0] || null;
}

async function getSessionPlayer(connection, sessionId, userId) {
  const [rows] = await connection.execute(
    `
    SELECT id, session_id, user_id, is_playing, joined_at, left_at
    FROM session_players
    WHERE session_id = ? AND user_id = ?
    LIMIT 1
    `,
    [sessionId, userId],
  );

  return rows[0] || null;
}

async function getPendingRequestForUser(connection, userId, options = {}) {
  const conditions = ["user_id = ?", "status = 'PENDING'"];
  const params = [userId];

  if (options.sessionId !== undefined) {
    if (options.sessionId === null) {
      conditions.push("session_id IS NULL");
    } else {
      conditions.push("session_id = ?");
      params.push(options.sessionId);
    }
  }

  if (options.type) {
    conditions.push("type = ?");
    params.push(options.type);
  }

  const [rows] = await connection.execute(
    `
    SELECT *
    FROM conversion_requests
    WHERE ${conditions.join(" AND ")}
    ORDER BY id DESC
    LIMIT 1
    `,
    params,
  );

  return rows[0] || null;
}

async function getUserById(connection, userId) {
  const [rows] = await connection.execute(
    `
    SELECT id, username, role, is_active
    FROM users
    WHERE id = ?
    LIMIT 1
    `,
    [userId],
  );

  return rows[0] || null;
}

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

async function upsertSessionPlayerPlaying(connection, sessionId, userId) {
  await connection.execute(
    `
    INSERT INTO session_players (session_id, user_id, is_playing, left_at)
    VALUES (?, ?, TRUE, NULL)
    ON DUPLICATE KEY UPDATE
      is_playing = TRUE,
      left_at = NULL
    `,
    [sessionId, userId],
  );
}

async function markSessionPlayerOut(connection, sessionId, userId) {
  await connection.execute(
    `
    UPDATE session_players
    SET is_playing = FALSE, left_at = NOW()
    WHERE session_id = ? AND user_id = ?
    `,
    [sessionId, userId],
  );
}

async function createConversionRequest(req, res) {
  const connection = await db.getConnection();

  try {
    const actorUserId = req.user.id;
    const isAdmin = req.user.role === "ADMIN";

    const {
      type,
      amount_mode,
      amount_total,
      white_count = 0,
      red_count = 0,
      blue_count = 0,
      green_count = 0,
      black_count = 0,
      target_user_id,
    } = req.body;

    if (!type || !amount_mode) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    if (!["TO_CHIPS", "TO_COINS"].includes(type)) {
      return res.status(400).json({ message: "Invalid type" });
    }

    if (!["TOTAL_AMOUNT", "CHIP_BREAKDOWN"].includes(amount_mode)) {
      return res.status(400).json({ message: "Invalid amount_mode" });
    }

    await connection.beginTransaction();

    const activeSession = await getActiveSession(connection);
    const sessionId = activeSession ? activeSession.id : null;
    const targetUserId = isAdmin && target_user_id ? Number(target_user_id) : actorUserId;

    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      await connection.rollback();
      return res.status(400).json({ message: "Invalid target_user_id" });
    }

    const targetUser = await getUserById(connection, targetUserId);

    if (!targetUser || Number(targetUser.is_active) !== 1) {
      await connection.rollback();
      return res.status(404).json({ message: "Target user not found" });
    }

    const pendingRequest = await getPendingRequestForUser(connection, targetUserId);

    if (pendingRequest) {
      await connection.rollback();
      return res.status(400).json({
        message:
          targetUserId === actorUserId
            ? "You already have a pending request waiting for admin approval"
            : "This user already has a pending request waiting for admin approval",
      });
    }

    if (!activeSession && !isAdmin) {
      await connection.rollback();
      return res.status(400).json({
        message: "Requests are allowed only during an active session",
      });
    }

    let finalAmount;

    try {
      finalAmount = normalizeAmount({
        amount_mode,
        amount_total,
        white_count,
        red_count,
        blue_count,
        green_count,
        black_count,
      });
    } catch (error) {
      await connection.rollback();
      return res.status(400).json({ message: error.message || "Invalid amount" });
    }

    if (type === "TO_CHIPS" && finalAmount <= 0) {
      await connection.rollback();
      return res.status(400).json({
        message: "Buy-in request must be greater than 0",
      });
    }

    const player = sessionId
      ? await getSessionPlayer(connection, sessionId, targetUserId)
      : null;
    const isPlaying = !!(player && Number(player.is_playing) === 1);

    if (!isAdmin && sessionId) {
      if (!isPlaying && type !== "TO_CHIPS") {
        await connection.rollback();
        return res.status(400).json({
          message: "You can request cash out only after you are in the session",
        });
      }

      if (isPlaying && type !== "TO_COINS") {
        await connection.rollback();
        return res.status(400).json({
          message:
            "You can request buy-in only when you are not currently playing",
        });
      }
    }

    if (type === "TO_CHIPS") {
      const userBalance = await getUserBalance(connection, targetUserId);

      if (userBalance < finalAmount) {
        await connection.rollback();
        return res.status(400).json({
          message:
            targetUserId === actorUserId
              ? "Not enough balance"
              : "Selected user does not have enough balance",
        });
      }
    }

    if (isAdmin) {
      const [requestResult] = await connection.execute(
        `
        INSERT INTO conversion_requests
        (
          user_id,
          session_id,
          type,
          amount_mode,
          amount_total,
          white_count,
          red_count,
          blue_count,
          green_count,
          black_count,
          status,
          admin_user_id,
          admin_decision_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'APPROVED', ?, NOW())
        `,
        [
          targetUserId,
          sessionId,
          type,
          amount_mode,
          finalAmount,
          Number(white_count),
          Number(red_count),
          Number(blue_count),
          Number(green_count),
          Number(black_count),
          actorUserId,
        ],
      );

      let direction;
      let fromUnit;
      let toUnit;
      let transactionType;
      let note;

      if (type === "TO_CHIPS") {
        direction = "DEBIT";
        fromUnit = "DOUBLE_O";
        toUnit = "CHIPS";
        transactionType = "CONVERSION_TO_CHIPS";
        note = `Admin direct buy-in for ${targetUser.username}`;
      } else {
        direction = "CREDIT";
        fromUnit = "CHIPS";
        toUnit = "DOUBLE_O";
        transactionType = "CONVERSION_TO_COINS";
        note = `Admin direct cash out for ${targetUser.username}`;
      }

      await insertTransaction(connection, {
        user_id: targetUserId,
        created_by_user_id: actorUserId,
        session_id: sessionId,
        type: transactionType,
        direction,
        amount: finalAmount,
        from_unit: fromUnit,
        to_unit: toUnit,
        note,
      });

      if (sessionId) {
        if (type === "TO_CHIPS") {
          await upsertSessionPlayerPlaying(connection, sessionId, targetUserId);
        } else {
          await markSessionPlayerOut(connection, sessionId, targetUserId);
        }
      }

      await connection.commit();

      return res.status(201).json({
        message: "Conversion completed successfully",
        requestId: requestResult.insertId,
        amount: finalAmount,
        approved: true,
      });
    }

    const [result] = await connection.execute(
      `
      INSERT INTO conversion_requests
      (
        user_id,
        session_id,
        type,
        amount_mode,
        amount_total,
        white_count,
        red_count,
        blue_count,
        green_count,
        black_count,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
      `,
      [
        actorUserId,
        sessionId,
        type,
        amount_mode,
        finalAmount,
        Number(white_count),
        Number(red_count),
        Number(blue_count),
        Number(green_count),
        Number(black_count),
      ],
    );

    await connection.commit();

    res.status(201).json({
      message:
        type === "TO_CHIPS"
          ? "Buy-in request created and waiting for admin approval"
          : "Cash out request created and waiting for admin approval",
      requestId: result.insertId,
      amount: finalAmount,
      approved: false,
    });
  } catch (error) {
    await connection.rollback();
    console.error("createConversionRequest error:", error);
    res.status(500).json({ message: "Server error" });
  } finally {
    connection.release();
  }
}

async function getConversionRequestsFeed(req, res) {
  try {
    const scope = req.query.scope === "all" ? "all" : "mine";
    const status = String(req.query.status || "all").toUpperCase();

    const requestParams = [];
    const requestConditions = [];
    const bonusParams = [];
    const bonusConditions = ["bt.type IN ('WELCOME_BONUS', 'BONUS')"];

    if (scope === "mine") {
      requestConditions.push("cr.user_id = ?");
      requestParams.push(req.user.id);
      bonusConditions.push("bt.user_id = ?");
      bonusParams.push(req.user.id);
    }

    if (["PENDING", "APPROVED", "REJECTED"].includes(status)) {
      requestConditions.push("cr.status = ?");
      requestParams.push(status);
    }

    const requestWhereClause =
      requestConditions.length > 0
        ? `WHERE ${requestConditions.join(" AND ")}`
        : "";

    const [requestRows] = await db.execute(
      `
      SELECT
        cr.id,
        cr.user_id,
        u.username,
        cr.session_id,
        cr.type,
        cr.amount_total,
        cr.status,
        cr.created_at,
        cr.admin_decision_at,
        cr.admin_user_id,
        au.username AS admin_username,
        'REQUEST' AS source_kind
      FROM conversion_requests cr
      JOIN users u ON u.id = cr.user_id
      LEFT JOIN users au ON au.id = cr.admin_user_id
      ${requestWhereClause}
      ORDER BY cr.created_at DESC, cr.id DESC
      `,
      requestParams,
    );

    let bonusRows = [];

    if (status === "ALL") {
      const bonusWhereClause = `WHERE ${bonusConditions.join(" AND ")}`;

      const [rows] = await db.execute(
        `
        SELECT
          bt.id,
          bt.user_id,
          u.username,
          bt.session_id,
          bt.amount,
          bt.note,
          bt.created_at,
          'BONUS' AS source_kind
        FROM balance_transactions bt
        JOIN users u ON u.id = bt.user_id
        ${bonusWhereClause}
        ORDER BY bt.created_at DESC, bt.id DESC
        `,
        bonusParams,
      );

      bonusRows = rows;
    }

    const normalizedRequests = requestRows.map((row) => ({
      id: `request-${row.id}`,
      raw_id: Number(row.id),
      source_kind: row.source_kind,
      action_type: row.type === "TO_CHIPS" ? "BUY_IN" : "CASH_OUT",
      user_id: Number(row.user_id),
      username: row.username,
      session_id: row.session_id === null ? null : Number(row.session_id),
      amount: Number(row.amount_total),
      status: row.status,
      note:
        row.type === "TO_CHIPS"
          ? "Conversion request to chips"
          : "Conversion request to Double O",
      created_at: row.created_at,
      admin_decision_at: row.admin_decision_at,
      admin_user_id: row.admin_user_id === null ? null : Number(row.admin_user_id),
      admin_username: row.admin_username || null,
    }));

    const normalizedBonuses = bonusRows.map((row) => ({
      id: `bonus-${row.id}`,
      raw_id: Number(row.id),
      source_kind: row.source_kind,
      action_type: "BONUS",
      user_id: Number(row.user_id),
      username: row.username,
      session_id: row.session_id === null ? null : Number(row.session_id),
      amount: Number(row.amount),
      status: "APPROVED",
      note: row.note || "Bonus",
      created_at: row.created_at,
      admin_decision_at: null,
      admin_user_id: null,
      admin_username: null,
    }));

    const merged = [...normalizedRequests, ...normalizedBonuses].sort((a, b) => {
      const aTime = new Date(a.created_at).getTime();
      const bTime = new Date(b.created_at).getTime();

      if (bTime !== aTime) {
        return bTime - aTime;
      }

      return String(b.id).localeCompare(String(a.id));
    });

    res.json(merged);
  } catch (error) {
    console.error("getConversionRequestsFeed error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function getPendingConversionRequests(req, res) {
  try {
    const [rows] = await db.execute(
      `
      SELECT
        cr.id,
        cr.user_id,
        u.username,
        cr.type,
        cr.amount_mode,
        cr.amount_total,
        cr.white_count,
        cr.red_count,
        cr.blue_count,
        cr.green_count,
        cr.black_count,
        cr.status,
        cr.created_at
      FROM conversion_requests cr
      JOIN users u ON u.id = cr.user_id
      WHERE cr.status = 'PENDING'
      ORDER BY cr.created_at ASC, cr.id ASC
      `,
    );

    res.json(rows);
  } catch (error) {
    console.error("getPendingConversionRequests error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function approveConversionRequest(req, res) {
  const connection = await db.getConnection();

  try {
    const requestId = req.params.id;
    const adminUserId = req.user.id;

    await connection.beginTransaction();

    const [requestRows] = await connection.execute(
      `
      SELECT *
      FROM conversion_requests
      WHERE id = ?
      FOR UPDATE
      `,
      [requestId],
    );

    if (requestRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: "Request not found" });
    }

    const request = requestRows[0];

    if (request.status !== "PENDING") {
      await connection.rollback();
      return res.status(400).json({ message: "Request already handled" });
    }

    const amount = Number(request.amount_total);

    if (request.type === "TO_CHIPS") {
      const userBalance = await getUserBalance(connection, request.user_id);

      if (userBalance < amount) {
        await connection.rollback();
        return res
          .status(400)
          .json({ message: "User does not have enough balance" });
      }

      await insertTransaction(connection, {
        user_id: request.user_id,
        created_by_user_id: adminUserId,
        session_id: request.session_id,
        type: "CONVERSION_TO_CHIPS",
        direction: "DEBIT",
        amount,
        from_unit: "DOUBLE_O",
        to_unit: "CHIPS",
        note: "Approved buy-in conversion",
      });

      if (request.session_id) {
        await upsertSessionPlayerPlaying(connection, request.session_id, request.user_id);
      }
    } else {
      await insertTransaction(connection, {
        user_id: request.user_id,
        created_by_user_id: adminUserId,
        session_id: request.session_id,
        type: "CONVERSION_TO_COINS",
        direction: "CREDIT",
        amount,
        from_unit: "CHIPS",
        to_unit: "DOUBLE_O",
        note: "Approved cash out conversion",
      });

      if (request.session_id) {
        await markSessionPlayerOut(connection, request.session_id, request.user_id);
      }
    }

    await connection.execute(
      `
      UPDATE conversion_requests
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
      message: "Request approved successfully",
      requestId: Number(requestId),
      amount,
    });
  } catch (error) {
    await connection.rollback();
    console.error("approveConversionRequest error:", error);
    res.status(500).json({ message: "Server error" });
  } finally {
    connection.release();
  }
}

async function rejectConversionRequest(req, res) {
  try {
    const requestId = req.params.id;
    const adminUserId = req.user.id;

    const [requestRows] = await db.execute(
      `
      SELECT id, status
      FROM conversion_requests
      WHERE id = ?
      LIMIT 1
      `,
      [requestId],
    );

    if (requestRows.length === 0) {
      return res.status(404).json({ message: "Request not found" });
    }

    if (requestRows[0].status !== "PENDING") {
      return res.status(400).json({ message: "Request already handled" });
    }

    await db.execute(
      `
      UPDATE conversion_requests
      SET
        status = 'REJECTED',
        admin_user_id = ?,
        admin_decision_at = NOW()
      WHERE id = ?
      `,
      [adminUserId, requestId],
    );

    res.json({
      message: "Request rejected successfully",
      requestId: Number(requestId),
    });
  } catch (error) {
    console.error("rejectConversionRequest error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

module.exports = {
  createConversionRequest,
  getConversionRequestsFeed,
  getPendingConversionRequests,
  approveConversionRequest,
  rejectConversionRequest,
};
