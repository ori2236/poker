const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const adminMiddleware = require("../middleware/adminMiddleware");

const {
  createConversionRequest,
  getConversionRequestsFeed,
  getPendingConversionRequests,
  approveConversionRequest,
  rejectConversionRequest,
} = require("../controllers/conversionRequestController");

router.post("/", authMiddleware, createConversionRequest);
router.get("/", authMiddleware, getConversionRequestsFeed);
router.get(
  "/pending",
  authMiddleware,
  adminMiddleware,
  getPendingConversionRequests,
);
router.post(
  "/:id/approve",
  authMiddleware,
  adminMiddleware,
  approveConversionRequest,
);
router.post(
  "/:id/reject",
  authMiddleware,
  adminMiddleware,
  rejectConversionRequest,
);

module.exports = router;
