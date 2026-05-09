const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const adminMiddleware = require("../middleware/adminMiddleware");

const {
  getActiveSession,
  startSession,
  endActiveSession,
  getSessionSummary,
} = require("../controllers/sessionController");

router.get("/active", authMiddleware, getActiveSession);
router.post("/start", authMiddleware, adminMiddleware, startSession);
router.post("/active/end", authMiddleware, adminMiddleware, endActiveSession);
router.get("/:id/summary", authMiddleware, getSessionSummary);

module.exports = router;
