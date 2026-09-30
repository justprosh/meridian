import { createServer } from "node:http"
import { pathToFileURL } from "node:url"
import { join } from "node:path"

const [packageRoot, directory, mode] = process.argv.slice(2)
process.env.MERIDIAN_SESSION_DIR = directory
process.env.MERIDIAN_BOOKKEEPING = mode
process.env.MERIDIAN_ROUTING = "manual"
process.env.MERIDIAN_SESSION_GC_GRACE_MS = "3600000"
const api = await import(pathToFileURL(join(packageRoot, "dist", "server.js")).href)
const startup = await api.initializeProxyBookkeeping?.()
const proxy = api.createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
const server = createServer(async (request, response) => {
  try {
    const result = await proxy.app.fetch(new Request(`http://127.0.0.1${request.url}`))
    response.writeHead(result.status, Object.fromEntries(result.headers))
    response.end(Buffer.from(await result.arrayBuffer()))
  } catch (error) {
    response.writeHead(500)
    response.end(String(error))
  }
})
server.listen(0, "127.0.0.1", () => {
  process.send({ type: "ready", url: `http://127.0.0.1:${server.address().port}` })
})
let closing = false
async function close() {
  if (closing) return
  closing = true
  proxy.beginDrain?.()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await proxy.closeBackend?.()
  startup?.close()
  process.exit(0)
}
process.on("message", message => {
  if (message.type === "close") void close().catch(error => { console.error(error); process.exit(1) })
})
process.on("disconnect", () => { void close().catch(() => process.exit(1)) })
