const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const {
  getMyTransactions,
  getAllTransactions,
  getMyDailySummary,
} = require("../controllers/transactionController");

router.get("/me", authMiddleware, getMyTransactions);
router.get("/all", authMiddleware, getAllTransactions);
router.get("/daily-summary/me", authMiddleware, getMyDailySummary);

module.exports = router;
