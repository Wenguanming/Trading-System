import { config } from './config.js'
import { migrate, openDatabase } from './database.js'
import { Repository } from './repository.js'
import { Monitor } from './service.js'
import { createApp } from './http.js'
const db = await openDatabase(config.DATABASE_URL, config.DATA_DIR)
await migrate(db)
const monitor = new Monitor(new Repository(db), config)
await monitor.init()
const app = await createApp(monitor, config)
await app.listen({ port: config.PORT, host: config.HOST })
monitor.start()
console.log(`望潮已启动：http://${config.HOST}:${config.PORT} · ${config.SOURCE_MODE === 'demo' ? '演示数据' : '币安公开数据'}`)
let closing = false
async function shutdown() {
  if (closing) return
  closing = true
  await monitor.stop()
  await app.close()
  await db.close()
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  void shutdown().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1) })
})
