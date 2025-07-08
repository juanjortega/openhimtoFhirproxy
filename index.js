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
app.use(express.json({ limit: '20mb' }))

const FHIR_PROXY = process.env.FHIR_PROXY_URL // ej: http://fhir-proxy:7000
const FHIR_NODE_URL = process.env.FHIR_NODE_URL // ej: http://nodo-fhir:8080
const MAX_RETRIES = 3

// Estado de configuración al inicio
function logStep(msg, ...data) {
  const ts = new Date().toISOString()
  console.log(`[${ts}]`, msg, ...data)
}

function logConfiguration() {
  logStep('🔧 DEBUG: Verificando configuración del sistema')
  logStep('🔧 DEBUG: FHIR_PROXY_URL =', FHIR_PROXY || 'NO DEFINIDO')
  logStep('🔧 DEBUG: FHIR_NODE_URL =', FHIR_NODE_URL || 'NO DEFINIDO')
  logStep('🔧 DEBUG: NODE_ENV =', process.env.NODE_ENV || 'NO DEFINIDO')
  logStep('🔧 DEBUG: MAX_RETRIES =', MAX_RETRIES)
  logStep('🔧 DEBUG: OPENHIM_USER =', process.env.OPENHIM_USER ? '***SET***' : 'NO DEFINIDO')
  logStep('🔧 DEBUG: OPENHIM_PASS =', process.env.OPENHIM_PASS ? '***SET***' : 'NO DEFINIDO')
  logStep('🔧 DEBUG: OPENHIM_API =', process.env.OPENHIM_API || 'NO DEFINIDO')
}

const SEEN_FILE = './seen.json'
let seen = new Set()
try {
  if (fs.existsSync(SEEN_FILE)) {
    seen = new Set(JSON.parse(fs.readFileSync(SEEN_FILE)))
    logStep('🔧 DEBUG: Archivo seen.json cargado con', seen.size, 'UUIDs previos')
  } else {
    logStep('🔧 DEBUG: Archivo seen.json no existe, iniciando con conjunto vacío')
  }
} catch (error) {
  logStep('🔧 DEBUG: Error cargando seen.json:', error.message)
}

// Llamar a la función de configuración después de definir logStep
logConfiguration()

function saveSeen() {
  logStep('🔧 DEBUG: saveSeen() iniciado - guardando', seen.size, 'UUIDs')
  fs.writeFile(SEEN_FILE, JSON.stringify([...seen]), err => {
    if (err) {
      logStep('❌ Error guardando seen.json:', err.message)
      logStep('🔧 DEBUG: Stack trace:', err.stack)
    } else {
      logStep('🔧 DEBUG: seen.json guardado exitosamente')
    }
  })
}

async function retryRequest(fn, maxRetries = MAX_RETRIES) {
  logStep('🔧 DEBUG: retryRequest() iniciado - maxRetries:', maxRetries)
  let attempt = 0
  let lastErr = null
  while (attempt < maxRetries) {
    try {
      logStep('🔧 DEBUG: Intento', attempt + 1, 'de', maxRetries)
      const result = await fn()
      logStep('🔧 DEBUG: retryRequest() exitoso en intento', attempt + 1)
      return result
    } catch (err) {
      lastErr = err
      attempt++
      const wait = 500 * attempt
      logStep('⏳ Retry', attempt, '/', maxRetries, 'after error:', err.message)
      logStep('🔧 DEBUG: Error stack:', err.stack)
      if (attempt < maxRetries) {
        logStep('🔧 DEBUG: Esperando', wait, 'ms antes del siguiente intento')
        await new Promise(res => setTimeout(res, wait))
      }
    }
  }
  logStep('🔧 DEBUG: retryRequest() falló después de', maxRetries, 'intentos')
  logStep('🔧 DEBUG: Error final:', lastErr.message)
  logStep('🔧 DEBUG: Stack trace final:', lastErr.stack)
  throw lastErr
}

async function getFromProxy(path) {
  logStep('🔧 DEBUG: getFromProxy() iniciado con parámetros:', { path })
  const url = `${FHIR_PROXY}/fhir${path}`
  logStep('🔧 DEBUG: URL construida:', url)
  try {
    logStep('GET (proxy)', url)
    const resp = await axios.get(url)
    logStep('🔧 DEBUG: getFromProxy() exitoso - status:', resp.status, 'data size:', JSON.stringify(resp.data).length, 'chars')
    return resp.data
  } catch (error) {
    logStep('❌ ERROR en getFromProxy():', error.message)
    logStep('🔧 DEBUG: Error stack:', error.stack)
    logStep('🔧 DEBUG: URL que falló:', url)
    throw error
  }
}

async function putToNode(resource) {
  logStep('🔧 DEBUG: putToNode() iniciado con parámetros:', { 
    resourceType: resource?.resourceType, 
    id: resource?.id,
    dataSize: JSON.stringify(resource).length + ' chars'
  })
  const url = `${FHIR_NODE_URL}/fhir/${resource.resourceType}/${resource.id}`
  logStep('🔧 DEBUG: URL construida para PUT:', url)
  return retryRequest(async () => {
    try {
      logStep('PUT (node)', url)
      const resp = await axios.put(url, resource, {
        headers: { 'Content-Type': 'application/fhir+json' }
      })
      logStep('✅ PUT OK', resource.resourceType, resource.id, resp.status)
      logStep('🔧 DEBUG: putToNode() exitoso para', resource.resourceType, resource.id)
      return resp.status
    } catch (error) {
      logStep('❌ ERROR en putToNode():', error.message)
      logStep('🔧 DEBUG: Error stack:', error.stack)
      logStep('🔧 DEBUG: Resource que falló:', resource.resourceType, resource.id)
      throw error
    }
  })
}

