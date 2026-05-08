const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    message: "Hello from Express!",
    status: "Server is running",
    environment: process.env.RENDER ? "Render" : "Local",
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
  });
});

app.post("/echo", (req, res) => {
  res.json({
    received: req.body,
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
