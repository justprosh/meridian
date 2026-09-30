import { once } from "node:events"
import { pathToFileURL } from "node:url"
import { join } from "node:path"

const [packageRoot, directory, mode] = process.argv.slice(2)
process.env.MERIDIAN_SESSION_DIR = directory
process.env.MERIDIAN_BOOKKEEPING = mode
process.env.MERIDIAN_ROUTING = "manual"
process.env.MERIDIAN_SESSION_GC_GRACE_MS = "3600000"
const api = await import(pathToFileURL(join(packageRoot, "dist", "server.js")).href)
const proxy = await api.startProxyServer({ port: 0, host: "127.0.0.1", silent: true })
if (!proxy.server.address()) await once(proxy.server, "listening")
process.send({ type: "ready", url: `http://127.0.0.1:${proxy.server.address().port}` })
let closing = false
async function close() {
  if (closing) return
  closing = true
  await proxy.close()
  process.exit(0)
}
process.on("message", message => {
  if (message.type === "close") void close().catch(error => { console.error(error); process.exit(1) })
})
process.on("disconnect", () => { void close().catch(() => process.exit(1)) })
