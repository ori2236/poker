async function refreshWinnerCoinHolders(connection) {
  const [lastSessionRows] = await connection.execute(`
    SELECT id, title, ended_at
    FROM game_sessions
    WHERE status = 'ENDED'
    ORDER BY COALESCE(ended_at, started_at, '1970-01-01') DESC, id DESC
    LIMIT 1
  `);

  await connection.execute("UPDATE users SET is_winner_coin_holder = 0");

  if (lastSessionRows.length === 0) {
    return [];
  }

  const lastSession = lastSessionRows[0];
  const sessionId = Number(lastSession.id);

  const [rankedRows] = await connection.execute(
    `
    SELECT
      u.id,
      u.username,
      COALESCE(SUM(CASE WHEN cr.type = 'TO_CHIPS' THEN cr.amount_total ELSE 0 END), 0) AS buy_in_total,
      COALESCE(SUM(CASE WHEN cr.type = 'TO_COINS' THEN cr.amount_total ELSE 0 END), 0) AS cash_out_total,
      COALESCE(SUM(
        CASE
          WHEN cr.type = 'TO_COINS' THEN cr.amount_total
          WHEN cr.type = 'TO_CHIPS' THEN -cr.amount_total
          ELSE 0
        END
      ), 0) AS session_net
    FROM session_players sp
    JOIN users u ON u.id = sp.user_id AND u.is_active = 1
    LEFT JOIN conversion_requests cr
      ON cr.session_id = sp.session_id
     AND cr.user_id = sp.user_id
     AND cr.status = 'APPROVED'
    WHERE sp.session_id = ?
    GROUP BY u.id, u.username
    HAVING buy_in_total > 0
    ORDER BY session_net DESC, cash_out_total DESC, buy_in_total ASC, u.username ASC
    `,
    [sessionId],
  );

  if (rankedRows.length === 0) {
    return [];
  }

  const bestSessionNet = Number(rankedRows[0].session_net || 0);
  const winners = rankedRows.filter(
    (row) => Number(row.session_net || 0) === bestSessionNet,
  );

  if (winners.length > 0) {
    const placeholders = winners.map(() => "?").join(", ");
    await connection.execute(
      `
      UPDATE users
      SET is_winner_coin_holder = 1
      WHERE id IN (${placeholders})
      `,
      winners.map((winner) => winner.id),
    );
  }

  return winners.map((winner) => ({
    id: Number(winner.id),
    username: winner.username,
    sessionId,
    sessionTitle: lastSession.title || null,
    buyInTotal: Number(winner.buy_in_total || 0),
    cashOutTotal: Number(winner.cash_out_total || 0),
    sessionNet: Number(winner.session_net || 0),
  }));
}

module.exports = {
  refreshWinnerCoinHolders,
};
