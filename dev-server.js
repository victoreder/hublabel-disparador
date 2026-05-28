const dotenv = require("dotenv");

dotenv.config();

const app = require("./app")();
const port = Number(process.env.PORT || 3000);

app.listen(port, () => {
  console.log(`OAuth broker online em http://localhost:${port}`);
});
