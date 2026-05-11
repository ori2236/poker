const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const adminMiddleware = require("../middleware/adminMiddleware");
const {
  getBonuses,
  createBonus,
  updateBonus,
  deleteBonus,
  createBonusRequest,
} = require("../controllers/bonusController");

router.get("/", authMiddleware, getBonuses);
router.post("/", authMiddleware, adminMiddleware, createBonus);
router.patch("/:id", authMiddleware, adminMiddleware, updateBonus);
router.delete("/:id", authMiddleware, adminMiddleware, deleteBonus);
router.post("/:id/request", authMiddleware, createBonusRequest);

module.exports = router;
