const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const adminMiddleware = require("../middleware/adminMiddleware");
const {
  getPendingRequests,
  approveBonusRequest,
  rejectBonusRequest,
  approveCoinRequest,
  rejectCoinRequest,
  getRequestHistory,
} = require("../controllers/requestController");
const {
  approveConversionRequest,
  rejectConversionRequest,
} = require("../controllers/conversionRequestController");

router.get("/pending", authMiddleware, adminMiddleware, getPendingRequests);
router.get("/history", authMiddleware, getRequestHistory);
router.post(
  "/conversion/:id/approve",
  authMiddleware,
  adminMiddleware,
  approveConversionRequest,
);
router.post(
  "/conversion/:id/reject",
  authMiddleware,
  adminMiddleware,
  rejectConversionRequest,
);
router.post(
  "/bonus/:id/approve",
  authMiddleware,
  adminMiddleware,
  approveBonusRequest,
);
router.post(
  "/bonus/:id/reject",
  authMiddleware,
  adminMiddleware,
  rejectBonusRequest,
);
router.post(
  "/coin/:id/approve",
  authMiddleware,
  adminMiddleware,
  approveCoinRequest,
);
router.post(
  "/coin/:id/reject",
  authMiddleware,
  adminMiddleware,
  rejectCoinRequest,
);

module.exports = router;
