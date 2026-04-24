import { computed, nextTick, onBeforeUnmount, onMounted, reactive } from 'vue'
import { ElMessage } from 'element-plus'
import { queryPersonnelApi } from '@/api/personnel'
import { createEegMonitor } from './useAlertEeg'
import { createFaceMonitor } from './useAlertFace'

const DEVICE_OPTIONS = [{ label: '设备 1 / COM3', value: 1 }]
const FACE_FATIGUE_USER_ID = 'camera_001'

const PERSONNEL_FALLBACK = [
  { id: 'P001', uid: 'P0010138', name: '张海威', type: '值班员' },
  { id: 'P002', uid: 'P0023215', name: '郭凌刚', type: '巡检员' },
  { id: 'P003', uid: 'P003', name: '王五', type: '监护员' }
]

const state = reactive({
  initialized: false,
  bindings: [],
  personnelOptions: [],
  alertHistory: []
})

function createBinding(seed = 1) {
  return reactive({
    id: `binding-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    personId: '',
    personName: '',
    personType: '',
    workerId: DEVICE_OPTIONS[(seed - 1) % DEVICE_OPTIONS.length].value,
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
  return DEVICE_OPTIONS.find((item) => item.value === workerId)?.label || `设备 ${workerId}`
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
  faceMonitor.ensureFaceConnection()
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
    updateBindingPerson,
    getBindingById,
    getDeviceLabel,
    formatShortTime,
    setChartRef: eegMonitor.setChartRef,
    startEeg: eegMonitor.startEeg,
    stopEeg: eegMonitor.stopEeg,
    beforeVideoUpload: faceMonitor.beforeVideoUpload,
    uploadFaceVideo: faceMonitor.uploadFaceVideo,
    getWarningLevel,
    getWarningText,
    getAlertType,
    formatIndex
  }
}
