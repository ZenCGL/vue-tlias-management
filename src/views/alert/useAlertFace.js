import SockJS from 'sockjs-client/dist/sockjs.min.js'
import * as Stomp from 'stompjs'

const FACE_FATIGUE_USER_ID = 'camera_001'
const FACE_FATIGUE_WS_URL = '/wss'

function guessImageMime(base64) {
  if (base64.startsWith('/9j/')) return 'image/jpeg'
  if (base64.startsWith('iVBORw0KGgo')) return 'image/png'
  if (base64.startsWith('R0lGOD')) return 'image/gif'
  if (base64.startsWith('UklGR')) return 'image/webp'
  return 'image/jpeg'
}

function normalizeFaceImage(image) {
  if (typeof image !== 'string') return ''

  const trimmed = image.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('data:image/')) return trimmed
  if (/^(https?:|blob:|file:)/i.test(trimmed)) return trimmed

  const base64 = trimmed.replace(/\s+/g, '')
  if (!base64) return ''

  return `data:${guessImageMime(base64)};base64,${base64}`
}

export function createFaceMonitor({ state, getBindingById, evaluateWarning }) {
  let stompClient = null
  let stompSocket = null
  let stompConnected = false
  let reconnectTimer = null

  function ensureFaceConnection() {
    if (stompConnected || stompClient) return

    stompSocket = new SockJS(FACE_FATIGUE_WS_URL)
    stompClient = Stomp.over(stompSocket)
    stompClient.debug = () => {}
    stompClient.connect(
      {},
      () => {
        stompConnected = true
        state.bindings.forEach((binding) => subscribeFace(binding))
      },
      () => {
        stompConnected = false
        stompClient = null
        if (reconnectTimer) return
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null
          ensureFaceConnection()
        }, 1500)
      }
    )
  }

  function subscribeFace(binding) {
    if (!stompConnected || !stompClient || binding.faceSubscription) return
    binding.faceSubscription = stompClient.subscribe(`/topic/face_fatigue/${FACE_FATIGUE_USER_ID}`, (message) => {
      if (!message.body) return
      binding.faceConnected = true
      binding.faceStatusText = '识别中'

      let payload = {}
      try {
        payload = JSON.parse(message.body)
      } catch (error) {
        console.error('Failed to parse face fatigue payload:', error)
        return
      }
      console.info('Received face fatigue data for binding', binding.id, payload)
      binding.faceEmotion = payload.emotionCat || '未识别'
      binding.faceScore = payload.score || '--'
      binding.faceRate = payload.rate || '--'
      binding.faceRank = payload.fatigueRank == null ? null : Number(payload.fatigueRank)
      binding.faceStopRequired = binding.faceEmotion !== '其他' && binding.faceEmotion !== '未识别'

      binding.faceImageUrl = normalizeFaceImage(
        payload.image ?? payload.image_b64 ?? payload.imageBase64 ?? payload.base64Image
      )
      
      evaluateWarning(binding)
    })
  }

  function unsubscribeFace(bindingId) {
    const binding = getBindingById(bindingId)
    if (!binding?.faceSubscription) return
    binding.faceSubscription.unsubscribe()
    binding.faceSubscription = null
  }

  
  return {
    ensureFaceConnection,
    unsubscribeFace
  }
}
