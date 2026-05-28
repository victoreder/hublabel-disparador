require("dotenv").config();

const createApp = require("./app");
const port = Number(process.env.PORT || 3000);

createApp().listen(port, () => {
  console.log(`OAuth broker local em http://localhost:${port}`);
});
