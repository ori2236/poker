const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const adminMiddleware = require("../middleware/adminMiddleware");
const {
  getAchievementCoinsCatalog,
  grantAchievementCoinToUser,
  removeAchievementCoinFromUser,
} = require("../controllers/achievementCoinController");

router.get("/catalog", authMiddleware, getAchievementCoinsCatalog);
router.post(
  "/users/:id/grant",
  authMiddleware,
  adminMiddleware,
  grantAchievementCoinToUser,
);
router.delete(
  "/users/:id/:coinCode",
  authMiddleware,
  adminMiddleware,
  removeAchievementCoinFromUser,
);

module.exports = router;
