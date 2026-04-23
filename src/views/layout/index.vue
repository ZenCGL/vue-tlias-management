<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Monitor, EditPen, SwitchButton } from '@element-plus/icons-vue'
import { useRoute, useRouter } from 'vue-router'

const router = useRouter()
const route = useRoute()

const loginName = ref('')

const activeMenu = computed(() => {
  return route.path.startsWith('/alert') ? '/alert' : '/alert'
})

onMounted(() => {
  const loginUser = JSON.parse(localStorage.getItem('loginUser') || 'null')
  if (loginUser?.name) {
    loginName.value = loginUser.name
  }
})

function openChangePwd() {
  ElMessage.info('当前界面已精简，如需保留修改密码功能可再接回原接口')
}

function logout() {
  ElMessageBox.confirm('确认退出登录吗？', '提示', {
    confirmButtonText: '确认',
    cancelButtonText: '取消',
    type: 'warning'
  })
    .then(() => {
      localStorage.removeItem('loginUser')
      localStorage.removeItem('token')
      ElMessage.success('已退出登录')
      router.push('/login')
    })
    .catch(() => {})
}
</script>

<template>
  <div class="layout-page">
    <el-container class="layout-shell">
      <el-aside class="sidebar" width="240px">
        <div class="brand-block">
          <div class="brand-mark">EEG</div>
          <div class="brand-copy">
            <strong>综合监测平台</strong>
            <span>脑电 · 微表情 · 预警</span>
          </div>
        </div>

        <el-menu :default-active="activeMenu" router class="nav-menu">
          <el-menu-item index="/alert" class="nav-item">
            <el-icon><Monitor /></el-icon>
            <span>综合监测主界面</span>
          </el-menu-item>
        </el-menu>

        <div class="sidebar-footer">
          <div class="user-card">
            <span>当前用户</span>
            <strong>{{ loginName || '未命名用户' }}</strong>
          </div>
        </div>
      </el-aside>

      <el-container>
        <el-header class="topbar">
          <div class="page-title">
            <h1>脑电与微表情综合监测</h1>
          </div>

          <div class="topbar-actions">
            <el-button plain @click="openChangePwd">
              <el-icon><EditPen /></el-icon>
              修改密码
            </el-button>
            <el-button type="danger" plain @click="logout">
              <el-icon><SwitchButton /></el-icon>
              退出登录
            </el-button>
          </div>
        </el-header>

        <el-main class="main-panel">
          <router-view />
        </el-main>
      </el-container>
    </el-container>
  </div>
</template>

<style scoped>
.layout-page {
  min-height: 100vh;
  background: linear-gradient(180deg, #f1f7fb 0%, #edf3f7 100%);
}

.layout-shell {
  min-height: 100vh;
}

.sidebar {
  display: flex;
  flex-direction: column;
  padding: 22px 18px;
  background: linear-gradient(180deg, #0f3d56 0%, #173f57 55%, #234a63 100%);
  color: #fff;
  box-shadow: 10px 0 30px rgba(15, 61, 86, 0.14);
}

.brand-block {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 6px 22px;
}

.brand-mark {
  width: 52px;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 16px;
  background: linear-gradient(135deg, #7dd3fc 0%, #bae6fd 100%);
  color: #0f3d56;
  font-weight: 800;
  letter-spacing: 0.08em;
}

.brand-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.brand-copy strong {
  font-size: 18px;
}

.brand-copy span {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
}

.nav-menu {
  border: none;
  background: transparent;
}

.nav-menu :deep(.el-menu-item) {
  margin-bottom: 10px;
  border-radius: 14px;
  color: rgba(255, 255, 255, 0.78);
}

.nav-menu :deep(.el-menu-item:hover) {
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
}

.nav-menu :deep(.el-menu-item.is-active) {
  background: linear-gradient(135deg, rgba(125, 211, 252, 0.2), rgba(255, 255, 255, 0.12));
  color: #fff;
}

.sidebar-footer {
  margin-top: auto;
  padding-top: 20px;
}

.user-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.08);
}

.user-card span {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.68);
}

.user-card strong {
  font-size: 16px;
}

.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 20px 28px;
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(14px);
  border-bottom: 1px solid #e2ebf0;
}

.page-title h1 {
  margin: 0;
  font-size: 28px;
  color: #17384d;
}

.page-title p {
  margin: 6px 0 0;
  color: #6b7f8f;
}

.topbar-actions {
  display: flex;
  gap: 12px;
}

.main-panel {
  padding: 0;
}

@media (max-width: 960px) {
  .layout-shell {
    flex-direction: column;
  }

  .sidebar {
    width: 100% !important;
    padding: 16px;
  }

  .topbar {
    flex-direction: column;
    align-items: flex-start;
  }

  .topbar-actions {
    width: 100%;
    flex-wrap: wrap;
  }
}
</style>
