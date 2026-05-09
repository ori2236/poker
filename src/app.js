const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");
const balanceRoutes = require("./routes/balanceRoutes");
const transactionRoutes = require("./routes/transactionRoutes");
const conversionRequestRoutes = require("./routes/conversionRequestRoutes");
const sessionRoutes = require("./routes/sessionRoutes");

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/", (req, res) => {
  res.json({ message: "Poker API is running" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.use("/auth", authRoutes);
app.use("/users", userRoutes);
app.use("/balances", balanceRoutes);
app.use("/transactions", transactionRoutes);
app.use("/conversion-requests", conversionRequestRoutes);
app.use("/sessions", sessionRoutes);

module.exports = app;
