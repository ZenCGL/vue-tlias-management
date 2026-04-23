import { ElMessage } from 'element-plus'
import * as echarts from 'echarts'

const RAW_WAVE_LIMIT = 512
const WAVE_SMOOTH_WINDOW = 5
const WAVE_DISPLAY_RANGE = 100
const EMOTION_TEXT = {
  normal: '正常',
  anxiety: '焦虑',
  stress: '紧张',
  fatigue: '疲劳',
  weakness: '虚弱'
}

export function createEegMonitor({ state, getBindingById, getDeviceLabel, evaluateWarning }) {
  const chartRefs = new Map()
  const chartInstances = new Map()
  const workerStreams = new Map()

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
    state.bindings.forEach((binding) => {
      if (binding.activeWorkerId === workerId) {
        binding.eegRunning = false
        binding.activeWorkerId = null
        if (binding.eegStatus !== 'idle') {
          binding.eegStatusText = '已断开'
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

  function ensureCharts(bindings) {
    bindings.forEach((binding) => ensureChart(binding))
  }

  function resizeCharts() {
    chartInstances.forEach((instance) => instance.resize())
  }

  return {
    setChartRef,
    startEeg,
    stopEeg,
    disposeChart,
    ensureCharts,
    resizeCharts
  }
}
