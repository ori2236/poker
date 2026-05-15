const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const adminMiddleware = require("../middleware/adminMiddleware");

const {
  getAllUsers,
  updateMyProfile,
  changeMyPassword,
  updateMySelectedCoins,
  updateUserCardHand,
} = require("../controllers/userController");

router.get("/", authMiddleware, getAllUsers);
router.patch("/me/profile", authMiddleware, updateMyProfile);
router.post("/me/password", authMiddleware, changeMyPassword);
router.patch("/me/selected-coins", authMiddleware, updateMySelectedCoins);
router.patch(
  "/:id/card-hand",
  authMiddleware,
  adminMiddleware,
  updateUserCardHand,
);

module.exports = router;
