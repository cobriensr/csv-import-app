import { createApp } from './app';
import { createDatabase } from './db/index';

const PORT = Number(process.env.PORT ?? 3001);
const DB_PATH = process.env.LEDGER_DB ?? ':memory:';

const db = createDatabase(DB_PATH);
const app = createApp(db);

app.listen(PORT, () => {
  console.log(`[api] listening on http://localhost:${PORT}`);
});
