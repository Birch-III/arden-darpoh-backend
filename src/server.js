require('dotenv').config();
const { createApp } = require('./app');

const app = createApp();
const port = process.env.PORT || 4000;

app.listen(port, () => {
  console.log(`Arden Darpoh Family Land API listening on http://localhost:${port}`);
});
