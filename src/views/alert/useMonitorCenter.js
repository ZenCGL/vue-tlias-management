import { computed, nextTick, onBeforeUnmount, onMounted, reactive } from 'vue'
import { ElMessage } from 'element-plus'
import axios from 'axios'
import SockJS from 'sockjs-client/dist/sockjs.min.js'
import * as Stomp from 'stompjs'
import * as echarts from 'echarts'
import { queryPersonnelApi } from '@/api/personnel'

const DEVICE_OPTIONS = [{ label: '设备 1 / COM3', value: 1 }]
const RAW_WAVE_LIMIT = 512
const WAVE_SMOOTH_WINDOW = 5
const WAVE_DISPLAY_RANGE = 100

const PERSONNEL_FALLBACK = [
  { id: 'P001', uid: 'P001', name: '张三', type: '值班员' },
  { id: 'P002', uid: 'P002', name: '李四', type: '巡检员' },
  { id: 'P003', uid: 'P003', name: '王五', type: '监护员' }
]
const EMOTION_TEXT = {
  normal: '正常',
  anxiety: '焦虑',
  stress: '紧张',
  fatigue: '疲劳',
  weakness: '虚弱'
}

const state = reactive({
  initialized: false,
  bindings: [],
  personnelOptions: [],
  alertHistory: []
})

const chartRefs = new Map()
const chartInstances = new Map()
const workerStreams = new Map()

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
    activeWorkerId: null,
    faceChannelId: `face_${Date.now()}_${seed}`,
    eegRunning: false,
    eegStatus: 'idle',
    eegStatusText: '待接入',
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
    waveScale: 1,
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
  const delta = Number(rawPowers.delta || 0)
  const theta = Number(rawPowers.theta || 0)
  const alpha = Number(rawPowers.low_alpha || 0) + Number(rawPowers.high_alpha || 0)
  const beta = Number(rawPowers.low_beta || 0) + Number(rawPowers.high_beta || 0)
  const gamma = Number(rawPowers.low_gamma || 0) + Number(rawPowers.mid_gamma || 0)
  const total = delta + theta + alpha + beta + gamma

  if (!total) {
    return { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 }
  }

  return {
    delta: (delta / total) * 100,
    theta: (theta / total) * 100,
    alpha: (alpha / total) * 100,
    beta: (beta / total) * 100,
    gamma: (gamma / total) * 100
  }
}

function smoothWaveSamples(samples) {
  return samples.map((_, index) => {
    const start = Math.max(0, index - WAVE_SMOOTH_WINDOW + 1)
    const window = samples.slice(start, index + 1)
    const total = window.reduce((sum, value) => sum + value, 0)
    return total / window.length
  })
}

function normalizeWaveChunk(binding, rawWave = []) {
  const numericSamples = rawWave
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))

  if (!numericSamples.length) return []

  const smoothed = smoothWaveSamples(numericSamples)
  const mean = smoothed.reduce((sum, value) => sum + value, 0) / smoothed.length
  const centered = smoothed.map((value) => value - mean)
  const peak = centered.reduce((max, value) => Math.max(max, Math.abs(value)), 0)

  if (!peak) return centered.map(() => 0)

  binding.waveScale = binding.waveScale > 0 ? binding.waveScale * 0.82 + peak * 0.18 : peak
  const scale = Math.max(binding.waveScale, 1)

  return centered.map((value) => Number((Math.tanh((value / scale) * 1.6) * WAVE_DISPLAY_RANGE).toFixed(2)))
}

