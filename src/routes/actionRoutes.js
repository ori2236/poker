const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const { getActionFeed } = require("../controllers/actionController");

router.get("/", authMiddleware, getActionFeed);

module.exports = router;
