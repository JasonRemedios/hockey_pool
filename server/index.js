import "dotenv/config";
import { createPoolApp } from "./app.js";
import { initializeStore } from "./store.js";

const port = Number(process.env.PORT || 4242);
const app = createPoolApp({ port });

await initializeStore();

app.listen(port, () => {
  console.log(`Pool API server listening on http://127.0.0.1:${port}`);
});
