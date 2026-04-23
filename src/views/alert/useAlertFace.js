import { ElMessage } from 'element-plus'
import axios from 'axios'
import SockJS from 'sockjs-client/dist/sockjs.min.js'
import * as Stomp from 'stompjs'

export function createFaceMonitor({ state, getBindingById, updateBindingPerson, evaluateWarning }) {
  let stompClient = null
  let stompSocket = null
  let stompConnected = false
  let reconnectTimer = null

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

  return {
    ensureFaceConnection,
    unsubscribeFace,
    beforeVideoUpload,
    uploadFaceVideo
  }
}
