const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const {
  getMyBalance,
  getLeaderboard,
} = require("../controllers/balanceController");

router.get("/me", authMiddleware, getMyBalance);
router.get("/leaderboard", authMiddleware, getLeaderboard);

module.exports = router;
