const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const MACHINES = ["31613", "31994", "32027", "393"];

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/machines", (_req, res) => {
  res.json({ machines: MACHINES });
});

app.get("/api/machines/:id", (req, res) => {
  const id = String(req.params.id);
  if (!MACHINES.includes(id)) {
    return res.status(404).json({ error: "Апарат не знайдено" });
  }
  res.json({ id });
});

app.get("/machine/:id", (req, res) => {
  const id = String(req.params.id);
  if (!MACHINES.includes(id)) {
    return res.status(404).sendFile(path.join(__dirname, "public", "not-found.html"));
  }
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ПоВоду запущено на порту ${PORT}`);
});
