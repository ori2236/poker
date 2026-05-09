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

async function insertApprovedConversionRequest(connection, data) {
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
      status,
      admin_user_id,
      admin_decision_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'APPROVED', ?, NOW())
    `,
    [
      data.user_id,
      data.session_id,
      data.type,
      data.amount_mode,
      data.amount_total,
      Number(data.white_count || 0),
      Number(data.red_count || 0),
      Number(data.blue_count || 0),
      Number(data.green_count || 0),
      Number(data.black_count || 0),
      data.admin_user_id,
    ],
  );

  return result.insertId;
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

async function getPendingCashout(connection, sessionId, userId) {
  const [rows] = await connection.execute(
    `
    SELECT id
    FROM conversion_requests
    WHERE session_id = ?
      AND user_id = ?
      AND type = 'TO_COINS'
      AND status = 'PENDING'
    LIMIT 1
    `,
    [sessionId, userId],
  );

  return rows[0] || null;
}

async function getActiveSession(req, res) {
  try {
    const [sessionRows] = await db.execute(
      `
      SELECT
        gs.id,
        gs.title,
        gs.status
      FROM game_sessions gs
      WHERE gs.status = 'ACTIVE'
      LIMIT 1
      `,
    );

    if (sessionRows.length === 0) {
      return res.json({ activeSession: null });
    }

    const session = sessionRows[0];

    const [players] = await db.execute(
      `
      SELECT
        sp.user_id,
        u.username,
        u.profile_image_base64,
        sp.joined_at,
        sp.left_at,
        sp.is_playing
      FROM session_players sp
      JOIN users u ON u.id = sp.user_id
      WHERE sp.session_id = ?
      ORDER BY sp.is_playing DESC, u.username ASC
      `,
      [session.id],
    );

    const [pendingRequests] = await db.execute(
      `
      SELECT
        cr.id,
        cr.user_id,
        u.username,
        cr.type,
        cr.amount_mode,
        cr.amount_total,
        cr.status,
        cr.created_at
      FROM conversion_requests cr
      JOIN users u ON u.id = cr.user_id
      WHERE cr.session_id = ? AND cr.status = 'PENDING'
      ORDER BY cr.created_at ASC, cr.id ASC
      `,
      [session.id],
    );

    const [myPendingRows] = await db.execute(
      `
      SELECT
        cr.id,
        cr.user_id,
        cr.type,
        cr.amount_mode,
        cr.amount_total,
        cr.status,
        cr.created_at
      FROM conversion_requests cr
      WHERE cr.session_id = ? AND cr.user_id = ? AND cr.status = 'PENDING'
      ORDER BY cr.id DESC
      LIMIT 1
      `,
      [session.id, req.user.id],
    );

    res.json({
      activeSession: {
        ...session,
        players,
        pendingRequests,
        myPendingRequest: myPendingRows[0] || null,
      },
    });
  } catch (error) {
    console.error("getActiveSession error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function startSession(req, res) {
  const connection = await db.getConnection();

  try {
    const adminUserId = req.user.id;
    const {
      title,
      amount_mode = "TOTAL_AMOUNT",
      amount_total,
      white_count = 0,
      red_count = 0,
      blue_count = 0,
      green_count = 0,
      black_count = 0,
    } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ message: "Title is required" });
    }

    let buyInAmount;

    try {
      buyInAmount = normalizeAmount({
        amount_mode,
        amount_total,
        white_count,
        red_count,
        blue_count,
        green_count,
        black_count,
      });
    } catch (error) {
      return res.status(400).json({ message: error.message || "Invalid amount" });
    }

    if (buyInAmount <= 0) {
      return res.status(400).json({
        message: "Admin buy-in must be greater than 0",
      });
    }

    await connection.beginTransaction();

    const [activeRows] = await connection.execute(
      `
      SELECT id
      FROM game_sessions
      WHERE status = 'ACTIVE'
      LIMIT 1
      FOR UPDATE
      `,
    );

    if (activeRows.length > 0) {
      await connection.rollback();
      return res
        .status(400)
        .json({ message: "There is already an active session" });
    }

    const adminBalance = await getUserBalance(connection, adminUserId);

    if (adminBalance < buyInAmount) {
      await connection.rollback();
      return res.status(400).json({ message: "Admin does not have enough balance" });
    }

    const [result] = await connection.execute(
      `
      INSERT INTO game_sessions (title, status, started_by_user_id)
      VALUES (?, 'ACTIVE', ?)
      `,
      [title.trim(), adminUserId],
    );

    const sessionId = result.insertId;

    await upsertSessionPlayerPlaying(connection, sessionId, adminUserId);

    await insertApprovedConversionRequest(connection, {
      user_id: adminUserId,
      session_id: sessionId,
      type: "TO_CHIPS",
      amount_mode,
      amount_total: buyInAmount,
      white_count,
      red_count,
      blue_count,
      green_count,
      black_count,
      admin_user_id: adminUserId,
    });

    await insertTransaction(connection, {
      user_id: adminUserId,
      created_by_user_id: adminUserId,
      session_id: sessionId,
      type: "CONVERSION_TO_CHIPS",
      direction: "DEBIT",
      amount: buyInAmount,
      from_unit: "DOUBLE_O",
      to_unit: "CHIPS",
      note: "Admin opening session buy-in",
    });

    await connection.commit();

    res.status(201).json({
      message: "Session started successfully",
      sessionId,
      adminBuyInAmount: buyInAmount,
    });
  } catch (error) {
    await connection.rollback();
    console.error("startSession error:", error);
    res.status(500).json({ message: "Server error" });
  } finally {
    connection.release();
  }
}

async function endActiveSession(req, res) {
  const connection = await db.getConnection();

  try {
    const adminUserId = req.user.id;
    const {
      amount_mode = "TOTAL_AMOUNT",
      amount_total,
      white_count = 0,
      red_count = 0,
      blue_count = 0,
      green_count = 0,
      black_count = 0,
    } = req.body;

    let adminCashoutAmount;

    try {
      adminCashoutAmount = normalizeAmount({
        amount_mode,
        amount_total,
        white_count,
        red_count,
        blue_count,
        green_count,
        black_count,
      });
    } catch (error) {
      return res.status(400).json({ message: error.message || "Invalid amount" });
    }

    await connection.beginTransaction();

    const [activeRows] = await connection.execute(
      `
      SELECT id
      FROM game_sessions
      WHERE status = 'ACTIVE'
      LIMIT 1
      FOR UPDATE
      `,
    );

    if (activeRows.length === 0) {
      await connection.rollback();
      return res.status(400).json({ message: "No active session" });
    }

    const sessionId = activeRows[0].id;

    const [activePlayers] = await connection.execute(
      `
      SELECT sp.user_id, u.username
      FROM session_players sp
      JOIN users u ON u.id = sp.user_id
      WHERE sp.session_id = ? AND sp.is_playing = TRUE AND sp.user_id <> ?
      ORDER BY u.username ASC
      `,
      [sessionId, adminUserId],
    );

    let forcedZeroCashOutCount = 0;
    let preservedPendingCashOutCount = 0;

    for (const player of activePlayers) {
      const pendingCashout = await getPendingCashout(connection, sessionId, player.user_id);

      if (pendingCashout) {
        preservedPendingCashOutCount += 1;
        continue;
      }

      await insertApprovedConversionRequest(connection, {
        user_id: player.user_id,
        session_id: sessionId,
        type: "TO_COINS",
        amount_mode: "TOTAL_AMOUNT",
        amount_total: 0,
        white_count: 0,
        red_count: 0,
        blue_count: 0,
        green_count: 0,
        black_count: 0,
        admin_user_id: adminUserId,
      });

      await insertTransaction(connection, {
        user_id: player.user_id,
        created_by_user_id: adminUserId,
        session_id: sessionId,
        type: "CONVERSION_TO_COINS",
        direction: "CREDIT",
        amount: 0,
        from_unit: "CHIPS",
        to_unit: "DOUBLE_O",
        note: "Automatic zero cash out on session end",
      });

      forcedZeroCashOutCount += 1;
    }

    await insertApprovedConversionRequest(connection, {
      user_id: adminUserId,
      session_id: sessionId,
      type: "TO_COINS",
      amount_mode,
      amount_total: adminCashoutAmount,
      white_count,
      red_count,
      blue_count,
      green_count,
      black_count,
      admin_user_id: adminUserId,
    });

    await insertTransaction(connection, {
      user_id: adminUserId,
      created_by_user_id: adminUserId,
      session_id: sessionId,
      type: "CONVERSION_TO_COINS",
      direction: "CREDIT",
      amount: adminCashoutAmount,
      from_unit: "CHIPS",
      to_unit: "DOUBLE_O",
      note: "Admin session close cash out",
    });

    await connection.execute(
      `
      UPDATE session_players
      SET
        is_playing = FALSE,
        left_at = COALESCE(left_at, NOW())
      WHERE session_id = ? AND is_playing = TRUE
      `,
      [sessionId],
    );

    await connection.execute(
      `
      UPDATE game_sessions
      SET
        status = 'ENDED',
        ended_by_user_id = ?,
        ended_at = NOW()
      WHERE id = ?
      `,
      [adminUserId, sessionId],
    );

    await connection.commit();

    res.json({
      message: "Session ended successfully",
      forcedZeroCashOutCount,
      preservedPendingCashOutCount,
      adminCashOutAmount: adminCashoutAmount,
    });
  } catch (error) {
    await connection.rollback();
    console.error("endActiveSession error:", error);
    res.status(500).json({ message: "Server error" });
  } finally {
    connection.release();
  }
}

async function getSessionSummary(req, res) {
  try {
    const sessionId = req.params.id;

    const [sessionRows] = await db.execute(
      `
      SELECT
        gs.id,
        gs.title,
        gs.status,
        gs.started_at,
        gs.ended_at
      FROM game_sessions gs
      WHERE gs.id = ?
      LIMIT 1
      `,
      [sessionId],
    );

    if (sessionRows.length === 0) {
      return res.status(404).json({ message: "Session not found" });
    }

    const [players] = await db.execute(
      `
      SELECT
        sp.user_id,
        u.username,
        sp.joined_at,
        sp.left_at,
        COALESCE(SUM(CASE WHEN bt.direction = 'CREDIT' THEN bt.amount ELSE 0 END), 0) AS total_in,
        COALESCE(SUM(CASE WHEN bt.direction = 'DEBIT' THEN bt.amount ELSE 0 END), 0) AS total_out,
        COALESCE(SUM(CASE WHEN bt.direction = 'CREDIT' THEN bt.amount WHEN bt.direction = 'DEBIT' THEN -bt.amount ELSE 0 END), 0) AS net
      FROM session_players sp
      JOIN users u ON u.id = sp.user_id
      LEFT JOIN balance_transactions bt
        ON bt.session_id = sp.session_id
       AND bt.user_id = sp.user_id
      WHERE sp.session_id = ?
      GROUP BY sp.user_id, u.username, sp.joined_at, sp.left_at
      ORDER BY u.username ASC
      `,
      [sessionId],
    );

    res.json({
      session: sessionRows[0],
      players: players.map((row) => ({
        ...row,
        total_in: Number(row.total_in),
        total_out: Number(row.total_out),
        net: Number(row.net),
      })),
    });
  } catch (error) {
    console.error("getSessionSummary error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

module.exports = {
  getActiveSession,
  startSession,
  endActiveSession,
  getSessionSummary,
};
