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
  deleteUser,
  updateUserSecondaryImage,
  resetUserPassword,
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

router.post(
  "/:id/delete",
  authMiddleware,
  adminMiddleware,
  deleteUser,
);

router.patch(
  "/:id/secondary-image",
  authMiddleware,
  adminMiddleware,
  updateUserSecondaryImage,
);

router.post(
  "/:id/reset-password",
  authMiddleware,
  adminMiddleware,
  resetUserPassword,
);

module.exports = router;
