import 'dotenv/config'
import express from 'express'
import axios from 'axios'
import https from 'https'
import fs from 'fs'
import { registerMediator } from 'openhim-mediator-utils'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const mediatorConfig = require('./mediatorConfig.json')

let httpsAgent = undefined
if (process.env.NODE_ENV === 'development') {
  httpsAgent = new https.Agent({ rejectUnauthorized: false })
  axios.defaults.httpsAgent = httpsAgent
  console.log('⚠️  MODO DEVELOPMENT: Certificados self-signed aceptados')
} else {
  console.log('🟢 MODO PRODUCTION: Solo certificados SSL válidos')
}

const openhimConfig = {
  username: process.env.OPENHIM_USER,
  password: process.env.OPENHIM_PASS,
  apiURL: process.env.OPENHIM_API,
  trustSelfSigned: true
}

registerMediator(openhimConfig, mediatorConfig, err => {
  if (err) {
    console.error('Failed to register mediator:', err)
    process.exit(1)
  }
  console.log('Mediator registered successfully!')
})

const app = express()
app.use(express.json({ limit: '15mb' }))

const FHIR_PROXY = process.env.FHIR_PROXY_URL // ej: http://fhir-proxy:7000
const FHIR_NODE_URL = process.env.FHIR_NODE_URL // ej: http://fhir-node:8080
const MAX_RETRIES = 3

// --- Persistencia simple de vistos ---
const SEEN_FILE = './seen.json'
let seen = new Set()
try {
  if (fs.existsSync(SEEN_FILE)) {
    seen = new Set(JSON.parse(fs.readFileSync(SEEN_FILE)))
  }
} catch {}

// --- Guardar en disco (async-safe) ---
function saveSeen() {
  fs.writeFile(SEEN_FILE, JSON.stringify([...seen]), err => {
    if (err) console.error('❌ Error guardando seen.json:', err)
  })
}

// --- Reintento simple (exponencial) ---
async function retryRequest(fn, maxRetries = MAX_RETRIES) {
  let attempt = 0
  let lastErr = null
  while (attempt < maxRetries) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      attempt++
      const wait = 500 * attempt
      console.warn(`⏳ Retry ${attempt}/${maxRetries} after error:`, err.message)
      await new Promise(res => setTimeout(res, wait))
    }
  }
  throw lastErr
}

// --- Utilidad para loggear cada acción ---
function logStep(msg, ...data) {
  const ts = new Date().toISOString()
  console.log(`[${ts}]`, msg, ...data)
}

// --- Trae recurso FHIR desde el proxy ---
async function getFromProxy(path) {
  const url = `${FHIR_PROXY}/fhir${path}`
  logStep('GET (proxy)', url)
  const resp = await axios.get(url)
  return resp.data
}

// --- Envía recurso FHIR al nodo nacional ---
async function putToNode(resource) {
  const url = `${FHIR_NODE_URL}/fhir/${resource.resourceType}/${resource.id}`
  return retryRequest(async () => {
    logStep('PUT (node)', url)
    const resp = await axios.put(url, resource, {
      headers: { 'Content-Type': 'application/fhir+json' }
    })
    logStep('✅ PUT OK', resource.resourceType, resource.id, resp.status)
    return resp.status
  })
}

// --- Lógica principal ---
app.post('/event', async (req, res) => {
  const { uuid } = req.body
  if (!uuid) return res.status(400).json({ error: 'Falta uuid' })
  if (seen.has(uuid)) return res.status(200).json({ status: 'duplicado', uuid })

  logStep('🔔 Nuevo evento', uuid)
  seen.add(uuid)
  saveSeen()

  const results = []

  try {
    // 1. Obtener Encounter principal
    const encounter = await getFromProxy(`/Encounter/${uuid}`)
    results.push(await putToNode(encounter))

    // 2. Obtener Patient
    const patientId = encounter.subject?.reference?.split('/').pop()
    if (patientId) {
      const patient = await getFromProxy(`/Patient/${patientId}`)
      results.push(await putToNode(patient))
    }

    // 3. Observations vinculadas
    const obsBundle = await getFromProxy(`/Observation?encounter=${uuid}`)
    if (obsBundle.entry) {
      for (const entry of obsBundle.entry) {
        if (entry.resource?.resourceType && entry.resource?.id) {
          results.push(await putToNode(entry.resource))
        }
      }
    }

    // 4. Conditions vinculadas (puedes agregar más recursos según tu lógica)
    const condBundle = await getFromProxy(`/Condition?encounter=${uuid}`)
    if
