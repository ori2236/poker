const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const { getActions } = require("../controllers/actionController");

router.get("/", authMiddleware, getActions);

module.exports = router;