function setChartRef(bindingId) {
  return (el) => {
    if (!el) {
      disposeChart(bindingId)
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
  if (instance && instance.getDom() !== el) {
    instance.dispose()
    chartInstances.delete(binding.id)
    instance = null
  }
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
      min: -WAVE_DISPLAY_RANGE,
      max: WAVE_DISPLAY_RANGE,
      axisLine: { show: false },
      splitLine: { lineStyle: { color: '#e6eef2' } }
    },
    series: [
      {
        name: '脑电波形',
        type: 'line',
        showSymbol: false,
        smooth: true,
        sampling: 'lttb',
        animation: false,
        lineStyle: { width: 2 },
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
      min: -WAVE_DISPLAY_RANGE,
      max: WAVE_DISPLAY_RANGE
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
  const samples = normalizeWaveChunk(binding, rawWave)
  if (!samples.length) return
  binding.rawWaveBuffer.push(...samples)
  if (binding.rawWaveBuffer.length > RAW_WAVE_LIMIT) {
    binding.rawWaveBuffer.splice(0, binding.rawWaveBuffer.length - RAW_WAVE_LIMIT)
  }
}

function updateEegData(binding, payload) {
  binding.eegStatus = payload.status || 'ok'
  binding.analysisTime = payload.analysis_time || ''
  binding.emotion = payload.emotion || 'normal'
  binding.emotionZh = EMOTION_TEXT[binding.emotion] || payload.emotion_zh || '正常'
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
  } else {
    binding.eegStatusText = '在线'
  }

  refreshChart(binding)
  evaluateWarning(binding)
}

function resetWaveState(binding) {
  binding.rawWaveBuffer = []
  binding.waveScale = 1
  refreshChart(binding)
}

function getWorkerStream(workerId) {
  return workerStreams.get(workerId)
}

function setWorkerBindingsStopped(workerId) {
  state.bindings.forEach((item) => {
    if (item.activeWorkerId === workerId) {
      item.eegRunning = false
      item.activeWorkerId = null
      if (item.eegStatus !== 'idle') {
        item.eegStatusText = '已断开'
      }
    }
  })
}

async function openWorkerStream(workerId) {
  const controller = new AbortController()
  const streamState = {
    workerId,
    controller,
    bindingIds: new Set(),
    lastPayload: null
  }
  workerStreams.set(workerId, streamState)

  try {
    const response = await fetch(`/eeg/stream?workerId=${workerId}`, {
      method: 'GET',
      signal: controller.signal
    })

    if (!response.ok || !response.body) {
      throw new Error(`EEG stream error: ${response.status}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    while (true) {
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

        const payload = JSON.parse(jsonText)
        streamState.lastPayload = payload
        streamState.bindingIds.forEach((bindingId) => {
          const binding = getBindingById(bindingId)
          if (binding?.eegRunning) {
            updateEegData(binding, payload)
          }
        })
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      streamState.bindingIds.forEach((bindingId) => {
        const binding = getBindingById(bindingId)
        if (!binding) return
        binding.eegRunning = false
        binding.activeWorkerId = null
        binding.eegStatus = 'error'
        binding.eegStatusText = '连接失败'
      })
      ElMessage.error(`${getDeviceLabel(workerId)} 脑电接入失败`)
    }
  } finally {
    if (workerStreams.get(workerId) === streamState) {
      workerStreams.delete(workerId)
    }
    setWorkerBindingsStopped(workerId)
  }
}

function subscribeBindingToWorker(binding) {
  let streamState = getWorkerStream(binding.workerId)
  if (!streamState) {
    void openWorkerStream(binding.workerId)
    streamState = getWorkerStream(binding.workerId)
  }
  binding.activeWorkerId = binding.workerId
  binding.eegRunning = true
  streamState?.bindingIds.add(binding.id)
  if (streamState?.lastPayload) {
    updateEegData(binding, streamState.lastPayload)
  }
}

function unsubscribeBindingFromWorker(binding) {
  const targetWorkerId = binding.activeWorkerId ?? binding.workerId
  const streamState = getWorkerStream(targetWorkerId)
  binding.activeWorkerId = null
  if (!streamState) return
  streamState.bindingIds.delete(binding.id)
  if (streamState.bindingIds.size === 0) {
    streamState.controller.abort()
    workerStreams.delete(targetWorkerId)
  }
}

function startEeg(binding) {
  if (!binding.personId) {
    ElMessage.warning('请先选择人员')
    return
  }

  if (binding.eegRunning && binding.activeWorkerId === binding.workerId) {
    binding.eegStatus = 'ok'
    binding.eegStatusText = '在线'
    refreshChart(binding)
    return
  }

  stopEeg(binding.id)
  updateBindingPerson(binding)
  binding.eegStatus = 'connecting'
  binding.eegStatusText = '连接中'
  if (!binding.rawWaveBuffer.length) {
    resetWaveState(binding)
  } else {
    refreshChart(binding)
  }
  subscribeBindingToWorker(binding)
}

function stopEeg(bindingId) {
  const binding = getBindingById(bindingId)
  if (!binding) return
  unsubscribeBindingFromWorker(binding)
  binding.eegRunning = false
  if (binding.eegStatus !== 'idle') {
    binding.eegStatusText = '已断开'
  }
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
  if (binding.emotion === 'normal') return 'success'
  if (binding.emotion === 'fatigue' || binding.emotion === 'weakness') return 'error'
  return 'warning'
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
    formatIndex
  }
}
