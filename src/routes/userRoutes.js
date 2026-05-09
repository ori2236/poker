const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const {
  getAllUsers,
  updateMyProfile,
  changeMyPassword,
} = require("../controllers/userController");

router.get("/", authMiddleware, getAllUsers);
router.patch("/me/profile", authMiddleware, updateMyProfile);
router.post("/me/password", authMiddleware, changeMyPassword);

module.exports = router;
