import { computed, nextTick, onBeforeUnmount, onMounted, reactive } from 'vue'
import { ElMessage } from 'element-plus'
import { createEegMonitor } from './useAlertEeg'
import { createFaceMonitor } from './useAlertFace'

const PERSONNEL_STORAGE_KEY = 'alert-personnel-options'
const DEVICE_STORAGE_KEY = 'alert-device-options'
const FACE_FATIGUE_USER_ID = 'camera_001'

const DEFAULT_PERSONNEL = [
  { id: 'P001', uid: 'P001', name: 'P001', type: '值班员' },
  { id: 'P002', uid: 'P002', name: 'P002', type: '巡检员' },
  { id: 'P003', uid: 'P003', name: 'P003', type: '监护员' }
]

const DEFAULT_DEVICES = [
  { value: 1, name: '设备 1', port: 'COM3' },
  { value: 2, name: '设备 2', port: 'COM4' },
  { value: 3, name: '设备 3', port: 'COM5' }
]

const DEVICE_OPTIONS = reactive([])

const state = reactive({
  initialized: false,
  bindings: [],
  personnelOptions: [],
  alertHistory: []
})

function readLocalList(storageKey, fallback = []) {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return [...fallback]
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : [...fallback]
  } catch (error) {
    console.warn(`Failed to read ${storageKey}`, error)
    return [...fallback]
  }
}

function writeLocalList(storageKey, value) {
  localStorage.setItem(storageKey, JSON.stringify(value))
}

function replaceArray(target, values) {
  target.splice(0, target.length, ...values)
}

function normalizePersonnel(item, index = 0) {
  const uid = String(item.uid || item.id || `P${String(index + 1).padStart(3, '0')}`)
  return {
    id: String(item.id || uid),
    uid,
    name: String(item.name || `人员 ${index + 1}`),
    type: String(item.type || '未分类')
  }
}

function normalizeDevice(item, index = 0) {
  const value = Number(item.value ?? item.workerId ?? index + 1)
  const name = String(item.name || `设备 ${value}`)
  const port = String(item.port || '')
  return {
    value,
    name,
    port,
    label: port ? `${name} / ${port}` : name
  }
}

function loadPersonnel() {
  const stored = readLocalList(PERSONNEL_STORAGE_KEY, [])
  const source = stored.length ? stored : DEFAULT_PERSONNEL
  const items = source.map(normalizePersonnel)
  replaceArray(state.personnelOptions, items)
  if (!stored.length) {
    persistPersonnel()
  }
}

function loadDevices() {
  const stored = readLocalList(DEVICE_STORAGE_KEY, [])
  const source = stored.length ? stored : DEFAULT_DEVICES
  const items = source.map(normalizeDevice)
  replaceArray(DEVICE_OPTIONS, items)
  if (!stored.length) {
    persistDevices()
  }
}

function persistPersonnel() {
  writeLocalList(
    PERSONNEL_STORAGE_KEY,
    state.personnelOptions.map(({ id, uid, name, type }) => ({ id, uid, name, type }))
  )
}

function persistDevices() {
  writeLocalList(
    DEVICE_STORAGE_KEY,
    DEVICE_OPTIONS.map(({ value, name, port }) => ({ value, name, port }))
  )
}

