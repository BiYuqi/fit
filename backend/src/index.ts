import 'dotenv/config'
import Fastify from 'fastify'

const app = Fastify({ logger: true })

app.get('/api/health', async () => ({ ok: true }))

const port = Number(process.env.PORT) || 3000

app.listen({ port, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err)
    process.exit(1)
  }
})
