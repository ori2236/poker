const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const {
  getCoins,
  buyCoin,
  listCoinForSale,
  requestExclusiveOwnership,
} = require("../controllers/coinController");

router.get("/", authMiddleware, getCoins);
router.post("/:id/buy", authMiddleware, buyCoin);
router.post("/:id/list-for-sale", authMiddleware, listCoinForSale);
router.post("/:id/request-exclusive", authMiddleware, requestExclusiveOwnership);

module.exports = router;