function createBinding(seed = 1) {
  const defaultWorkerId = DEVICE_OPTIONS[(seed - 1) % Math.max(DEVICE_OPTIONS.length, 1)]?.value ?? null
  return reactive({
    id: `binding-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    personId: '',
    personName: '',
    personType: '',
    workerId: defaultWorkerId,
    activeWorkerId: null,
    faceChannelId: FACE_FATIGUE_USER_ID,
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
    faceImageUrl: '',
    faceStatusText: '待接入',
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

function getBindingById(bindingId) {
  return state.bindings.find((item) => item.id === bindingId)
}

function getDeviceLabel(workerId) {
  return DEVICE_OPTIONS.find((item) => item.value === workerId)?.label || '未配置设备'
}

function updateBindingPerson(binding) {
  const selected = state.personnelOptions.find((item) => item.id === binding.personId || item.uid === binding.personId)
  binding.personName = selected?.name || ''
  binding.personType = selected?.type || ''
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

const eegMonitor = createEegMonitor({
  state,
  getBindingById,
  getDeviceLabel,
  evaluateWarning
})

const faceMonitor = createFaceMonitor({
  state,
  getBindingById,
  updateBindingPerson,
  evaluateWarning
})

function syncBindingsWithDevices() {
  const fallbackWorkerId = DEVICE_OPTIONS[0]?.value ?? null
  state.bindings.forEach((binding) => {
    if (!DEVICE_OPTIONS.some((item) => item.value === binding.workerId)) {
      eegMonitor.stopEeg(binding.id)
      binding.workerId = fallbackWorkerId
      binding.activeWorkerId = null
    }
  })
}

function syncBindingsWithPersonnel() {
  state.bindings.forEach((binding) => {
    if (!state.personnelOptions.some((item) => item.id === binding.personId || item.uid === binding.personId)) {
      binding.personId = ''
      binding.personName = ''
      binding.personType = ''
      return
    }
    updateBindingPerson(binding)
  })
}

async function initMonitorCenter() {
  if (state.initialized) return
  loadPersonnel()
  loadDevices()
  state.bindings = []
  faceMonitor.ensureFaceConnection()
  state.initialized = true
}

function addBinding() {
  if (state.bindings.length >= 4) {
    ElMessage.warning('最多支持 4 个设备卡片')
    return
  }
  const binding = createBinding(state.bindings.length + 1)
  state.bindings.push(binding)
  faceMonitor.subscribeFace(binding)
}

function removeBinding(bindingId) {
  eegMonitor.stopEeg(bindingId)
  faceMonitor.unsubscribeFace(bindingId)
  eegMonitor.disposeChart(bindingId)
  const index = state.bindings.findIndex((item) => item.id === bindingId)
  if (index === -1) return
  const binding = state.bindings[index]
  if (binding.localVideoUrl) {
    URL.revokeObjectURL(binding.localVideoUrl)
  }
  state.bindings.splice(index, 1)
}

function addPersonnel(record) {
  const normalized = normalizePersonnel({
    id: `person-${Date.now()}`,
    uid: record.uid,
    name: record.name,
    type: record.type
  }, state.personnelOptions.length)
  state.personnelOptions.push(normalized)
  persistPersonnel()
}

function updatePersonnel(record) {
  const index = state.personnelOptions.findIndex((item) => item.id === record.id)
  if (index === -1) return
  state.personnelOptions[index] = normalizePersonnel(record, index)
  persistPersonnel()
  syncBindingsWithPersonnel()
}

function removePersonnel(personId) {
  const index = state.personnelOptions.findIndex((item) => item.id === personId)
  if (index === -1) return
  state.personnelOptions.splice(index, 1)
  persistPersonnel()
  syncBindingsWithPersonnel()
}

function getNextDeviceValue() {
  return DEVICE_OPTIONS.reduce((max, item) => Math.max(max, Number(item.value || 0)), 0) + 1
}

function addDevice(record) {
  const normalized = normalizeDevice({
    value: getNextDeviceValue(),
    name: record.name,
    port: record.port
  }, DEVICE_OPTIONS.length)
  DEVICE_OPTIONS.push(normalized)
  persistDevices()
  state.bindings.forEach((binding) => {
    if (binding.workerId == null) {
      binding.workerId = normalized.value
    }
  })
}

function updateDevice(record) {
  const index = DEVICE_OPTIONS.findIndex((item) => item.value === Number(record.value))
  if (index === -1) return
  DEVICE_OPTIONS[index] = normalizeDevice(record, index)
  persistDevices()
}

function removeDevice(deviceValue) {
  const index = DEVICE_OPTIONS.findIndex((item) => item.value === Number(deviceValue))
  if (index === -1) return
  DEVICE_OPTIONS.splice(index, 1)
  persistDevices()
  syncBindingsWithDevices()
}

function formatShortTime(value) {
  const date = value ? new Date(value) : new Date()
  if (Number.isNaN(date.getTime())) return '--:--:--'
  return date.toLocaleTimeString('zh-CN', { hour12: false })
}

function getAlertType(binding) {
  if (binding.emotion === 'normal') return 'success'
  if (binding.emotion === 'fatigue' || binding.emotion === 'weakness') return 'error'
  return 'warning'
}

function formatIndex(value) {
  return Number(value || 0).toFixed(1)
}

function refreshFaceSubscription(bindingId) {
  faceMonitor.refreshFaceSubscription(bindingId)
}

function useMonitorCenterPage() {
  onMounted(async () => {
    await initMonitorCenter()
    await nextTick()
    eegMonitor.ensureCharts(state.bindings)
    window.addEventListener('resize', eegMonitor.resizeCharts)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('resize', eegMonitor.resizeCharts)
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
    addPersonnel,
    updatePersonnel,
    removePersonnel,
    addDevice,
    updateDevice,
    removeDevice,
    updateBindingPerson,
    getBindingById,
    getDeviceLabel,
    formatShortTime,
    setChartRef: eegMonitor.setChartRef,
    setBandChartRef: eegMonitor.setBandChartRef,
    startEeg: eegMonitor.startEeg,
    stopEeg: eegMonitor.stopEeg,
    refreshFaceSubscription,
    getWarningLevel,
    getWarningText,
    getAlertType,
    formatIndex
  }
}