app.post('/event', async (req, res) => {
  const { uuid } = req.body
  logStep('🔧 DEBUG: /event endpoint iniciado con body:', { uuid, bodySize: JSON.stringify(req.body).length + ' chars' })
  
  if (!uuid) {
    logStep('🔧 DEBUG: UUID faltante en request body')
    return res.status(400).json({ error: 'Falta uuid' })
  }
  
  if (seen.has(uuid)) {
    logStep('🔧 DEBUG: UUID duplicado detectado:', uuid)
    return res.status(200).json({ status: 'duplicado', uuid })
  }

  logStep('🔔 Nuevo evento', uuid)
  logStep('🔧 DEBUG: Agregando UUID al conjunto seen, tamaño actual:', seen.size)
  seen.add(uuid)
  saveSeen()

  const results = []
  logStep('🔧 DEBUG: Iniciando procesamiento de recursos FHIR para UUID:', uuid)

  try {
    // 1. Encounter
    logStep('🔧 DEBUG: Paso 1 - Obteniendo Encounter para UUID:', uuid)
    const encounter = await getFromProxy(`/Encounter/${uuid}`)
    logStep('🔧 DEBUG: Encounter obtenido exitosamente:', encounter?.resourceType, encounter?.id)
    results.push(await putToNode(encounter))

    // 2. Patient
    logStep('🔧 DEBUG: Paso 2 - Procesando Patient del Encounter')
    const patientId = encounter.subject?.reference?.split('/').pop()
    logStep('🔧 DEBUG: Patient ID extraído:', patientId)
    if (patientId) {
      logStep('🔧 DEBUG: Obteniendo Patient con ID:', patientId)
      const patient = await getFromProxy(`/Patient/${patientId}`)
      logStep('🔧 DEBUG: Patient obtenido exitosamente:', patient?.resourceType, patient?.id)
      results.push(await putToNode(patient))
    } else {
      logStep('🔧 DEBUG: No se pudo extraer Patient ID del Encounter')
    }

    // 3. Recursos FHIR relacionados según la guía de OpenMRS
    logStep('🔧 DEBUG: Paso 3 - Procesando recursos FHIR relacionados')
    const resourceQueries = [
      { type: 'Observation', q: `/Observation?encounter=${uuid}` },
      { type: 'Condition', q: `/Condition?encounter=${uuid}` },
      { type: 'Procedure', q: `/Procedure?encounter=${uuid}` },
      { type: 'MedicationRequest', q: `/MedicationRequest?encounter=${uuid}` },
      { type: 'Medication', q: `/Medication?encounter=${uuid}` }, // si aplica
      { type: 'AllergyIntolerance', q: `/AllergyIntolerance?encounter=${uuid}` },
      { type: 'DiagnosticReport', q: `/DiagnosticReport?encounter=${uuid}` },
      { type: 'Immunization', q: `/Immunization?encounter=${uuid}` },
      { type: 'CarePlan', q: `/CarePlan?encounter=${uuid}` },
      { type: 'Appointment', q: `/Appointment?encounter=${uuid}` },
      { type: 'DocumentReference', q: `/DocumentReference?encounter=${uuid}` }
    ]
    
    logStep('🔧 DEBUG: Procesando', resourceQueries.length, 'tipos de recursos')
    for (const { type, q } of resourceQueries) {
      logStep('🔧 DEBUG: Procesando recurso tipo:', type, 'con query:', q)
      try {
        const bundle = await getFromProxy(q)
        logStep('🔧 DEBUG: Bundle obtenido para', type, '- entries:', bundle.entry?.length || 0)
        if (bundle.entry) {
          logStep('🔧 DEBUG: Procesando', bundle.entry.length, 'entries del bundle', type)
          for (const entry of bundle.entry) {
            if (entry.resource?.resourceType && entry.resource?.id) {
              logStep('🔧 DEBUG: Procesando entry:', entry.resource.resourceType, entry.resource.id)
              results.push(await putToNode(entry.resource))
            } else {
              logStep('🔧 DEBUG: Entry sin resourceType o id válido en', type)
            }
          }
        } else {
          logStep('🔧 DEBUG: Bundle sin entries para', type)
        }
      } catch (e) {
        logStep(`No se pudo obtener ${type}:`, e.message)
        logStep('🔧 DEBUG: Stack trace para', type, ':', e.stack)
      }
    }
    logStep('🔧 DEBUG: Procesamiento completado - total recursos procesados:', results.length)
    logStep('🎉 Proceso completado para', uuid)
    res.json({ status: 'ok', uuid, sent: results.length })
  } catch (err) {
    logStep('❌ ERROR', err.message)
    logStep('🔧 DEBUG: Error stack principal:', err.stack)
    logStep('🔧 DEBUG: Error procesando UUID:', uuid)
    res.status(500).json({ error: err.message })
  }
})

app.get('/health', (req, res) => {
  logStep('🔧 DEBUG: /health endpoint accessed')
  res.json({ status: 'ok' })
})

const PORT = process.env.PORT || 8000
logStep('🔧 DEBUG: Iniciando servidor en puerto:', PORT)
app.listen(PORT, () => {
  logStep(`Direct FHIR event forwarder listening on port ${PORT}`)
  logStep('🔧 DEBUG: Servidor iniciado exitosamente')
  logStep('🔧 DEBUG: Endpoints disponibles: POST /event, GET /health')
})
