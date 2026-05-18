const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const {
  getCoins,
  getMyCoinCollection,
  getUserCoinCollection,
  updateSelectedCoins,
  buyCoin,
  listCoinForSale,
  requestExclusiveOwnership,
} = require("../controllers/coinController");

router.get("/", authMiddleware, getCoins);
router.get("/collection/me", authMiddleware, getMyCoinCollection);
router.get("/collection/:userId", authMiddleware, getUserCoinCollection);
router.put("/selected", authMiddleware, updateSelectedCoins);
router.post("/:id/buy", authMiddleware, buyCoin);
router.post("/:id/list-for-sale", authMiddleware, listCoinForSale);
router.post("/:id/request-exclusive", authMiddleware, requestExclusiveOwnership);

module.exports = router;
