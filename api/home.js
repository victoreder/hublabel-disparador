const fs = require("fs");
const path = require("path");

module.exports = function handler(req, res) {
  const filePath = path.join(__dirname, "..", "public", "index.html");
  const html = fs.readFileSync(filePath, "utf8");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).end(html);
};
