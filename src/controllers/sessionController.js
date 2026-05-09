const db = require("../config/db");

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
    const { title } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ message: "Title is required" });
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

    const [result] = await connection.execute(
      `
      INSERT INTO game_sessions (title, status, started_by_user_id)
      VALUES (?, 'ACTIVE', ?)
      `,
      [title.trim(), adminUserId],
    );

    const sessionId = result.insertId;

    await connection.execute(
      `
      INSERT INTO session_players (session_id, user_id, is_playing, left_at)
      VALUES (?, ?, TRUE, NULL)
      ON DUPLICATE KEY UPDATE
        is_playing = TRUE,
        left_at = NULL
      `,
      [sessionId, adminUserId],
    );

    await connection.commit();

    res.status(201).json({
      message: "Session started successfully",
      sessionId,
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
    const force = !!req.body.force;

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
      `,
      [sessionId, adminUserId],
    );

    if (activePlayers.length > 0 && !force) {
      await connection.rollback();
      return res.status(409).json({
        message: "There are still active players at the table",
        requiresConfirmation: true,
        activePlayers: activePlayers.map((p) => p.username),
      });
    }

    if (activePlayers.length > 0 && force) {
      for (const player of activePlayers) {
        await connection.execute(
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
          VALUES (?, ?, 'TO_COINS', 'TOTAL_AMOUNT', 0, 0, 0, 0, 0, 0, 'APPROVED', ?, NOW())
          `,
          [player.user_id, sessionId, adminUserId],
        );

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
          VALUES (?, ?, ?, 'CONVERSION_TO_COINS', 'CREDIT', 0, 'CHIPS', 'DOUBLE_O', ?)
          `,
          [
            player.user_id,
            adminUserId,
            sessionId,
            "Forced cash out with 0 on session end",
          ],
        );
      }
    }

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
      forcedCashOutCount: activePlayers.length,
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
