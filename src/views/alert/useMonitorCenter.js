import { computed, nextTick, onBeforeUnmount, onMounted, reactive } from 'vue'
import { ElMessage } from 'element-plus'
import axios from 'axios'
import SockJS from 'sockjs-client/dist/sockjs.min.js'
import * as Stomp from 'stompjs'
import * as echarts from 'echarts'
import { queryPersonnelApi } from '@/api/personnel'

const DEVICE_OPTIONS = [{ label: '设备 1 / COM3', value: 1 }]
const RAW_WAVE_LIMIT = 512

const PERSONNEL_FALLBACK = [
  { id: 'P001', uid: 'P001', name: '张三', type: '值班员' },
  { id: 'P002', uid: 'P002', name: '李四', type: '巡检员' },
  { id: 'P003', uid: 'P003', name: '王五', type: '监护员' }
]

const state = reactive({
  initialized: false,
  bindings: [],
  personnelOptions: [],
  alertHistory: []
})

const chartRefs = new Map()
const chartInstances = new Map()
const streamControllers = new Map()

let stompClient = null
let stompSocket = null
let stompConnected = false
let reconnectTimer = null

function createBinding(seed = 1) {
  return reactive({
    id: `binding-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    personId: '',
    personName: '',
    personType: '',
    workerId: DEVICE_OPTIONS[(seed - 1) % DEVICE_OPTIONS.length].value,
    faceChannelId: `face_${Date.now()}_${seed}`,
    eegRunning: false,
    eegStatus: 'idle',
    eegStatusText: '待接入',
    signalQuality: 0,
    emotion: 'normal',
    emotionZh: '正常',
    analysisTime: '',
    calibrationProgress: 0,
    indices: {
      anxiety_idx: 0,
      stress_idx: 0,
      fatigue_idx: 0,
      weakness_idx: 0
    },
    probs: {},
    bandSnapshot: {
      delta: 0,
      theta: 0,
      alpha: 0,
      beta: 0,
      gamma: 0
    },
    rawWaveBuffer: [],
    faceConnected: false,
    faceStatusText: '待上传',
    faceEmotion: '未识别',
    faceScore: '--',
    faceRate: '--',
    faceRank: null,
    faceStopRequired: false,
    videoUploading: false,
    uploadPercent: 0,
    localVideoUrl: '',
    videoWidth: 0,
    videoHeight: 0,
    latestWarningLevel: 'info',
    latestEmotion: 'normal',
    faceSubscription: null
  })
}

async function loadPersonnel() {
  try {
    const res = await queryPersonnelApi({ page: 1, pageSize: 100 })
    if (res?.code && Array.isArray(res?.data?.rows) && res.data.rows.length) {
      state.personnelOptions = res.data.rows.map((item) => ({
        id: item.id || item.uid,
        uid: item.uid,
        name: item.name,
        type: item.type || '未分类'
      }))
      return
    }
  } catch (error) {
    console.warn('loadPersonnel failed', error)
  }
  state.personnelOptions = PERSONNEL_FALLBACK
}

async function initMonitorCenter() {
  if (state.initialized) return
  state.bindings = [createBinding(1), createBinding(2)]
  await loadPersonnel()
  ensureFaceConnection()
  state.initialized = true
}

function addBinding() {
  if (state.bindings.length >= 4) {
    ElMessage.warning('最多支持 4 个设备卡片')
    return
  }
  state.bindings.push(createBinding(state.bindings.length + 1))
}

function removeBinding(bindingId) {
  stopEeg(bindingId)
  unsubscribeFace(bindingId)
  disposeChart(bindingId)
  const index = state.bindings.findIndex((item) => item.id === bindingId)
  if (index === -1) return
  const binding = state.bindings[index]
  if (binding.localVideoUrl) {
    URL.revokeObjectURL(binding.localVideoUrl)
  }
  state.bindings.splice(index, 1)
}

function updateBindingPerson(binding) {
  const selected = state.personnelOptions.find((item) => item.id === binding.personId || item.uid === binding.personId)
  binding.personName = selected?.name || ''
  binding.personType = selected?.type || ''
}

function getBindingById(bindingId) {
  return state.bindings.find((item) => item.id === bindingId)
}

function getDeviceLabel(workerId) {
  return DEVICE_OPTIONS.find((item) => item.value === workerId)?.label || `设备 ${workerId}`
}

function formatShortTime(value) {
  const date = value ? new Date(value) : new Date()
  if (Number.isNaN(date.getTime())) return '--:--:--'
  return date.toLocaleTimeString('zh-CN', { hour12: false })
}

function getBandSnapshot(rawPowers = {}) {
  return {
    delta: Number(rawPowers.delta || 0),
    theta: Number(rawPowers.theta || 0),
    alpha: Number(rawPowers.low_alpha || 0) + Number(rawPowers.high_alpha || 0),
    beta: Number(rawPowers.low_beta || 0) + Number(rawPowers.high_beta || 0),
    gamma: Number(rawPowers.low_gamma || 0) + Number(rawPowers.mid_gamma || 0)
  }
}

function setChartRef(bindingId) {
  return (el) => {
    if (!el) {
      chartRefs.delete(bindingId)
      return
    }
    chartRefs.set(bindingId, el)
    const binding = getBindingById(bindingId)
    if (binding) ensureChart(binding)
  }
}

function ensureChart(binding) {
  const el = chartRefs.get(binding.id)
  if (!el) return

  let instance = chartInstances.get(binding.id)
  if (!instance) {
    instance = echarts.init(el)
    chartInstances.set(binding.id, instance)
  }

  instance.setOption({
    color: ['#0f766e'],
    tooltip: { trigger: 'axis' },
    grid: { left: 40, right: 20, top: 24, bottom: 28 },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      axisLine: { lineStyle: { color: '#9db4c0' } },
      data: binding.rawWaveBuffer.map((_, index) => index)
    },
    yAxis: {
      type: 'value',
      min: 'dataMin',
      max: 'dataMax',
      axisLine: { show: false },
      splitLine: { lineStyle: { color: '#e6eef2' } }
    },
    series: [
      {
        name: '脑电波形',
        type: 'line',
        showSymbol: false,
        smooth: false,
        sampling: 'lttb',
        animation: false,
        lineStyle: { width: 1.4 },
        data: [...binding.rawWaveBuffer]
      }
    ]
  })
  instance.resize()
}

function refreshChart(binding) {
  const instance = chartInstances.get(binding.id)
  if (!instance) {
    ensureChart(binding)
    return
  }

  instance.setOption({
    xAxis: { data: binding.rawWaveBuffer.map((_, index) => index) },
    yAxis: {
      min: 'dataMin',
      max: 'dataMax'
    },
    series: [{ data: [...binding.rawWaveBuffer] }]
  })
  instance.resize()
}

function disposeChart(bindingId) {
  const instance = chartInstances.get(bindingId)
  if (!instance) return
  instance.dispose()
  chartInstances.delete(bindingId)
}

function appendRawWave(binding, rawWave = []) {
  if (!Array.isArray(rawWave) || rawWave.length === 0) return
  const samples = rawWave
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
  if (!samples.length) return
  binding.rawWaveBuffer.push(...samples)
  if (binding.rawWaveBuffer.length > RAW_WAVE_LIMIT) {
    binding.rawWaveBuffer.splice(0, binding.rawWaveBuffer.length - RAW_WAVE_LIMIT)
  }
}

function updateEegData(binding, payload) {
  binding.eegStatus = payload.status || 'ok'
  binding.signalQuality = Number(payload.signal_quality || 0)
  binding.analysisTime = payload.analysis_time || ''
  binding.emotion = payload.emotion || 'normal'
  binding.emotionZh = payload.emotion_zh || '正常'
  binding.indices = {
    anxiety_idx: Number(payload.indices?.anxiety_idx || 0),
    stress_idx: Number(payload.indices?.stress_idx || 0),
    fatigue_idx: Number(payload.indices?.fatigue_idx || 0),
    weakness_idx: Number(payload.indices?.weakness_idx || 0)
  }
  binding.probs = payload.probs || {}
  binding.calibrationProgress = Number(payload.calibration_progress || 0)
  binding.bandSnapshot = getBandSnapshot(payload.raw_powers)
  appendRawWave(binding, payload.raw_wave)

  if (payload.status === 'calibrating') {
    binding.eegStatusText = `基线校准 ${Math.round(binding.calibrationProgress * 100)}%`
  } else if (payload.status === 'bad_signal') {
    binding.eegStatusText = '信号较差'
  } else {
    binding.eegStatusText = '在线'
  }

  refreshChart(binding)
  evaluateWarning(binding)
}

async function startEeg(binding) {
  if (!binding.personId) {
    ElMessage.warning('请先选择人员')
    return
  }

  stopEeg(binding.id)
  updateBindingPerson(binding)

  const controller = new AbortController()
  streamControllers.set(binding.id, controller)
  binding.eegRunning = true
  binding.eegStatus = 'connecting'
  binding.eegStatusText = '连接中'
  binding.rawWaveBuffer = []
  refreshChart(binding)

  try {
    const response = await fetch(`/eeg/stream?workerId=${binding.workerId}`, {
      method: 'GET',
      signal: controller.signal
    })

    if (!response.ok || !response.body) {
      throw new Error(`EEG stream error: ${response.status}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    while (binding.eegRunning) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      while (buffer.includes('\n\n')) {
        const splitIndex = buffer.indexOf('\n\n')
        const block = buffer.slice(0, splitIndex)
        buffer = buffer.slice(splitIndex + 2)
        const lines = block
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
        const dataLine = lines.find((line) => line.startsWith('data:'))
        if (!dataLine) continue
        const jsonText = dataLine.slice(5).trim()
        if (!jsonText) continue
        updateEegData(binding, JSON.parse(jsonText))
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      binding.eegStatus = 'error'
      binding.eegStatusText = '连接失败'
      ElMessage.error(`${binding.personName || '当前设备'} 脑电接入失败`)
    }
  } finally {
    if (streamControllers.get(binding.id) === controller) {
      streamControllers.delete(binding.id)
    }
    binding.eegRunning = false
  }
}

function stopEeg(bindingId) {
  const binding = getBindingById(bindingId)
  if (!binding) return
  binding.eegRunning = false
  if (binding.eegStatus !== 'idle') {
    binding.eegStatusText = '已断开'
  }
  const controller = streamControllers.get(bindingId)
  if (!controller) return
  controller.abort()
  streamControllers.delete(bindingId)
}

function ensureFaceConnection() {
  if (stompConnected || stompClient) return

  stompSocket = new SockJS('/wss')
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
  binding.faceSubscription = stompClient.subscribe(`/topic/face_fatigue/${binding.faceChannelId}`, (message) => {
    if (!message.body) return
    const payload = JSON.parse(message.body)
    binding.faceConnected = true
    binding.faceStatusText = '识别中'
    binding.faceEmotion = payload.emotionCat || '未识别'
    binding.faceScore = payload.score || '--'
    binding.faceRate = payload.rate || '--'
    binding.faceRank = payload.fatigueRank == null ? null : Number(payload.fatigueRank)
    binding.faceStopRequired = binding.faceEmotion !== '其他' && binding.faceEmotion !== '未识别'
    evaluateWarning(binding)
  })
}

function unsubscribeFace(bindingId) {
  const binding = getBindingById(bindingId)
  if (!binding?.faceSubscription) return
  binding.faceSubscription.unsubscribe()
  binding.faceSubscription = null
}

function updateVideoMeta(binding) {
  if (!binding.localVideoUrl) return
  const video = document.createElement('video')
  video.src = binding.localVideoUrl
  video.onloadedmetadata = () => {
    binding.videoWidth = video.videoWidth
    binding.videoHeight = video.videoHeight
  }
}

function beforeVideoUpload(binding, file) {
  const allowedTypes = ['video/mp4', 'video/ogg', 'video/flv', 'video/avi', 'video/wmv', 'video/x-msvideo']
  if (!allowedTypes.includes(file.type)) {
    ElMessage.error('请上传常见视频格式')
    return false
  }

  if (binding.localVideoUrl) {
    URL.revokeObjectURL(binding.localVideoUrl)
  }
  binding.localVideoUrl = URL.createObjectURL(file)
  updateVideoMeta(binding)
  return true
}

async function uploadFaceVideo(binding, options) {
  ensureFaceConnection()
  subscribeFace(binding)
  updateBindingPerson(binding)

  binding.videoUploading = true
  binding.uploadPercent = 0
  binding.faceStatusText = '上传中'

  const formData = new FormData()
  formData.append('file', options.file)
  formData.append('userId', binding.faceChannelId)

  try {
    const response = await axios.post('/faceDetectService/video_upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (event) => {
        if (!event.total) return
        binding.uploadPercent = Math.floor((event.loaded / event.total) * 100)
      }
    })

    if (response?.data?.code === 0) {
      binding.faceStatusText = '等待识别结果'
      options.onSuccess?.(response.data)
      return
    }

    throw new Error(response?.data?.msg || '上传失败')
  } catch (error) {
    binding.faceStatusText = '上传失败'
    options.onError?.(error)
    ElMessage.error(`${binding.personName || '当前设备'} 微表情视频上传失败`)
  } finally {
    binding.videoUploading = false
    binding.uploadPercent = 0
  }
}

function getWarningLevel(binding) {
  return binding.emotion === 'normal' ? 'info' : 'warning'
}

function getWarningText(binding) {
  if (binding.eegStatus === 'calibrating') return '脑电正在基线校准，暂不输出最终预警'
  if (binding.eegStatus === 'bad_signal') return '脑电信号较差，请检查设备佩戴状态'
  if (binding.emotion === 'anxiety') return '预警：当前状态为焦虑'
  if (binding.emotion === 'stress') return '预警：当前状态为紧张'
  if (binding.emotion === 'fatigue') return '预警：当前状态为疲劳'
  if (binding.emotion === 'weakness') return '预警：当前状态为虚弱'
  return '预警：当前状态正常'
}

function evaluateWarning(binding) {
  const level = getWarningLevel(binding)
  if (binding.latestWarningLevel !== level || binding.emotion !== binding.latestEmotion) {
    state.alertHistory.unshift({
      id: `${binding.id}-${Date.now()}`,
      personName: binding.personName || '未绑定人员',
      device: getDeviceLabel(binding.workerId),
      level,
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
      message: getWarningText(binding)
    })
    if (state.alertHistory.length > 12) {
      state.alertHistory.length = 12
    }
  }
  binding.latestWarningLevel = level
  binding.latestEmotion = binding.emotion
}

function getAlertType(binding) {
  if (binding.eegStatus === 'bad_signal') return 'warning'
  if (binding.emotion === 'normal') return 'success'
  if (binding.emotion === 'fatigue' || binding.emotion === 'weakness') return 'error'
  return 'warning'
}

function formatPercent(value) {
  return `${Math.round(Number(value || 0))}%`
}

function formatIndex(value) {
  return Number(value || 0).toFixed(1)
}

function resizeHandler() {
  chartInstances.forEach((instance) => instance.resize())
}

function useMonitorCenterPage() {
  onMounted(async () => {
    await initMonitorCenter()
    await nextTick()
    state.bindings.forEach((binding) => ensureChart(binding))
    window.addEventListener('resize', resizeHandler)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('resize', resizeHandler)
  })
}

const overview = computed(() => ({
  total: state.bindings.length,
  onlineCount: state.bindings.filter((item) => item.eegRunning || item.faceConnected).length,
  warningCount: state.bindings.filter((item) => getWarningLevel(item) === 'warning').length,
  dangerCount: state.bindings.filter((item) => item.emotion !== 'normal').length
}))

export function useMonitorCenter() {
  return {
    state,
    DEVICE_OPTIONS,
    overview,
    initMonitorCenter,
    useMonitorCenterPage,
    addBinding,
    removeBinding,
    updateBindingPerson,
    getBindingById,
    getDeviceLabel,
    formatShortTime,
    setChartRef,
    startEeg,
    stopEeg,
    beforeVideoUpload,
    uploadFaceVideo,
    getWarningLevel,
    getWarningText,
    getAlertType,
    formatPercent,
    formatIndex
  }
}
